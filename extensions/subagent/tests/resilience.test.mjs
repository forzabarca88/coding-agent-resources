/**
 * End-to-end network-resilience tests for the subagent extension.
 *
 * This file doubles as a fake `pi` executable: the extension spawns child pi
 * processes by re-running process.argv[1] with `--mode json -p ...`, so when
 * this file is launched that way it emulates pi's JSON-mode behaviour —
 * session persistence (a JSONL file that accumulates user messages across
 * runs, like real pi), transient provider failures ("fetch failed"), and
 * permanent failures ("Invalid API key provided"). The child exits 0 even on
 * provider errors, matching real pi's JSON-mode exit semantics.
 *
 * Child behaviour is steered via env (inherited from the test process):
 *   FAKE_PI_RUN_COUNTER               file; one line appended per child run
 *   FAKE_PI_TRANSIENT_FAILURES        number of runs to fail with a transient error frame
 *   FAKE_PI_PERMANENT_FAILURE=1       fail every run with a non-retryable error frame
 *   FAKE_PI_CRASH_AFTER_RUNS=N        runs > N die with no frames/output (exit 1,
 *                                     stderr "boom: ...") — a crash *during* resumption
 *   FAKE_PI_DIE_BEFORE_PERSIST_RUNS=N runs <= N die with a transient stderr signature
 *                                     before persisting anything (no session file)
 *   FAKE_PI_RUN_DELAY_MS              artificial per-run latency (default 20)
 *
 * Run: node --test extensions/subagent/tests/resilience.test.mjs
 * (requires a repo node_modules/ linked to the global pi install's node_modules)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test, before, after } from "node:test";

// ---------------------------------------------------------------------------
// Fake pi child process — only active when this file is spawned with --mode
// ---------------------------------------------------------------------------

const childArgs = process.argv.slice(2);
if (childArgs[0] === "--mode") {
        process.exitCode = await runFakePi(childArgs);
        // Flush pending output before exiting: process.exit would otherwise
        // truncate async pipe writes (risking the final JSON frames).
        await new Promise((resolve) => process.stdout.write("", resolve));
        await new Promise((resolve) => process.stderr.write("", resolve));
        process.exit(process.exitCode);
}

// Fake pi exit code: 0 normally (real pi's JSON mode exits 0 even on provider
// errors), 1 when emulating a child crash.

async function runFakePi(args) {
        const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
        const sessionPath = args[args.indexOf("--session") + 1];
        const prompt = args[args.length - 1];
        const cwd = process.cwd();

        const counterFile = process.env.FAKE_PI_RUN_COUNTER;
        if (counterFile) fs.appendFileSync(counterFile, "1\n");
        const runCount = counterFile ? fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length : 1;

        // Crash modes: die with no frames and no session persistence, like a
        // killed process (OOM) or pi failing to start the (resumed) session.
        const crashAfterRuns = Number.parseInt(process.env.FAKE_PI_CRASH_AFTER_RUNS ?? "0", 10);
        const dieBeforePersistRuns = Number.parseInt(process.env.FAKE_PI_DIE_BEFORE_PERSIST_RUNS ?? "0", 10);
        if (crashAfterRuns > 0 && runCount > crashAfterRuns) {
                process.stderr.write("boom: simulated crash during resumption\n");
                return 1;
        }
        if (dieBeforePersistRuns > 0 && runCount <= dieBeforePersistRuns) {
                process.stderr.write("fetch failed (process killed before persisting the session)\n");
                return 1;
        }

        const sessionId = "00000000-0000-0000-0000-fakesession001";
        const isNewSession = !fs.existsSync(sessionPath);
        let userMessageCount = 1; // this run's prompt
        if (!isNewSession) {
                for (const line of fs.readFileSync(sessionPath, "utf8").split("\n")) {
                        if (!line.trim()) continue;
                        const entry = JSON.parse(line);
                        if (entry.type === "message" && entry.message?.role === "user") userMessageCount++;
                }
        }

        if (isNewSession) {
                fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
        }
        const userMessage = { role: "user", content: [{ type: "text", text: prompt }] };
        fs.appendFileSync(sessionPath, `${JSON.stringify({ type: "message", message: userMessage })}\n`);

        out({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd });

        const transientFailures = Number.parseInt(process.env.FAKE_PI_TRANSIENT_FAILURES ?? "0", 10);
        const permanentFailure = process.env.FAKE_PI_PERMANENT_FAILURE === "1";
        const fail = permanentFailure || runCount <= transientFailures;
        const errorMessage = permanentFailure ? "Invalid API key provided" : "fetch failed";
        const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } };
        const assistantMessage = fail
                ? { role: "assistant", content: [], api: "openai-completions", provider: "fake", model: "fake-model", usage, stopReason: "error", errorMessage }
                : {
                        role: "assistant",
                        content: [{ type: "text", text: `done: saw ${userMessageCount} user message(s) in the session` }],
                        api: "openai-completions",
                        provider: "fake",
                        model: "fake-model",
                        usage,
                        stopReason: "stop",
                };

        const runDelayMs = Number.parseInt(process.env.FAKE_PI_RUN_DELAY_MS ?? "20", 10);
        await new Promise((resolve) => setTimeout(resolve, runDelayMs));
        out({ type: "agent_start" });
        out({ type: "turn_start" });
        out({ type: "message_start", message: userMessage });
        out({ type: "message_end", message: userMessage });
        out({ type: "message_start", message: assistantMessage });
        out({ type: "message_end", message: assistantMessage });
        out({ type: "turn_end", message: assistantMessage, toolResults: [] });
        out({ type: "agent_end", messages: [userMessage, assistantMessage] });
        return 0;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const { default: subagentExtension } = await import("../index.ts");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-resilience-test-"));
let agentDir;
let workDir;
let counterFile;
const savedEnv = [];

function setEnv(key, value) {
        savedEnv.push([key, process.env[key]]);
        process.env[key] = value;
}

function restoreEnv() {
        while (savedEnv.length) {
                const [key, prev] = savedEnv.pop();
                if (prev === undefined) delete process.env[key];
                else process.env[key] = prev;
        }
}

function countRuns() {
        return fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean).length;
}

async function invokeTool({ signal, updates } = {}) {
        const tool = await new Promise((resolve) => {
                subagentExtension({ registerTool: (t) => resolve(t) });
        });
        return tool.execute(
                "test-call",
                { agent: "fake-worker", task: "Do the fake task" },
                signal,
                (partial) => updates?.push(partial),
                { cwd: workDir, model: { provider: "fake", id: "fake-model" }, hasUI: false },
        );
}

before(() => {
        agentDir = fs.mkdtempSync(path.join(tmpRoot, "agents-"));
        fs.mkdirSync(path.join(agentDir, "agents"));
        fs.writeFileSync(
                path.join(agentDir, "agents", "fake-worker.md"),
                "---\nname: fake-worker\ndescription: Fake agent used by the resilience tests\n---\nYou are a fake worker agent.\n",
        );
        workDir = fs.mkdtempSync(path.join(tmpRoot, "cwd-"));
});

after(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("completes a normal run through the persistent-session path", async () => {
        counterFile = path.join(tmpRoot, "counter-normal");
        setEnv("PI_CODING_AGENT_DIR", agentDir);
        setEnv("FAKE_PI_RUN_COUNTER", counterFile);
        try {
                const result = await invokeTool();
                assert.equal(result.isError, undefined);
                assert.match(result.content[0].text, /done: saw 1 user message\(s\)/);
                assert.equal(result.details.results[0].stopReason, "stop");
                assert.equal(result.details.results[0].networkResumes, 0);
                assert.equal(countRuns(), 1);
        } finally {
                restoreEnv();
        }
});

test("survives transient network failures by resuming the session", async () => {
        counterFile = path.join(tmpRoot, "counter-transient");
        setEnv("PI_CODING_AGENT_DIR", agentDir);
        setEnv("FAKE_PI_RUN_COUNTER", counterFile);
        setEnv("FAKE_PI_TRANSIENT_FAILURES", "2");
        setEnv("PI_SUBAGENT_RETRY_BASE_MS", "50");
        setEnv("PI_SUBAGENT_RETRY_MAX_DELAY_MS", "150");
        setEnv("PI_SUBAGENT_RETRY_MAX_RESUMES", "5");
        const updates = [];
        try {
                const result = await invokeTool({ updates });
                // The invocation as a whole succeeded, and the final answer came
                // from a run that could see the original task plus both
                // continuation prompts — i.e. the session was actually resumed.
                assert.equal(result.isError, undefined);
                assert.match(result.content[0].text, /done: saw 3 user message\(s\)/);
                const r = result.details.results[0];
                assert.equal(r.stopReason, "stop");
                assert.equal(r.networkResumes, 2);
                const assistant = r.messages.filter((m) => m.role === "assistant");
                assert.deepEqual(assistant.map((m) => m.stopReason), ["error", "error", "stop"]);
                assert.equal(countRuns(), 3);
                // A live status update was surfaced while waiting for the provider.
                assert.ok(updates.some((u) => (u.content[0]?.text ?? "").includes("before resuming")));
        } finally {
                restoreEnv();
        }
});

test("does not resume on permanent (non-retryable) errors", async () => {
        counterFile = path.join(tmpRoot, "counter-permanent");
        setEnv("PI_CODING_AGENT_DIR", agentDir);
        setEnv("FAKE_PI_RUN_COUNTER", counterFile);
        setEnv("FAKE_PI_PERMANENT_FAILURE", "1");
        try {
                const result = await invokeTool();
                assert.equal(result.isError, true);
                assert.match(result.content[0].text, /Invalid API key/);
                assert.equal(countRuns(), 1);
        } finally {
                restoreEnv();
        }
});

test("does not resume again when a resumed run crashes without frames", async () => {
        counterFile = path.join(tmpRoot, "counter-crash");
        setEnv("PI_CODING_AGENT_DIR", agentDir);
        setEnv("FAKE_PI_RUN_COUNTER", counterFile);
        setEnv("FAKE_PI_TRANSIENT_FAILURES", "1");
        setEnv("FAKE_PI_CRASH_AFTER_RUNS", "1");
        setEnv("PI_SUBAGENT_RETRY_BASE_MS", "50");
        try {
                const result = await invokeTool();
                // Run 1 fails transiently (error frame), run 2 crashes without
                // emitting frames. The stale first-run error frame must not
                // trigger another resume, and the surfaced error must be the
                // crash itself, not the stale frame error.
                assert.equal(result.isError, true);
                assert.match(result.content[0].text, /boom: simulated crash/);
                const r = result.details.results[0];
                assert.equal(r.networkResumes, 1);
                assert.equal(countRuns(), 2);
        } finally {
                restoreEnv();
        }
});

test("reruns the original task when the session was never persisted", async () => {
        counterFile = path.join(tmpRoot, "counter-nopersist");
        setEnv("PI_CODING_AGENT_DIR", agentDir);
        setEnv("FAKE_PI_RUN_COUNTER", counterFile);
        setEnv("FAKE_PI_DIE_BEFORE_PERSIST_RUNS", "1");
        setEnv("PI_SUBAGENT_RETRY_BASE_MS", "50");
        try {
                const result = await invokeTool();
                assert.equal(result.isError, undefined);
                // Run 1 died before creating the session file, so the resume
                // reruns the original task in a fresh session (1 user message)
                // instead of a continuation prompt (which would see 2).
                assert.match(result.content[0].text, /done: saw 1 user message\(s\)/);
                const r = result.details.results[0];
                assert.equal(r.stopReason, "stop");
                assert.equal(r.networkResumes, 1);
                assert.equal(countRuns(), 2);
        } finally {
                restoreEnv();
        }
});

test("aborts while waiting out a transient failure", async () => {
        counterFile = path.join(tmpRoot, "counter-abort");
        setEnv("PI_CODING_AGENT_DIR", agentDir);
        setEnv("FAKE_PI_RUN_COUNTER", counterFile);
        setEnv("FAKE_PI_TRANSIENT_FAILURES", "99");
        setEnv("PI_SUBAGENT_RETRY_BASE_MS", "800");
        setEnv("FAKE_PI_RUN_DELAY_MS", "50");
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 300);
        try {
                await assert.rejects(invokeTool({ signal: ac.signal }), /Subagent was aborted/);
                // No second run was started after the abort.
                assert.equal(countRuns(), 1);
        } finally {
                clearTimeout(timer);
                restoreEnv();
        }
});
