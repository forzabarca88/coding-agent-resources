/**
 * Follow-Up Command Extension
 *
 * Registers the /followup command to queue a user message for delivery
 * after the agent finishes all work on its current turn.
 *
 * - If the agent is idle (not streaming), the message is sent immediately,
 *   triggering a new turn.
 * - If the agent is streaming (busy), the message is queued with
 *   `deliverAs: "followUp"` and delivered once the current turn ends.
 *
 * Place in ~/.pi/agent/extensions/ for global use, or .pi/extensions/ for
 * project-local.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("followup", {
		description: "Queue a follow-up message (waits for current processing to finish)",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				ctx.ui.notify("Usage: /followup <message>", "warning");
				return;
			}

			if (ctx.isIdle()) {
				// Not streaming — send immediately, triggers a new turn
				pi.sendUserMessage(args);
			} else {
				// Streaming — queue as follow-up, delivered after current turn ends
				pi.sendUserMessage(args, { deliverAs: "followUp" });
				ctx.ui.notify("Follow-up queued", "info");
			}
		},
	});
}
