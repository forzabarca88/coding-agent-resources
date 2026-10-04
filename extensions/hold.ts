/**
 * Hold Command Extension
 *
 * Registers the /hold command — a toggle (typing /hold again while armed
 * disarms it) and the automated, deferred equivalent of pressing ESC: the session stops at the END of the current agent turn
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
 * - `/hold` again while armed disarms the hold (toggle): submissions flow
 *   again, the status indicator is cleared and no further aborts happen.
 *   Disarming before the current turn's `turn_end` cancels the stop
 *   entirely; after it the abort has already fired and the run is ending
 *   regardless.
 * - While armed, EVERY message submitted is rejected at the `input` gate —
 *   mid-run `steer`/`followUp` submissions (TUI Enter / Alt+Enter,
 *   /followup, extension sendUserMessage) AND idle submissions, which
 *   includes recovery messages extensions queue while the session is
 *   settling (pi delivers those with streamingBehavior undefined because
 *   the agent is idle at `agent_settled`). Interactive input is restored to
 *   the editor (the same restore ESC performs) so no typed prompt is lost;
 *   extension/RPC input is dropped with a notification. Nothing new enters
 *   the session between /hold and the settle. (Raw RPC `steer`/`follow_up`
 *   commands and custom messages bypass pi's input gate and are not
 *   covered.)
 * - At the `turn_end` of the current turn the hold aborts the run — the same
 *   operation ESC performs (`ctx.abort()`). `turn_end` alone cannot stop the
 *   loop: the next LLM call starts right after it. With the run's abort
 *   signal already set, that next call fails instantly without provider
 *   work and the run ends at `agent_end`. pi never auto-retries an abort,
 *   and auto-recover ignores abort-shaped stops (including the one pi-ai
 *   classifies as stopReason "error" with the abort reason as errorMessage),
 *   so nothing revives the run from that message.
 * - The hold stays armed until `agent_settled`. Any continuation run that
 *   starts while armed (retry backoff finishing, compaction continuation,
 *   queued-message continuation) is aborted at its `agent_start`, before it
 *   does any work. At `agent_settled` the hold reports the stop — the
 *   deferred-ESC moment — and disarms on the next macrotask, so messages
 *   other extensions queue from their own `agent_settled` handlers (whose
 *   input events fire synchronously inside those handlers) are still
 *   dropped regardless of extension load order. pi remains open for the
 *   next prompt.
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
// Prefix of the error pi throws when a ctx is used after the extension
// runtime was invalidated (session replacement or shutdown) — the same
// teardown race auto-recover tolerates.
const STALE_CTX_ERROR_PREFIX = "This extension ctx is stale";

export default function (pi: ExtensionAPI) {
	// Latched from /hold until just after the session settles; gates all
	// submissions and keeps stopping continuation runs that start while
	// armed. Cleared on /reload//new, which recreate the extension.
	let holdArmed = false;
	// Reports the stop at most once per hold (two settles are reachable only
	// if something bypasses the gate, but the notification must not double).
	let stopReported = false;
	// Pending post-settle disarm (see agent_settled); cleared if /hold toggles
	// the hold off or re-arms it before the timer fires.
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;

	pi.registerCommand("hold", {
		description: "Toggle: stop the session at the end of the current agent turn",
		handler: async (_args, ctx) => {
			if (holdArmed) {
				holdArmed = false;
				stopReported = false;
				if (disarmTimer !== undefined) {
					clearTimeout(disarmTimer);
					disarmTimer = undefined;
				}
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Hold disarmed: the session continues", "info");
				return;
			}
			if (ctx.isIdle()) {
				// No turn in progress — the session is already stopped.
				ctx.ui.notify("Hold: session already stopped (no turn in progress)", "info");
				return;
			}
			holdArmed = true;
			stopReported = false;
			ctx.ui.setStatus(STATUS_KEY, "hold: stopping after this turn");
			ctx.ui.notify("Hold armed: stopping when the current turn finishes", "info");
		},
	});

	// Every submission while armed is rejected, whatever its streamingBehavior
	// (commands never reach this gate — pi executes them before the input
	// event). This covers mid-run steer/followUp submissions AND idle
	// submissions, notably recovery messages extensions queue while the
	// session settles: pi delivers them with streamingBehavior undefined
	// because the agent is idle at agent_settled. Interactive input goes back
	// into the editor (the same restore ESC performs) instead of being lost.
	pi.on("input", async (event, ctx) => {
		if (!holdArmed) return { action: "continue" };
		if (event.source === "interactive") {
			const current = ctx.ui.getEditorText();
			ctx.ui.setEditorText([event.text, current].filter((t) => t.trim()).join("\n\n"));
			ctx.ui.notify("Hold: session is stopping — your message is back in the input box", "info");
		} else {
			const preview = event.text.trim().replace(/\s+/g, " ").slice(0, 60);
			ctx.ui.notify(`Hold: dropped "${preview}${event.text.length > 60 ? "…" : ""}" (the session is stopping)`, "info");
		}
		return { action: "handled" };
	});

	// End of a turn: the turn's work (assistant message + every tool result)
	// is fully recorded, so this is the moment to stop the run. Aborting
	// (not merely reporting) is essential: while the turn had tool calls,
	// the agent loop starts the next LLM call right after this event —
	// reporting alone left the session running (the original bug). The
	// already-aborted signal makes that next call fail before any provider
	// work, ending the run. Idempotent: aborting an already-aborting run is
	// a no-op.
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
	// continuation will run anymore. Report the stop, but disarm only on the
	// next macrotask: other extensions queue recovery messages from their
	// own agent_settled handlers (auto-recover does), and that
	// sendUserMessage reaches the input gate synchronously inside their
	// handler — holding the gate open across the whole dispatch drops those
	// messages regardless of extension load order.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!holdArmed) return;
		// Disarm first so a stale-ctx failure below can never leave the hold
		// armed, and on the next macrotask so other extensions' agent_settled
		// handlers (auto-recover queues its recovery from there, and that
		// sendUserMessage reaches the input gate synchronously) are still
		// gated regardless of extension load order.
		disarmTimer = setTimeout(() => {
			holdArmed = false;
			disarmTimer = undefined;
		}, 0);
		if (stopReported) return;
		stopReported = true;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.notify("Hold: session stopped at the end of the turn", "info");
		} catch (error) {
			// Session replaced or pi shutting down: no live UI to report into.
			if (!(error instanceof Error && error.message.startsWith(STALE_CTX_ERROR_PREFIX))) {
				throw error;
			}
		}
	});
}
