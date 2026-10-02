/**
 * Rendering tests for the subagent tool's result view.
 *
 * Contract: the expanded view shows every step in full (complete commands and
 * tool arguments) so runs can be debugged, while the collapsed view keeps
 * compact one-line previews.
 *
 * Run: node --test extensions/subagent/tests/render.test.mjs
 * (requires a repo node_modules/ linked to the global pi install's node_modules)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const { default: subagentExtension } = await import("../index.ts");

const theme = { fg: (_color, text) => text, bold: (text) => text };

const LONG_COMMAND =
        'grep -n "build_recurrent_attn|build_conv_state|build_gdn_l2_norm|gated_delta_net" /tmp/llama-ref/delta-net-base.cpp /tmp/llama-ref/ops.cpp | grep -v Binary | head -40';
const LONG_ARGS = { path: "/tmp/llama-ref", pattern: "*.gguf", extra: "x".repeat(80) };

function getTool() {
        return new Promise((resolve) => {
                subagentExtension({ registerTool: (t) => resolve(t) });
        });
}

function flatten(component) {
        if (typeof component.text === "string") return component.text;
        if (Array.isArray(component.children)) return component.children.map(flatten).join("\n");
        return "";
}

function makeSingleResult(messages) {
        return {
                agent: "worker",
                agentSource: "user",
                task: "Do the task",
                exitCode: 0,
                messages,
                stderr: "",
                usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        cost: 0,
                        contextTokens: 0,
                        turns: 0,
                        lastInput: 0,
                        lastOutput: 0,
                        lastCacheRead: 0,
                        lastCacheWrite: 0,
                },
                compactions: 0,
                networkResumes: 0,
        };
}

function makeResult(mode, results) {
        return {
                content: [{ type: "text", text: "done" }],
                details: { mode, agentScope: "user", projectAgentsDir: null, results },
        };
}

const TOOL_CALL_MESSAGES = [
        {
                role: "assistant",
                content: [
                        { type: "toolCall", name: "bash", arguments: { command: LONG_COMMAND } },
                        { type: "toolCall", name: "some_custom_tool", arguments: LONG_ARGS },
                ],
        },
];

test("expanded view shows each step without truncation", async () => {
        const tool = await getTool();
        for (const [mode, results] of [
                ["single", [makeSingleResult(TOOL_CALL_MESSAGES)]],
                ["chain", [{ ...makeSingleResult(TOOL_CALL_MESSAGES), step: 1 }]],
                ["parallel", [makeSingleResult(TOOL_CALL_MESSAGES)]],
        ]) {
                const out = flatten(tool.renderResult(makeResult(mode, results), { expanded: true }, theme, {}));
                assert.ok(out.includes(LONG_COMMAND), `${mode}: full command must be shown:\n${out}`);
                assert.ok(out.includes(JSON.stringify(LONG_ARGS)), `${mode}: full arguments must be shown:\n${out}`);
        }
});

test("collapsed view keeps one-line previews", async () => {
        const tool = await getTool();
        const out = flatten(tool.renderResult(makeResult("single", [makeSingleResult(TOOL_CALL_MESSAGES)]), { expanded: false }, theme, {}));
        assert.ok(out.includes(`${LONG_COMMAND.slice(0, 60)}...`), `command preview expected:\n${out}`);
        assert.ok(!out.includes(LONG_COMMAND), `full command must not be shown:\n${out}`);
});