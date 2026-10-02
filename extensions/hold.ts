/**
 * Hold Command Extension
 *
 * Registers the /hold command — the automated, deferred equivalent of
 * pressing ESC: the session stops at the END of the current agent turn
 * instead of cutting it short, and pi itself stays open.
 *
 * Terminology (pi internals, verified against the installed bundle): a
 * "turn" is ONE assistant message (one LLM call) plus its tool results —
 * `turn_end` fires after every single one of them. A "run" is the whole
 * agent loop (agent_start … agent_end): while a turn had tool calls, the
 * loop immediately starts the next LLM call after that turn's `turn_end`,
 * and after agent_end it may still start continuation runs (pi's
 * auto-retry, compaction, queued messages). The session only truly stops
 * at `agent_settled`, when none of those can run anymore.
 *
 * How it works:
 * - `/hold` while a turn is in progress arms the hold and shows a persistent
 *   status indicator. The current turn always completes normally (the LLM
 *   call and every tool call in it — the abort only takes effect from the
 *   next LLM call onward).
 * - While armed, mid-run submissions are rejected at the same `input` gate
 *   steering uses: any message offered with `streamingBehavior` "steer" or
 *   "followUp" (TUI Enter / Alt+Enter, /followup, extension sendUserMessage)
 *   is dropped with a notification, so nothing new is queued behind the
 *   current turn. (Raw RPC `steer`/`follow_up` commands bypass pi's input
 *   gate and are not covered.)
 * - At the `turn_end` of the current turn the hold aborts the run — the same
 *   operation ESC performs (`ctx.abort()`). `turn_end` alone cannot stop the
 *   loop: the next LLM call starts right after it. With the run's abort
 *   signal already set, that next call fails instantly with
 *   stopReason "aborted" (no provider work, no tokens), so the run ends at
 *   `agent_end`. pi never auto-retries an "aborted" stop and auto-recover
 *   ignores it, so nothing revives the run from that message.
 * - The hold stays armed until `agent_settled`. Any continuation run that
 *   starts while armed (retry backoff finishing, compaction continuation,
 *   queued-message continuation) is aborted at its `agent_start`, before it
 *   does any work. At `agent_settled` the hold disarms and reports the stop
 *   — the deferred-ESC moment — while pi remains open for the next prompt.
 * - `/hold` while idle: nothing to stop; notifies that the session is
 *   already stopped.
 *
 * Messages queued BEFORE /hold: in the TUI, aborting restores them to the
 * editor (like ESC), so they are neither lost nor allowed to continue the
 * session. In modes without that restore they may be injected at the stop
 * point (recorded in the session, never processed) or remain queued for the
 * next prompt. Nothing queued AFTER /hold can continue the session.
 *
 * Never calls ctx.shutdown(): /hold keeps the pi process alive.
 *
 * Place in ~/.pi/agent/extensions/ for global use, or .pi/extensions/ for
 * project-local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "hold";

export default function (pi: ExtensionAPI) {
	// Latched from /hold until the session settles; gates mid-run
	// submissions and keeps stopping continuation runs that start while
	// armed. Cleared on /reload//new, which recreate the extension.
	let holdArmed = false;

	pi.registerCommand("hold", {
		description: "Stop the session at the end of the current agent turn",
		handler: async (_args, ctx) => {
			if (holdArmed) {
				ctx.ui.notify("Hold already armed: stopping when the current turn finishes", "info");
				return;
			}
			if (ctx.isIdle()) {
				// No turn in progress — the session is already stopped.
				ctx.ui.notify("Hold: session already stopped (no turn in progress)", "info");
				return;
			}
			holdArmed = true;
			ctx.ui.setStatus(STATUS_KEY, "hold: stopping after this turn");
			ctx.ui.notify("Hold armed: stopping when the current turn finishes", "info");
		},
	});

	// The same gate steering flows through: mid-run submissions arrive here
	// with streamingBehavior set. While a hold is armed, drop them so nothing
	// new continues the session past the current turn.
	pi.on("input", async (event, ctx) => {
		if (!holdArmed) return { action: "continue" };
		if (event.streamingBehavior !== "steer" && event.streamingBehavior !== "followUp") {
			return { action: "continue" };
		}
		const preview = event.text.trim().replace(/\s+/g, " ").slice(0, 60);
		ctx.ui.notify(`Hold: held back "${preview}${event.text.length > 60 ? "…" : ""}" until you continue`, "info");
		return { action: "handled" };
	});

	// End of a turn: the turn's work (assistant message + every tool result)
	// is fully recorded, so this is the moment to stop the run. Aborting
	// (not merely reporting) is essential: while the turn had tool calls,
	// the agent loop starts the next LLM call right after this event —
	// reporting alone left the session running (the old bug). The already
	// aborted signal makes that next call fail instantly with
	// stopReason "aborted", ending the run. Idempotent: aborting an
	// already-aborting run is a no-op.
	pi.on("turn_end", async (_event, ctx) => {
		if (!holdArmed) return;
		ctx.abort();
	});

	// A new run starting while armed is a continuation of the held one —
	// pi's auto-retry, a compaction continuation, or a queued-message
	// continuation. These are session-internal mechanisms an extension
	// cannot cancel at their source, so kill the run before it does work.
	pi.on("agent_start", async (_event, ctx) => {
		if (!holdArmed) return;
		ctx.abort();
	});

	// The session has fully settled: no retry, compaction or queued
	// continuation will run anymore. Disarm and report the stop.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!holdArmed) return;
		holdArmed = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Hold: session stopped at the end of the turn", "info");
	});
}
