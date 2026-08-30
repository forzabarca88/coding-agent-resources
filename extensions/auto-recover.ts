/**
 * Auto-Recover Extension
 *
 * Detects when an agent run ends with an *unexecuted trailing tool call* or
 * an *empty completion after a tool result* and automatically queues a user
 * message prompting the model to continue.
 *
 * Strict trigger conditions — recovery ONLY fires when BOTH hold:
 *
 *   a) The agent run has ended. `agent_end` is the earliest event at which
 *      the run is over and the final assistant message is known, which also
 *      allows the recovery follow-up to be queued BEFORE pi decides whether
 *      to continue: a queued follow-up makes `_handlePostAgentRun` keep the
 *      loop alive (`agent.continue()`), so the recovery runs inside the same
 *      prompt call instead of being started after settlement. This matters
 *      in single-shot `--mode json`/`--mode print` invocations (e.g. eval
 *      harnesses), where pi terminates as soon as a run settles — a recovery
 *      started from `agent_settled` would be aborted at process exit.
 *
 *      `agent_settled` remains as a fallback that fires only when the loop
 *      ended without a follow-up being queued for the final run: another
 *      extension registered an `input` handler (making the queueing
 *      asynchronous and racy), the message had `stopReason === "error"` and
 *      pi's own retry did not resolve it, or queueing threw synchronously.
 *
 *      Known limitation: the fallback starts a fresh run at settlement, and
 *      in single-shot `--mode json`/`--mode print` invocations the process
 *      exits right after settlement — so a fallback-triggered recovery never
 *      executes there. Combined with the error-stop deferral below, an
 *      error-interrupted run in single-shot mode (retries disabled or a
 *      non-retryable provider error) therefore does not recover; non-error
 *      interruptions are handled in-process by the primary `agent_end` path
 *      and do recover in single-shot mode.
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
 *      stopReason semantics:
 *      - `"aborted"` (user interrupted — do not re-run against the user's
 *        will): never a trigger, never resets the guard.
 *      - `"error"` (provider/retry failure): if the message really ends
 *        with an interrupted attempt, queueing at `agent_end` is deferred
 *        so pi's own auto-retry can resolve the turn first; the
 *        `agent_settled` fallback recovers the run only if retries did not
 *        resolve it. An error run that ends in normal prose is neither a
 *        trigger nor a reset, so an intermittent provider error cannot
 *        silently clear the consecutive-failure guard.
 *
 * Shutdown/replacement safety: pi also emits `agent_end`/`agent_settled`
 * for a run that was aborted during shutdown or session replacement — the
 * event is delivered from the agent loop's finally block, AFTER the
 * extension runtime has already been invalidated. Every ctx/pi access in
 * that situation throws a "stale ctx" error, so the handlers treat that
 * one specific error as "no live session to recover into" and bail quietly
 * instead of surfacing a scary error at exit.
 *
 * The queueing/continue ordering above is verified against the installed
 * pi bundle (v0.84.3); treat those internals as version-specific.
 *
 * Place in ~/.pi/agent/extensions/ for global use, or .pi/extensions/ for
 * project-local.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Maximum consecutive runs ending in an interrupted attempt before giving up.
// Once the limit is reached, recovery stays disabled until a normal
// (non-interrupted, non-error) run end resets the counter.
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

// Prefix of the error pi throws when a captured pi/ctx is used after the
// extension runtime was invalidated (session replacement or shutdown).
// Matched by prefix so minor rewording of the message does not break the
// guard; any other error is rethrown so real bugs still surface.
const STALE_CTX_ERROR_PREFIX = "This extension ctx is stale";

function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith(STALE_CTX_ERROR_PREFIX)
	);
}

// Minimal structural types for the branch entries the detector reads.
// stopReason mirrors the assistant message's stop reason ("stop", "toolUse",
// "length", "error", "aborted") and gates the abort/error semantics.
type BranchEntryLike = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		toolCallId?: string;
		tool_use_id?: string;
	};
	toolCallId?: string;
};

// Result of inspecting the final assistant message of a run.
type Detection =
	// The run ended with an interrupted attempt worth recovering from.
	// `errorStop` is true when the run ended with stopReason "error" —
	// queueing is deferred at agent_end so pi's own retry can resolve it.
	| { kind: "interrupted"; toolName: string; errorStop: boolean }
	// The run ended with a normal, completed turn.
	| { kind: "normal" }
	// The run ended in a way that must neither trigger nor reset recovery:
	// stopReason "aborted", or an "error" run whose content is not an
	// interrupted attempt.
	| { kind: "ignore" };

/** Extract the toolCall id recorded on a toolResult branch entry, if any. */
function getResultCallId(entry: BranchEntryLike | undefined): string | null {
	const callId =
		entry?.toolCallId ?? entry?.message?.toolCallId ?? entry?.message?.tool_use_id;
	return typeof callId === "string" ? callId : null;
}

/**
 * Normalize the per-run `messages` payload of `agent_end` into the
 * branch-entry shape the detector reads, or null when unavailable.
 * Detection over the run's own messages is per-run: the whole-session branch
 * can end with a message from an EARLIER run when this run appended no
 * assistant message, which could reset or re-trigger recovery on stale data.
 */
function normalizeRunMessages(messages: unknown): BranchEntryLike[] | null {
	if (!Array.isArray(messages)) return null;
	const entries: BranchEntryLike[] = [];
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const message = raw as {
			role?: string;
			content?: unknown;
			stopReason?: string;
			toolCallId?: string;
			tool_use_id?: string;
		};
		entries.push({
			type: "message",
			message: {
				role: message.role,
				content: message.content,
				stopReason: message.stopReason,
				toolCallId: message.toolCallId ?? message.tool_use_id,
			},
		});
	}
	return entries;
}

// True when the assistant message ending at `assistantIndex` issued a
// toolCall whose id matches the toolResult at `resultIndex` — i.e. the run
// stopped mid-task (tool executed, blank completion emitted). Only the most
// recent assistant message can own the pending call — a toolResult directly
// follows the assistant message that issued its calls.
function hasMatchingToolCall(
	branch: BranchEntryLike[],
	resultIndex: number,
): boolean {
	const resultCallId = getResultCallId(branch[resultIndex]);
	if (!resultCallId) return false;
	for (let i = resultIndex - 1; i >= 0; i--) {
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

/**
 * Inspect the last assistant message of the branch and decide how the run
 * ended. Returns the tool name (or the EMPTY_TURN_NAME sentinel) for an
 * interrupted attempt (with an `errorStop` flag for stopReason "error"),
 * "normal" for a completed turn, or "ignore" for runs that must never
 * trigger nor reset recovery.
 */
function detectInterruptedAttempt(branch: BranchEntryLike[]): Detection {
	// ------------------------------------------------------------------
	// The run is over — find the last assistant message of the branch.
	// ------------------------------------------------------------------
	let lastAssistantEntry: BranchEntryLike | null = null;
	let lastAssistantIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message?.role === "assistant") {
			lastAssistantEntry = entry;
			lastAssistantIndex = i;
			break;
		}
	}
	if (!lastAssistantEntry) return { kind: "normal" };

	const stopReason = lastAssistantEntry.message?.stopReason;
	if (stopReason === "aborted") {
		// User interrupted — do not re-run against the user's will.
		return { kind: "ignore" };
	}
	const errorStop = stopReason === "error";

	const content = lastAssistantEntry.message?.content;

	// The interrupted attempt must be the very END of the message.
	if (!Array.isArray(content)) {
		return errorStop ? { kind: "ignore" } : { kind: "normal" };
	}

	if (content.length === 0) {
		// Empty assistant turn — recovery trigger only when the message
		// directly follows a tool result whose toolCall is also in the branch
		// (i.e. the run stopped mid-task: provider billed output tokens but
		// emitted no content, e.g. a blank deepseek-flash stop). A legitimate
		// closing empty turn after a finished run has no pending toolCall.
		let prevIndex = lastAssistantIndex - 1;
		while (prevIndex >= 0 && branch[prevIndex].type !== "message") prevIndex--;
		const prevEntry = branch[prevIndex];
		const prevIsToolResult =
			!!prevEntry &&
			prevEntry.type === "message" &&
			(prevEntry.message?.role === "toolResult" ||
				prevEntry.message?.role === "tool_result");
		if (prevIsToolResult && hasMatchingToolCall(branch, prevIndex)) {
			return { kind: "interrupted", toolName: EMPTY_TURN_NAME, errorStop };
		}
		return errorStop ? { kind: "ignore" } : { kind: "normal" };
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

	if (lastPart && lastPart.type === "toolCall" && typeof lastPart.id === "string") {
		// Structured tool call — it must never have been executed (no
		// toolResult with a matching id may follow it in the branch).
		let executed = false;
		for (let i = lastAssistantIndex + 1; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type !== "message") continue;
			const role = entry.message?.role;
			if (role !== "toolResult" && role !== "tool_result") continue;
			const toolCallId = getResultCallId(entry);
			if (toolCallId === lastPart.id) {
				executed = true;
				break;
			}
		}
		if (!executed) {
			return {
				kind: "interrupted",
				toolName: lastPart.name || "unknown",
				errorStop,
			};
		}
		return errorStop ? { kind: "ignore" } : { kind: "normal" };
	}

	if (lastPart && (lastPart.type === "text" || lastPart.type === "thinking")) {
		// Leaked text tool call — the message must literally END with a
		// tool-call tag (e.g. Gemma's `...}<tool_call|>`). Quoting the
		// syntax mid-message and ending with normal prose never matches.
		const raw = lastPart.type === "thinking" ? lastPart.thinking : lastPart.text;
		if (typeof raw === "string" && TRAILING_TOOL_CALL_TAG.test(raw.trimEnd())) {
			return { kind: "interrupted", toolName: "unknown", errorStop };
		}
	}
	return errorStop ? { kind: "ignore" } : { kind: "normal" };
}

export default function (pi: ExtensionAPI) {
	let consecutiveRecoveries = 0;
	// Set once MAX_CONSECUTIVE is reached; recovery stays off until a normal
	// (non-interrupted, non-error) run end resets the counter.
	let recoveryDisabled = false;
	// Set when a recovery follow-up has been queued for the current run;
	// cleared at the next agent_start. Prevents the agent_settled fallback
	// from re-handling (double-counting / double-sending) a run the
	// agent_end path already queued a follow-up for.
	let recoveryQueuedForRun = false;

	pi.on("agent_start", () => {
		recoveryQueuedForRun = false;
	});

	// Primary path: runs BEFORE pi decides whether to keep the loop alive
	// (_handlePostAgentRun -> hasQueuedMessages -> continue()), so the queued
	// follow-up is consumed inside the same prompt call.
	pi.on("agent_end", async (event, ctx) => {
		try {
			maybeRecoverAtRunEnd(ctx, event.messages);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
			// Run torn down (shutdown) or session replaced before this
			// delayed event was handled — no live session to recover into.
		}
	});

	// Fallback: fires only when the loop really ended without a follow-up
	// being queued for the final run (see header). Never re-handles a run the
	// agent_end path already covered.
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			maybeRecoverAtSettle(ctx);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	});

	function maybeRecoverAtRunEnd(ctx: ExtensionContext, runMessages?: unknown) {
		if (recoveryQueuedForRun) return; // defensive; cleared at agent_start
		// Prefer the run's own messages (per-run detection); fall back to the
		// whole-session branch (what the settled fallback must use).
		const branch = normalizeRunMessages(runMessages) ?? ctx.sessionManager.getBranch();
		const detection = detectInterruptedAttempt(branch);

		if (detection.kind === "interrupted") {
			if (detection.errorStop) {
				// Defer to pi's own auto-retry: it may resolve the turn inside
				// the loop. If it does not, the agent_settled fallback recovers
				// the stalled error run (and counts it) instead.
				return;
			}
			queueRecovery(ctx, detection.toolName);
		} else if (detection.kind === "normal") {
			// Fresh start after a normal completed turn.
			consecutiveRecoveries = 0;
			recoveryDisabled = false;
		}
		// "ignore" (aborted/error-prose): neither trigger nor reset.
	}

	function maybeRecoverAtSettle(ctx: ExtensionContext) {
		if (recoveryQueuedForRun) return; // agent_end already handled this run
		const detection = detectInterruptedAttempt(ctx.sessionManager.getBranch());

		if (detection.kind === "interrupted" && !recoveryDisabled) {
			// Counting here is safe: the flag above guarantees this only runs
			// when the agent_end path did NOT count this run (queueing threw
			// or was deferred for an error run), so the consecutive guard
			// cannot be bypassed by endless error runs.
			queueRecovery(ctx, detection.toolName);
		}
		// "normal"/"ignore": never reset from the fallback — the agent_end
		// path already handled the counter for this run.
	}

	function queueRecovery(ctx: ExtensionContext, toolName: string) {
		// Give-up latch active (previous failure reached the cap): no further
		// recovery until a normal (non-interrupted, non-error) run end.
		if (recoveryDisabled) return;

		// The next failure would reach the cap — give up for this run.
		if (consecutiveRecoveries + 1 >= MAX_CONSECUTIVE) {
			consecutiveRecoveries = 0;
			recoveryDisabled = true;
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Auto-recovery disabled after ${MAX_CONSECUTIVE} consecutive failures`,
					"error",
				);
			}
			return;
		}

		const recoveryMessage =
			toolName === EMPTY_TURN_NAME ? EMPTY_TURN_MESSAGE : RECOVERY_MESSAGE;

		// Queued as a follow-up. At agent_end the agent is still "streaming",
		// so this enqueues synchronously (deterministic unless an extension
		// registered an `input` handler) and the loop picks it up via
		// hasQueuedMessages -> continue(); at agent_settled (agent idle) it
		// starts a fresh run — deliverAs is only meaningful while streaming,
		// so it is a no-op on that path. Throws synchronously on a stale ctx
		// or a non-stale failure (e.g. compaction in progress) — the counters
		// below only advance after a successful send.
		pi.sendUserMessage(recoveryMessage, { deliverAs: "followUp" });

		recoveryQueuedForRun = true;
		consecutiveRecoveries++;

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Turn ended with interrupted attempt (${toolName}). Auto-recovering (${consecutiveRecoveries}/${MAX_CONSECUTIVE})`,
				"warning",
			);
		}
	}
}
