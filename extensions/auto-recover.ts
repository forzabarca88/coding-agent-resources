/**
 * Auto-Recover Extension
 *
 * Detects when an agent run ends with an *unexecuted trailing tool call*
 * and automatically sends a user message prompting the model to continue.
 *
 * Strict trigger conditions — recovery ONLY fires when BOTH hold:
 *
 *   a) The last message ended the agent run and control is about to
 *      transition back to the user turn. This is detected via the
 *      `agent_settled` event — unlike `agent_end`, Pi fires it only when
 *      no auto-retry / compaction / follow-up handling remains, so the
 *      next step really is a transition to the user turn.
 *
 *   b) The END of the last message was a tool call. Either the last
 *      content part is a structured `toolCall` that was never executed, or
 *      the final text/thinking literally ENDS with a leaked tool-call tag
 *      (e.g. Gemma's `...}<tool_call|>`, or an XML leak ending in
 *      `</tool_call>`). Messages that merely quote tool-call syntax and
 *      end in normal prose never trigger.
 *
 * Place in ~/.pi/agent/extensions/ for global use, or .pi/extensions/ for
 * project-local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Maximum consecutive runs ending in an unexecuted tool call before giving up
const MAX_CONSECUTIVE = 3;

// Tag used by models to terminate a leaked/malformed tool call at the very
// end of a message. Matches Gemma's `<tool_call|>` / `<|tool_call|>` and XML
// leaks like `</tool_call>` / `</tool>` / `</function>`.
const TRAILING_TOOL_CALL_TAG = /<\/?\|?(?:function|tool|tool_call)\b[^>]*>$/i;

// Message sent to the model when auto-recovery triggers
const RECOVERY_MESSAGE =
	"You sent an invalid tool call, continue more carefully.";

export default function (pi: ExtensionAPI) {
	let consecutiveRecoveries = 0;

	pi.on("agent_settled", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();

		// ------------------------------------------------------------------
		// (a) The run is over and Pi will not continue automatically —
		//     agent_settled already guarantees the transition to the user
		//     turn. Now find the last assistant message of the run.
		// ------------------------------------------------------------------
		let lastAssistantEntry = null;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "message" &&
				(entry.message as { role?: string })?.role === "assistant"
			) {
				lastAssistantEntry = entry;
				break;
			}
		}

		if (!lastAssistantEntry) {
			consecutiveRecoveries = 0;
			return;
		}

		// ------------------------------------------------------------------
		// (b) The END of the last message must be a tool call.
		// ------------------------------------------------------------------
		const content = (lastAssistantEntry.message as { content?: unknown }).content;
		if (!Array.isArray(content) || content.length === 0) {
			consecutiveRecoveries = 0;
			return;
		}

		const lastPart = content[content.length - 1] as
			| {
					type?: string;
					id?: string;
					name?: string;
					thinking?: string;
					text?: string;
			  }
			| null
			| undefined;

		// The attempted tool call must be the very END of the message.
		let unexecutedToolName: string | null = null;

		if (lastPart && lastPart.type === "toolCall" && typeof lastPart.id === "string") {
			// Structured tool call — it must never have been executed (no
			// toolResult with a matching id may follow it in the branch).
			const lastAssistantIndex = branch.indexOf(lastAssistantEntry);
			let executed = false;
			for (let i = lastAssistantIndex + 1; i < branch.length; i++) {
				const entry = branch[i];
				if (entry.type !== "message") continue;
				const role = (entry.message as { role?: string })?.role;
				if (role !== "toolResult" && role !== "tool_result") continue;
				const toolCallId =
					(entry as { toolCallId?: string }).toolCallId ??
					((entry.message as { toolCallId?: string }) as any)?.toolCallId ??
					((entry.message as { tool_use_id?: string }) as any)?.tool_use_id;
				if (toolCallId === lastPart.id) {
					executed = true;
					break;
				}
			}
			if (!executed) unexecutedToolName = lastPart.name || "unknown";
		} else if (lastPart && (lastPart.type === "text" || lastPart.type === "thinking")) {
			// Leaked text tool call — the message must literally END with a
			// tool-call tag (e.g. Gemma's `...}<tool_call|>`). Quoting the
			// syntax mid-message and ending with normal prose never matches.
			const raw =
				lastPart.type === "thinking" ? lastPart.thinking : lastPart.text;
			if (typeof raw === "string" && TRAILING_TOOL_CALL_TAG.test(raw.trimEnd())) {
				unexecutedToolName = "unknown";
			}
		}

		if (!unexecutedToolName) {
			// The message did not end with an attempted tool call — this is a
			// normal completed turn.
			consecutiveRecoveries = 0;
			return;
		}

		// ------------------------------------------------------------------
		// Trigger auto-recovery (with a consecutive-failure guard).
		// ------------------------------------------------------------------
		consecutiveRecoveries++;

		if (consecutiveRecoveries >= MAX_CONSECUTIVE) {
			consecutiveRecoveries = 0;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto-recovery disabled after ${MAX_CONSECUTIVE} consecutive failures`,
					"error",
				);
			}
			return;
		}

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Turn ended with unexecuted tool call (${unexecutedToolName}). Auto-recovering (${consecutiveRecoveries}/${MAX_CONSECUTIVE})`,
				"warning",
			);
		}

		pi.sendUserMessage(RECOVERY_MESSAGE, { deliverAs: "followUp" });
	});
}
