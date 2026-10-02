/**
 * End-result tests for the hold extension.
 *
 * Drives the real extension module with a fake pi event surface and asserts
 * the observable contract: a /hold issued mid-run must (1) reject mid-run
 * submissions, (2) abort the run when the current turn ends — aborting, not
 * just reporting, is what actually stops the agent loop — (3) also abort any
 * continuation run (retry / compaction / queued-message) that starts before
 * the session settles, and (4) disarm only at agent_settled so a new,
 * unheld run afterwards is left alone.
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
	const notifications = [];
	const statuses = [];

	holdExtension({
		on: (type, handler) => handlers.set(type, handler),
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
		},
	};

	const emit = (type, event) => handlers.get(type)(event ?? { type }, ctx);

	return {
		command: () => commandHandler("", ctx),
		emitInput: (text, streamingBehavior) => emit("input", { text, streamingBehavior, source: "interactive" }),
		emitTurnEnd: () => emit("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] }),
		emitAgentStart: () => emit("agent_start", { type: "agent_start" }),
		emitAgentSettled: () => emit("agent_settled", { type: "agent_settled" }),
		notifications,
		statuses,
		get aborts() {
			return aborts;
		},
	};
}

test("/hold mid-run stops the session at the end of the current turn and survives continuations", async () => {
	const pi = bootHold({ idle: false });

	await pi.command();
	assert.ok(pi.notifications.some((n) => n.message.includes("Hold armed")));
	assert.equal(pi.statuses.at(-1), "hold: stopping after this turn");

	// Mid-run submissions offered while armed are rejected, not queued.
	for (const behavior of ["steer", "followUp"]) {
		const result = await pi.emitInput("continue the loop", behavior);
		assert.equal(result.action, "handled", `${behavior} input must be held back`);
	}
	assert.ok(pi.notifications.some((n) => n.message.includes("held back")));

	// The current turn finishes: the extension must abort the run so the
	// agent loop cannot start the next LLM call.
	const abortsBeforeTurnEnd = pi.aborts;
	await pi.emitTurnEnd();
	assert.equal(pi.aborts, abortsBeforeTurnEnd + 1, "run must be aborted at the turn's end");

	// A continuation run (pi retry / compaction / queued message) starts
	// before settlement: it must be aborted before it does work.
	await pi.emitAgentStart();
	assert.equal(pi.aborts, abortsBeforeTurnEnd + 2, "continuation runs must be aborted while armed");

	// Settlement: the hold reports the stop and disarms.
	await pi.emitAgentSettled();
	assert.ok(pi.notifications.some((n) => n.message.includes("session stopped")));
	assert.equal(pi.statuses.at(-1), undefined, "status indicator must be cleared");

	// A fresh, unheld run afterwards is left alone: input flows, no aborts.
	const abortsAfterSettle = pi.aborts;
	assert.equal((await pi.emitInput("new prompt", undefined)).action, "continue");
	await pi.emitAgentStart();
	await pi.emitTurnEnd();
	assert.equal(pi.aborts, abortsAfterSettle, "hold must be disarmed after settlement");
});

test("/hold while idle reports the session already stopped and arms nothing", async () => {
	const pi = bootHold({ idle: true });

	await pi.command();
	assert.ok(pi.notifications.some((n) => n.message.includes("already stopped")));

	// Nothing armed: events pass through untouched.
	assert.equal((await pi.emitInput("any message", "steer")).action, "continue");
	await pi.emitTurnEnd();
	await pi.emitAgentStart();
	await pi.emitAgentSettled();
	assert.equal(pi.aborts, 0);
	assert.ok(!pi.notifications.some((n) => n.message.includes("session stopped")));
});

test("repeat /hold while armed is a no-op", async () => {
	const pi = bootHold({ idle: false });

	await pi.command();
	await pi.command();
	assert.ok(pi.notifications.some((n) => n.message.includes("already armed")));
	assert.equal(pi.notifications.filter((n) => n.message.includes("Hold armed")).length, 1);
});
