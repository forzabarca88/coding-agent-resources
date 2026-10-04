/**
 * End-result tests for the eos-guard extension.
 *
 * Drives the real extension module with a fake pi event surface and asserts
 * the observable contract: the guard is INERT by default (no context
 * rewriting, no system-prompt change), activates only when the user opts in
 * via /eos-guard (or PI_EOS_GUARD=1), deactivates cleanly when toggled off,
 * publishes its resolved state to PI_EOS_GUARD_INHERIT so spawned subagent
 * processes inherit it, and does not leak a toggle across sessions. Run:
 *
 *   node --test extensions/eos-guard/tests/sanitize.test.mjs
 *   (Node >= 23.6 runs the .ts extension natively via type stripping)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import eosGuardExtension, { DEFAULT_PATTERNS } from "../index.ts";
import { sanitizeMessages } from "../sanitize.ts";

// The verbatim Qwen end-of-turn token, written here only via its defused
// lookalike so that this test file itself can never terminate a session
// that loads it. Tests reconstruct the ASCII form by swapping delimiters.
const DEFUSED_IM_END = "‹|im_end|›";
const IM_END = DEFUSED_IM_END.replace("‹", "<").replace("›", ">");

const ENV_VARS = ["PI_EOS_GUARD", "PI_EOS_GUARD_INHERIT", "PI_SUBAGENT_DEPTH"];

/**
 * Boot the extension against a fake pi runtime with a known env state.
 * `shellDefault` sets PI_EOS_GUARD, `directive` sets PI_EOS_GUARD_INHERIT,
 * `child` simulates a subagent process (PI_SUBAGENT_DEPTH=1, set by the
 * subagent extension at spawn). The prior env is restored via t.after().
 */
function bootEosGuard(t, { shellDefault, directive, child } = {}) {
	const saved = ENV_VARS.map((key) => [key, process.env[key]]);
	t.after(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	for (const key of ENV_VARS) delete process.env[key];
	if (shellDefault !== undefined) process.env.PI_EOS_GUARD = shellDefault;
	if (directive !== undefined) process.env.PI_EOS_GUARD_INHERIT = directive;
	if (child) process.env.PI_SUBAGENT_DEPTH = "1";

	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const statusCalls = [];

	eosGuardExtension({
		on: (type, handler) => handlers.set(type, handler),
		registerCommand: (name, definition) => commands.set(name, definition),
	});

	const ctx = {
		hasUI: true,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setStatus: (key, value) => statusCalls.push({ key, value }),
		},
	};

	const emit = async (type, event) => handlers.get(type)(event, ctx);

	return {
		emitSessionStart: () => emit("session_start", { type: "session_start", reason: "startup" }),
		emitBeforeAgentStart: (systemPrompt) =>
			emit("before_agent_start", { type: "before_agent_start", systemPrompt, images: [] }),
		emitContext: (messages) => emit("context", { type: "context", messages }),
		runCommand: async (args) => commands.get("eos-guard").handler(args, ctx),
		notifications,
		statusCalls,
	};
}

const tokenBearingContext = () => [
	{ role: "toolResult", content: [{ type: "text", text: `eos: ${IM_END}` }] },
];

test("pure defusing: tool output, thinking, and tool arguments are defused", () => {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `the vocab lists ${IM_END} at id 248046` },
				{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: `echo ${IM_END}` } },
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "tc1",
			content: [{ type: "text", text: `eos 248046: '${IM_END}'` }],
		},
	];

	const count = sanitizeMessages(messages, DEFAULT_PATTERNS);

	assert.equal(count, 3);
	assert.ok(!JSON.stringify(messages).includes(IM_END), "verbatim token must not survive");
	assert.equal(messages[1].content[0].text, `eos 248046: '${DEFUSED_IM_END}'`);
	assert.equal(messages[0].content[0].thinking, `the vocab lists ${DEFUSED_IM_END} at id 248046`);
	assert.equal(messages[0].content[1].arguments.command, `echo ${DEFUSED_IM_END}`);
});

test("pure defusing: other spellings are defused, ordinary text is untouched, idempotent", () => {
	const messages = [
		{
			role: "toolResult",
			content: [{
				type: "text",
				text: `markers: </s> and [INST] and <<SYS>> vs html <div>, math a < b, quote: ${IM_END}`,
			}],
		},
	];

	const count = sanitizeMessages(messages, DEFAULT_PATTERNS);
	const again = sanitizeMessages(messages, DEFAULT_PATTERNS);
	const out = messages[0].content[0].text;

	assert.equal(count, 4);
	assert.equal(again, 0, "defused lookalikes must not match again");
	assert.ok(out.includes("‹/s›") && out.includes("⟦INST⟧") && out.includes("‹‹SYS››"));
	assert.ok(out.includes("<div>") && out.includes("a < b"), "ordinary text must not be rewritten");
});

test("the guard is inert until the user opts in", async (t) => {
	const pi = bootEosGuard(t);
	await pi.emitSessionStart();
	const messages = tokenBearingContext();

	const promptResult = await pi.emitBeforeAgentStart("base prompt");
	const contextResult = await pi.emitContext(messages);

	assert.equal(promptResult, undefined);
	assert.equal(contextResult, undefined);
	assert.ok(JSON.stringify(messages).includes(IM_END), "context must pass through unmodified");
	assert.deepEqual(pi.notifications, []);
});

test("/eos-guard enables defusing, the system rule, and the subagent directive", async (t) => {
	const pi = bootEosGuard(t);
	await pi.emitSessionStart();

	await pi.runCommand("");
	const promptResult = await pi.emitBeforeAgentStart("base prompt");
	const contextResult = await pi.emitContext(tokenBearingContext());
	await pi.emitContext(tokenBearingContext()); // same run: no duplicate notify

	assert.ok(pi.statusCalls.some((s) => s.key === "eos-guard" && s.value === "eos-guard: on"));
	assert.ok(pi.notifications.some((n) => n.message.includes("ON")));
	assert.ok(promptResult.systemPrompt.startsWith("base prompt"));
	assert.ok(promptResult.systemPrompt.includes("Special-token output guard"));
	assert.ok(JSON.stringify(contextResult.messages).includes(DEFUSED_IM_END));
	assert.ok(!JSON.stringify(contextResult.messages).includes(IM_END));
	assert.equal(
		pi.notifications.filter((n) => n.message.startsWith("eos-guard: defused")).length,
		1,
		"one sanitization notification per run",
	);
	assert.equal(
		process.env.PI_EOS_GUARD_INHERIT,
		"1",
		"enabled state must be published for subagent spawns",
	);
});

test("/eos-guard off restores passthrough and publishes the off directive", async (t) => {
	const pi = bootEosGuard(t);
	await pi.emitSessionStart();
	await pi.runCommand("on");

	await pi.runCommand("off");
	const contextResult = await pi.emitContext(tokenBearingContext());
	const promptResult = await pi.emitBeforeAgentStart("base prompt");

	assert.ok(pi.statusCalls.some((s) => s.key === "eos-guard" && s.value === undefined));
	assert.ok(pi.notifications.some((n) => n.message.includes("OFF")));
	assert.equal(contextResult, undefined);
	assert.equal(promptResult, undefined);
	assert.ok(JSON.stringify(tokenBearingContext()).includes(IM_END));
	assert.equal(process.env.PI_EOS_GUARD_INHERIT, "0");
});

test("explicit on/off arguments control the state; bad arguments change nothing", async (t) => {
	const pi = bootEosGuard(t);
	await pi.emitSessionStart();

	await pi.runCommand("off");
	const offResult = await pi.emitContext(tokenBearingContext());
	assert.equal(offResult, undefined);

	await pi.runCommand("on");
	const onResult = await pi.emitContext(tokenBearingContext());
	assert.ok(onResult.messages);

	const notificationsBefore = pi.notifications.length;
	await pi.runCommand("bogus");
	assert.equal(pi.notifications.length, notificationsBefore + 1, "bad arg warns");
	const stillOn = await pi.emitContext(tokenBearingContext());
	assert.ok(stillOn.messages, "bad arg must not change state");
});

test("PI_EOS_GUARD=1 makes top-level sessions default to enabled", async (t) => {
	const pi = bootEosGuard(t, { shellDefault: "1" });
	await pi.emitSessionStart();
	const contextResult = await pi.emitContext(tokenBearingContext());

	assert.ok(contextResult.messages, "env default must activate the guard without a toggle");
	assert.ok(!JSON.stringify(contextResult.messages).includes(IM_END));
	assert.equal(process.env.PI_EOS_GUARD_INHERIT, "1", "default-on must reach subagents too");
});

test("subagent sessions inherit the parent session's enabled state", async (t) => {
	// A spawned subagent process boots with the parent's directive; no
	// interactive toggle ever runs there.
	const pi = bootEosGuard(t, { directive: "1", child: true });
	await pi.emitSessionStart();
	const contextResult = await pi.emitContext(tokenBearingContext());
	const promptResult = await pi.emitBeforeAgentStart("base prompt");

	assert.ok(contextResult.messages, "inherited directive must activate the guard");
	assert.ok(!JSON.stringify(contextResult.messages).includes(IM_END));
	assert.ok(promptResult.systemPrompt.includes("Special-token output guard"));
});

test("a parent-off directive wins over the shell default in subagents", async (t) => {
	// Shell says on (PI_EOS_GUARD=1) but the spawning session resolved to
	// off — the explicit parent decision must govern the child.
	const pi = bootEosGuard(t, { shellDefault: "1", directive: "0", child: true });
	await pi.emitSessionStart();
	const contextResult = await pi.emitContext(tokenBearingContext());

	assert.equal(contextResult, undefined, "parent-off must disable the guard in subagents");
});

test("a top-level toggle does not leak into the next session", async (t) => {
	const pi = bootEosGuard(t);
	await pi.emitSessionStart();
	await pi.runCommand("on"); // publishes directive "1"

	// /new rebinds extensions in the same process: session_start resets the
	// instance to its resolved default and re-publishes the directive.
	await pi.emitSessionStart();
	const contextResult = await pi.emitContext(tokenBearingContext());

	assert.equal(contextResult, undefined, "the toggle must stay session-scoped");
	assert.equal(
		process.env.PI_EOS_GUARD_INHERIT,
		"0",
		"subagents of the new session must see the new session's state",
	);
});
