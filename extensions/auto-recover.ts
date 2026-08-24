/**
 * Auto-Recover Extension
 *
 * Detects when an agent run ends with an *unexecuted trailing tool call* or
 * an *empty completion after a tool result* and automatically sends a user
 * message prompting the model to continue.
 *
 * Strict trigger conditions — recovery ONLY fires when BOTH hold:
 *
 *   a) The last message ended the agent run and control is about to
 *      transition back to the user turn. This is detected via the
 *      `agent_settled` event — unlike `agent_end`, Pi fires it only when
 *      no auto-retry / compaction / follow-up handling remains, so the
 *      next step really is a transition to the user turn.
 *
 *   b) The last message ended with an interrupted attempt. Either the
 *      last content part is a structured `toolCall` that was never
 *      executed, the final text/thinking literally ENDS with a leaked
 *      tool-call tag (e.g. Gemma's `...}<tool_call|>`, or an XML leak
 *      ending in `</tool_call>`), or the message is EMPTY and directly
 *      follows a tool result (a provider blank completion — output tokens
 *      billed but no content emitted). Messages that merely quote
 *      tool-call syntax and end in normal prose never trigger.
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

// Sentinel used to select the empty-turn recovery message.
const EMPTY_TURN_NAME = "empty-turn";

// Message sent when the previous turn was an empty completion that
// directly followed a tool result (provider blank completion).
const EMPTY_TURN_MESSAGE =
	"Your previous turn was empty. Continue with the pending work.";

// True when the branch contains an assistant toolCall whose id matches the
// toolResult immediately preceding `emptyAssistantIndex` — i.e. the run
// stopped mid-task (tool executed, blank completion emitted).
function hasMatchingToolCall(
	branch: { type: string; message?: { role?: string; content?: unknown } }[],
	emptyAssistantIndex: number,
): boolean {
	const resultEntry = branch[emptyAssistantIndex - 1] as
		| { message?: { role?: string }; toolCallId?: string; tool_use_id?: string }
		| undefined;
	const resultCallId =
		resultEntry?.toolCallId ??
		(resultEntry?.message as { toolCallId?: string } | undefined)?.toolCallId ??
		(resultEntry?.message as { tool_use_id?: string } | undefined)?.tool_use_id;
	if (!resultCallId) return false;
	// Only the most recent assistant message can own the pending call — a
	// toolResult directly follows the assistant message that issued its calls.
	for (let i = emptyAssistantIndex - 2; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (Array.isArray(content)) {
			for (const part of content) {
				if (
					(part as { type?: string })?.type === "toolCall" &&
					(part as { id?: string })?.id === resultCallId
				) {
					return true;
				}
			}
		}
		break; // only the immediately preceding assistant message may match
	}
	return false;
}

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
		// (b) The last message must be an interrupted attempt: an unexecuted
		//     tool call at the end of the message, or an EMPTY assistant turn
		//     that directly follows a tool result (provider blank completion).
		// ------------------------------------------------------------------
		const content = (lastAssistantEntry.message as { content?: unknown }).content;
		const lastAssistantIndex = branch.indexOf(lastAssistantEntry);

		// The interrupted attempt must be the very END of the message.
		let unexecutedToolName: string | null = null;

		if (!Array.isArray(content)) {
			// Malformed content — treat as a normal completed turn (no
			// recovery; the !unexecutedToolName path below resets the counter).
		} else if (content.length === 0) {
			// Empty assistant turn — recovery trigger only when the next-previous
			// message is a tool result whose toolCall is also in the branch (i.e.
			// the run stopped mid-task: provider billed output tokens but emitted
			// no content, e.g. a blank DeepSeek-v4-flash stop). A legitimate
			// closing empty turn after a finished run has no pending toolCall.
			const prevEntry = branch[lastAssistantIndex - 1];
			const prevIsToolResult =
				!!prevEntry &&
				prevEntry.type === "message" &&
				((prevEntry.message as { role?: string })?.role === "toolResult" ||
					(prevEntry.message as { role?: string })?.role === "tool_result");
			const toolAfterResult = prevIsToolResult && hasMatchingToolCall(branch, lastAssistantIndex);
			if (toolAfterResult) unexecutedToolName = EMPTY_TURN_NAME;
		} else {
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

			if (lastPart && lastPart.type === "toolCall" && typeof lastPart.id === "string") {
				// Structured tool call — it must never have been executed (no
				// toolResult with a matching id may follow it in the branch).
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

		const recoveryMessage =
			unexecutedToolName === EMPTY_TURN_NAME ? EMPTY_TURN_MESSAGE : RECOVERY_MESSAGE;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Turn ended with interrupted attempt (${unexecutedToolName}). Auto-recovering (${consecutiveRecoveries}/${MAX_CONSECUTIVE})`,
				"warning",
			);
		}

		pi.sendUserMessage(recoveryMessage, { deliverAs: "followUp" });
	});
}
