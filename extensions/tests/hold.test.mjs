/**
 * End-result tests for the hold extension.
 *
 * Drives the real extension module with a fake pi event surface and asserts
 * the observable contract: a /hold issued mid-run must (1) reject every
 * submission while armed — mid-run steer/followUp AND idle submissions such
 * as recovery messages extensions queue while the session settles, restoring
 * interactive input to the editor instead of losing it — (2) abort the run
 * when the current turn ends — aborting, not just reporting, is what
 * actually stops the agent loop — (3) also abort any continuation run
 * (retry / compaction / queued-message) that starts before the session
 * settles, (4) keep the gate closed across the whole settle dispatch
 * (regardless of extension handler order) and disarm only afterwards, and
 * (5) register its turn_end listener only while armed — pi >= 1.1.0
 * dispatches turn_end as an actionable boundary, so a load-time listener
 * would tax every turn of every session.
 *
 * Run: node --test extensions/tests/hold.test.mjs
 * (Node >= 23.6 runs the .ts extension natively via type stripping)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import holdExtension from "../hold.ts";

/** Build a fake pi runtime around the extension; returns a handle to drive it. */
function bootHold({ idle }) {
	const handlers = new Map();
	let commandHandler;
	let aborts = 0;
	let editorText = "";
	const notifications = [];
	const statuses = [];

	holdExtension({
		// pi >= 1.1.0: pi.on() returns an unsubscribe function. The fake
		// mirrors that so the extension's dynamic registration is exercised;
		// emitting to a type with no handler is a no-op, as in real pi.
		on: (type, handler) => {
			handlers.set(type, handler);
			return () => {
				if (handlers.get(type) === handler) handlers.delete(type);
			};
		},
		registerCommand: (name, options) => {
			assert.equal(name, "hold");
			commandHandler = options.handler;
		},
	});

	const ctx = {
		isIdle: () => idle,
		abort: () => aborts++,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: (_key, value) => statuses.push(value),
			getEditorText: () => editorText,
			setEditorText: (text) => {
				editorText = text;
			},
		},
	};

	const emit = (type, event) => {
		const handler = handlers.get(type);
		if (!handler) return; // no listener registered for this event
		return handler(event ?? { type }, ctx);
	};

	return {
		command: () => commandHandler("", ctx),
		emitInput: (text, streamingBehavior, source = "interactive") =>
			emit("input", { text, streamingBehavior, source }),
		emitTurnEnd: () => emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] }),
		emitAgentStart: () => emit("agent_start", { type: "agent_start" }),
		emitAgentSettled: () => emit("agent_settled", { type: "agent_settled" }),
			hasHandler: (type) => handlers.has(type),
		notifications,
		statuses,
		get editorText() {
			return editorText;
		},
		get aborts() {
			return aborts;
		},
	};
}

// Same-delay timers fire FIFO, so this runs after the extension's own
// setTimeout(0) disarm scheduled during agent_settled.
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

test("/hold mid-run stops the session at the end of the current turn and survives continuations", async () => {
	const pi = bootHold({ idle: false });

	await pi.command();
	assert.ok(pi.notifications.some((n) => n.message.includes("Hold armed")));
	assert.equal(pi.statuses.at(-1), "hold: stopping after this turn");

	// Every submission offered while armed is rejected, not queued — mid-run
	// steer/followUp AND idle submissions (streamingBehavior undefined), the
	// shape extension recovery messages arrive in while the session settles.
	for (const behavior of ["steer", "followUp", undefined]) {
		const result = await pi.emitInput("continue the loop", behavior);
		assert.equal(result.action, "handled", `${behavior ?? "idle"} input must be held back`);
	}
	// Interactive input is restored to the editor, not lost.
	assert.ok(pi.editorText.includes("continue the loop"));
	assert.ok(pi.notifications.some((n) => n.message.includes("back in the input box")));

	// Extension-sourced input (auto-recover's recovery shape) is dropped.
	assert.equal((await pi.emitInput("recovery", undefined, "extension")).action, "handled");
	assert.ok(pi.notifications.some((n) => n.message.includes("dropped")));

	// The current turn finishes: the extension must abort the run so the
	// agent loop cannot start the next LLM call.
	const abortsBeforeTurnEnd = pi.aborts;
	await pi.emitTurnEnd();
	assert.equal(pi.aborts, abortsBeforeTurnEnd + 1, "run must be aborted at the turn's end");

	// A continuation run (pi retry / compaction / queued message) starts
	// before settlement: it must be aborted before it does work.
	await pi.emitAgentStart();
	assert.equal(pi.aborts, abortsBeforeTurnEnd + 2, "continuation runs must be aborted while armed");

	// Armed: the hold registered its turn_end listener.
	assert.ok(pi.hasHandler("turn_end"), "armed hold must register its turn_end listener");

	// Settlement: the hold reports the stop and clears the status.
	await pi.emitAgentSettled();
	assert.ok(pi.notifications.some((n) => n.message.includes("session stopped")));
	assert.equal(pi.statuses.at(-1), undefined, "status indicator must be cleared");

	// The gate stays closed for the rest of the settle dispatch ...
	assert.equal((await pi.emitInput("late recovery message", undefined, "extension")).action, "handled");

	// ... and reopens for the user's next prompt; a fresh, unheld run is
	// left alone.
	const abortsAfterSettle = pi.aborts;
	await nextMacrotask();
	assert.ok(!pi.hasHandler("turn_end"), "disarmed hold must release its turn_end listener");
	assert.equal((await pi.emitInput("new prompt", undefined)).action, "continue");
	await pi.emitAgentStart();
	await pi.emitTurnEnd();
	assert.equal(pi.aborts, abortsAfterSettle, "hold must be disarmed after settlement");
});

test("recovery messages sent during the settle dispatch are held back in either extension order", async () => {
	for (const order of ["send-first", "hold-first"]) {
		const pi = bootHold({ idle: false });
		await pi.command();
		await pi.emitTurnEnd();

		// Another extension queues a recovery message from its own
		// agent_settled handler (the shape that re-ran the session after the
		// hold in the field). pi consults the input gate for it before
		// yielding to the next macrotask — synchronously inside the handler
		// on 0.85.x, in the microtask chain right after the dispatch on
		// >= 1.1.0 — source "extension". Whichever handler order the settle
		// dispatch runs in, the hold must still be armed when it arrives.
		const send = () => pi.emitInput("recovery message", undefined, "extension");
		let sendResult;
		if (order === "send-first") {
			sendResult = await send();
			await pi.emitAgentSettled();
		} else {
			await pi.emitAgentSettled();
			sendResult = await send();
		}
		assert.equal(sendResult.action, "handled", `recovery must be held back (${order})`);
	}
});

test("/hold while idle reports the session already stopped and arms nothing", async () => {
	const pi = bootHold({ idle: true });

	await pi.command();
	assert.ok(pi.notifications.some((n) => n.message.includes("already stopped")));

	// Nothing armed: no turn_end listener, events pass through untouched.
	assert.ok(!pi.hasHandler("turn_end"), "idle /hold must arm nothing");
	assert.equal((await pi.emitInput("any message", "steer")).action, "continue");
	await pi.emitTurnEnd();
	await pi.emitAgentStart();
	await pi.emitAgentSettled();
	assert.equal(pi.aborts, 0);
	assert.ok(!pi.notifications.some((n) => n.message.includes("session stopped")));
});

test("repeat /hold while armed toggles the hold off and the session continues", async () => {
	const pi = bootHold({ idle: false });

	await pi.command();
	await pi.command();
	assert.ok(pi.notifications.some((n) => n.message.includes("Hold disarmed")));
	assert.equal(pi.statuses.at(-1), undefined, "status indicator must be cleared");

	// The toggle released the turn_end listener with the hold ...
	assert.ok(!pi.hasHandler("turn_end"), "toggled-off hold must release its turn_end listener");

	// ... and nothing is held any more: submissions flow and no event aborts the run.
	const abortsBefore = pi.aborts;
	assert.equal((await pi.emitInput("carry on", "steer")).action, "continue");
	await pi.emitTurnEnd();
	await pi.emitAgentStart();
	assert.equal(pi.aborts, abortsBefore, "a disarmed hold must not abort anything");
});
