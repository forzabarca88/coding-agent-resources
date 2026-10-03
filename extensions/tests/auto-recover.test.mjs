/**
 * End-result tests for the auto-recover extension.
 *
 * Drives the real extension module with a fake pi event surface and asserts
 * the observable contract: recovery is queued ONLY for real interrupted
 * attempts (model misbehaviour), never for explicit aborts. Explicit aborts
 * are stopReason "aborted" AND abort-shaped error messages — pi-ai classifies
 * an already-aborted run (ESC, /hold) as stopReason "error" with the abort
 * reason as errorMessage, and recovering from that would re-run the session
 * against the user's will.
 *
 * Run: node --test extensions/tests/auto-recover.test.mjs
 * (Node >= 23.6 runs the .ts extension natively via type stripping)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import autoRecoverExtension from "../auto-recover.ts";

const EMPTY_TURN_MESSAGE = "Your previous turn was empty. Continue with the pending work.";
const EOS_CUT_MESSAGE = "Your previous turn ended after thinking only, with no visible output or tool call — it was most likely cut off by a special-token stop sequence. Continue exactly where you left off. Refer to special tokens by name or id only; never write them verbatim.";

/** Build a fake pi runtime around the extension; returns a handle to drive it. */
function bootAutoRecover(branch) {
	const handlers = new Map();
	const sent = [];
	const notifications = [];

	autoRecoverExtension({
		on: (type, handler) => handlers.set(type, handler),
		sendUserMessage: (message, options) => sent.push({ message, options }),
	});

	const ctx = {
		hasUI: true,
		ui: { notify: (message, level) => notifications.push({ message, level }) },
		sessionManager: { getBranch: () => branch },
	};

	const emit = (type, event) => handlers.get(type)(event ?? { type }, ctx);

	return {
		emitAgentStart: () => emit("agent_start", { type: "agent_start" }),
		emitAgentEnd: (messages) => emit("agent_end", { type: "agent_end", messages }),
		emitAgentSettled: () => emit("agent_settled", { type: "agent_settled" }),
		sent,
		notifications,
	};
}

/**
 * A run whose final assistant message is an EMPTY completion directly after a
 * tool result — auto-recover's "empty-turn" interrupted-attempt shape.
 */
function runEndingWith(finalMessage) {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "tc1", name: "subagent", arguments: {} }],
			stopReason: "toolUse",
		},
		{ role: "toolResult", toolCallId: "tc1", name: "subagent", content: [{ type: "text", text: "done" }] },
		finalMessage,
	];
}

const branchFor = (messages) => messages.map((message) => ({ type: "message", message }));

test("an abort that pi surfaced as an error stop is never recovered", async () => {
	// The /hold abort artifact: pi-ai's provider setup phase classifies an
	// already-aborted run as stopReason "error" with signal.reason as the
	// errorMessage (see the empty completion after a tool result here).
	const messages = runEndingWith({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "This operation was aborted",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);
	await pi.emitAgentSettled();

	assert.deepEqual(pi.sent, [], "explicit abort must not be re-run");
	assert.ok(
		pi.notifications.every((n) => !n.message.includes("Auto-recovering")),
		"explicit abort must not be reported as an interrupted attempt",
	);
});

test("an aborted stop is never recovered", async () => {
	const messages = runEndingWith({
		role: "assistant",
		content: [],
		stopReason: "aborted",
		errorMessage: "Operation aborted",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);
	await pi.emitAgentSettled();

	assert.deepEqual(pi.sent, []);
});

test("a real provider failure blank completion is still recovered", async () => {
	const messages = runEndingWith({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "Model unloaded by user or API request.",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);
	// Error stops are deferred at agent_end so pi's own auto-retry can
	// resolve the turn first.
	assert.deepEqual(pi.sent, [], "error stops must wait for pi's retry before recovery");

	await pi.emitAgentSettled();
	assert.equal(pi.sent.length, 1, "unresolved error run must be recovered at settlement");
	assert.equal(pi.sent[0].message, EMPTY_TURN_MESSAGE);
	assert.equal(pi.sent[0].options.deliverAs, "followUp");
});

test("a timeout abort is a real failure and is still recovered", async () => {
	// AbortSignal.timeout's abort reason literally reads "The operation was
	// aborted due to timeout"; it must not be mistaken for an explicit abort.
	const messages = runEndingWith({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "The operation was aborted due to timeout",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);
	assert.deepEqual(pi.sent, [], "error stops must wait for pi's retry before recovery");

	await pi.emitAgentSettled();
	assert.equal(pi.sent.length, 1, "timeouts are real failures and must be recovered");
});

test("a thinking-only turn cut by an EOS stop is recovered with the eos-cut message", async () => {
	// Server-side EOS cut signature (observed against LM Studio/qwen GGUF
	// work): the model emitted a chat-template special token as literal text
	// mid-thinking, the server consumed it as EOS and stripped it, and pi
	// recorded a "stop" turn whose content is thinking only.
	const messages = runEndingWith({
		role: "assistant",
		content: [{ type: "thinking", thinking: "Also note: token[248046] = '" }],
		stopReason: "stop",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);

	assert.equal(pi.sent.length, 1, "thinking-only stop turn must be recovered at agent_end");
	assert.equal(pi.sent[0].message, EOS_CUT_MESSAGE);
	assert.equal(pi.sent[0].options.deliverAs, "followUp");
});

test("a thinking-only turn cut by max tokens is recovered", async () => {
	const messages = runEndingWith({
		role: "assistant",
		content: [{ type: "thinking", thinking: "Let me verify the merge order..." }],
		stopReason: "length",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);

	assert.equal(pi.sent.length, 1, "thinking-only length stop is the same degenerate shape");
	assert.equal(pi.sent[0].message, EOS_CUT_MESSAGE);
});

test("a turn with thinking AND text ending in a normal stop is never recovered", async () => {
	// A healthy final answer must not be mistaken for a cut turn.
	const messages = runEndingWith({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Done, wrapping up." },
			{ type: "text", text: "Task 6 complete." },
		],
		stopReason: "stop",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);
	await pi.emitAgentSettled();

	assert.deepEqual(pi.sent, []);
});

test("an aborted thinking-only turn is never recovered", async () => {
	const messages = runEndingWith({
		role: "assistant",
		content: [{ type: "thinking", thinking: "working..." }],
		stopReason: "aborted",
	});
	const pi = bootAutoRecover(branchFor(messages));

	await pi.emitAgentStart();
	await pi.emitAgentEnd(messages);
	await pi.emitAgentSettled();

	assert.deepEqual(pi.sent, []);
});
