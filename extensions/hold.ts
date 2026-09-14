/**
 * Hold Command Extension
 *
 * Registers the /hold command — the automated, deferred equivalent of
 * pressing ESC: the session stops at the END of the current agent turn
 * instead of cutting it short, and pi itself stays open.
 *
 * How it works (mirrors how steering is delivered):
 * - `/hold` while a turn is in progress arms the hold and shows a persistent
 *   status indicator. The current turn always completes normally.
 * - While armed, mid-run submissions are rejected at the same `input` gate
 *   steering uses: any message offered with `streamingBehavior` "steer" or
 *   "followUp" (TUI Enter / Alt+Enter, /followup, extension sendUserMessage)
 *   is dropped with a notification, so nothing new is queued behind the
 *   current turn. This is the queue-clearing half of ESC, applied from the
 *   moment of /hold. (Raw RPC `steer`/`follow_up` commands bypass pi's input
 *   gate and are not covered.)
 * - At the `turn_end` of the current turn the hold disarms and reports the
 *   stop. With nothing queued behind it, the run settles there — the
 *   deferred-ESC moment — while pi remains open for the next prompt.
 * - `/hold` while idle: nothing to stop; notifies that the session is
 *   already stopped.
 *
 * Limitation: messages already queued BEFORE /hold was invoked sit in the
 * agent's internal queues, which the extension API cannot clear; they are
 * delivered before the run ends. /hold guarantees that nothing queued after
 * it continues the session.
 *
 * Never calls ctx.shutdown(): /hold keeps the pi process alive.
 *
 * Place in ~/.pi/agent/extensions/ for global use, or .pi/extensions/ for
 * project-local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "hold";

export default function (pi: ExtensionAPI) {
	// Latched from /hold until the end of the current turn; prevents repeat
	// invocations from re-arming and gates mid-run submissions.
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

	// End of the current turn: report the stop and disarm. The run settles
	// here unless messages were already queued before /hold.
	pi.on("turn_end", async (_event, ctx) => {
		if (!holdArmed) return;
		holdArmed = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Hold: session stopped at the end of the turn", "info");
	});
}