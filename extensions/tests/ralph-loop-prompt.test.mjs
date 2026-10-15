/**
 * End-result tests for the ralph-loop-prompt extension.
 *
 * Drives the real extension module with a fake pi event surface and asserts
 * the observable contract: invoking /ralph-loop arms the pin, the pinned
 * section carries the template body verbatim (frontmatter stripped) while
 * every other section and the append-only contract stay untouched, ordinary
 * input and the /ralph-loop-prompt command text never arm it, a missing
 * template warns instead of arming, and edits to the template apply on the
 * next pinned run. Run:
 *
 *   node --test extensions/tests/ralph-loop-prompt.test.mjs
 *   (Node >= 23.6 runs the .ts extension natively via type stripping)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ralphLoopPrompt, { SECTION_NAME, stripFrontmatter } from "../ralph-loop-prompt.ts";

const FIXTURE = `---
description: "Test loop template"
argument-hint: "<REQ>"
---

## Your Goal

You are the **orchestrator**.

Delegate all work via subagent calls, framing each task as:

$@
`;

/**
 * Boot the extension against a fake pi runtime. `template` writes a fixture
 * file and points PI_RALPH_LOOP_PROMPT at it; `null` points the override at
 * a nonexistent path; `undefined` deletes the override so the default
 * module-relative resolution (the real prompts/ralph-loop.md) is exercised.
 * The prior env is restored via t.after().
 */
function bootRalphLoopPrompt(t, { template } = {}) {
	const saved = process.env.PI_RALPH_LOOP_PROMPT;
	t.after(() => {
		if (saved === undefined) delete process.env.PI_RALPH_LOOP_PROMPT;
		else process.env.PI_RALPH_LOOP_PROMPT = saved;
	});

	let templatePath;
	if (template === undefined) {
		delete process.env.PI_RALPH_LOOP_PROMPT;
	} else {
		templatePath = join(mkdtempSync(join(tmpdir(), "ralph-loop-prompt-")), "ralph-loop.md");
		if (template !== null) writeFileSync(templatePath, template);
		process.env.PI_RALPH_LOOP_PROMPT = templatePath;
	}

	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const statusCalls = [];

	ralphLoopPrompt({
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

	const emit = (type, event) => handlers.get(type)(event, ctx);

	return {
		templatePath,
		emitInput: (text) => emit("input", { type: "input", text, source: "interactive" }),
		emitBeforeAgentStart: async (sections = { preamble: "base prompt", rules: "base rules" }) => {
			const event = {
				type: "before_agent_start",
				prompt: "user text",
				images: [],
				systemPromptOptions: { sections: { ...sections } },
			};
			const result = await emit("before_agent_start", event);
			return { result, sections: event.systemPromptOptions.sections };
		},
		runCommand: (args) => commands.get("ralph-loop-prompt").handler(args, ctx),
		notifications,
		statusCalls,
	};
}

test("invoking /ralph-loop pins the protocol verbatim into a dedicated section, append-only", async (t) => {
	const rlp = bootRalphLoopPrompt(t, { template: FIXTURE });

	// Before invocation: inert — no section added, no prompt override returned.
	const before = await rlp.emitBeforeAgentStart();
	assert.equal(before.result, undefined);
	assert.equal(before.sections[SECTION_NAME], undefined);

	// Invoke the template, then run the loop's first turn.
	await rlp.emitInput("/ralph-loop Implement feature X");
	const { result, sections } = await rlp.emitBeforeAgentStart();

	// Append-only contract: the handler returns undefined (pi implements a
	// returned systemPrompt as forceSystemPrompt, a whole-prompt replacement).
	assert.equal(result, undefined);
	// Existing sections are untouched.
	assert.equal(sections.preamble, "base prompt");
	assert.equal(sections.rules, "base rules");
	// The pinned body is the template content verbatim, minus frontmatter.
	const pinned = sections[SECTION_NAME];
	assert.ok(pinned.includes("You are the **orchestrator**."));
	assert.ok(pinned.includes("framing each task as:\n\n$@"));
	assert.ok(!pinned.includes("argument-hint"), "frontmatter must not reach the system prompt");
});

test("ordinary input and the command's own name never arm the pin; the toggle does", async (t) => {
	const rlp = bootRalphLoopPrompt(t, { template: FIXTURE });

	// Mid-sentence mention and the extension command's own name (which pi
	// handles before the input event ever sees it) must not arm the pin.
	await rlp.emitInput("how does /ralph-loop work?");
	await rlp.emitInput("/ralph-loop-prompt on");
	assert.equal((await rlp.emitBeforeAgentStart()).sections[SECTION_NAME], undefined);

	// The explicit toggle arms and disarms.
	await rlp.runCommand("on");
	assert.ok((await rlp.emitBeforeAgentStart()).sections[SECTION_NAME]);
	await rlp.runCommand("off");
	assert.equal((await rlp.emitBeforeAgentStart()).sections[SECTION_NAME], undefined);
});

test("a missing template warns on invocation and leaves the session unpinned", async (t) => {
	const rlp = bootRalphLoopPrompt(t, { template: null });

	await rlp.emitInput("/ralph-loop Implement feature X");
	assert.ok(rlp.notifications.some((n) => n.level === "warning" && n.message.includes("not found")));
	assert.equal((await rlp.emitBeforeAgentStart()).sections[SECTION_NAME], undefined);
});

test("the default template path resolves to the real prompts/ralph-loop.md", async (t) => {
	const rlp = bootRalphLoopPrompt(t);

	await rlp.emitInput("/ralph-loop Implement feature X");
	const { sections } = await rlp.emitBeforeAgentStart();

	const real = readFileSync(new URL("../../prompts/ralph-loop.md", import.meta.url), "utf8");
	const body = stripFrontmatter(real).trim();
	assert.ok(sections[SECTION_NAME].endsWith(body), "pinned content must be the real template verbatim");
	assert.ok(body.includes("RALPH: Reconnaissance-Act-Loop-Plan-Home"));
	assert.ok(!sections[SECTION_NAME].includes("argument-hint"));
});

test("edits to the template apply on the next pinned run", async (t) => {
	const rlp = bootRalphLoopPrompt(t, { template: FIXTURE });
	await rlp.emitInput("/ralph-loop Implement feature X");
	assert.ok((await rlp.emitBeforeAgentStart()).sections[SECTION_NAME].includes("orchestrator"));

	writeFileSync(rlp.templatePath, "## Revised protocol\n");
	const { sections } = await rlp.emitBeforeAgentStart();
	assert.ok(sections[SECTION_NAME].includes("Revised protocol"));
	assert.ok(!sections[SECTION_NAME].includes("orchestrator"));
});
