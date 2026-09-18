/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Network resilience: each invocation runs in a private persistent session
 * file. If a run ends with a transient provider/network error (classified with
 * pi's own isRetryableAssistantError), the session is resumed after an
 * exponential-backoff wait (10s..2m per wait, up to 100 resumes by default),
 * so an invocation survives arbitrarily long network outages without losing
 * progress. See the "Network resilience" blocks in this file.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { isRetryableAssistantError, StringEnum } from "@earendil-works/pi-ai";
import {
        CONFIG_DIR_NAME,
        type ExtensionAPI,
        getAgentDir,
        getMarkdownTheme,
        withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const LIVE_TAIL_LINES = 15;
const LIVE_THROTTLE_MS = 80;

// Network-resilience defaults (overridable per invocation via the
// PI_SUBAGENT_RETRY_* env vars; see the "Network resilience" block below).
const RETRY_BASE_MS_DEFAULT = 10_000;
const RETRY_MAX_DELAY_MS_DEFAULT = 120_000;
const RETRY_MAX_RESUMES_DEFAULT = 100;

/**
 * Network resilience (consumed by runSingleAgent's resume loop).
 *
 * A subagent child process only tolerates transient provider/network errors
 * for as long as pi's own in-process retry budget lasts (3 attempts with ~14s
 * of backoff by default). A longer outage makes the child exit with an error.
 * Because every invocation runs in a private persistent session file
 * (`--session <file>`, not `--no-session`), the extension resumes the same
 * conversation after an exponential-backoff wait (base 10s, doubling, capped
 * at 2m per wait, up to 100 resumes by default ≈ several hours of backoff).
 * With the defaults, a full 15-minute outage costs only ~11 resumes.
 *
 * Env overrides (read per invocation, so they can also be tuned per test):
 *   PI_SUBAGENT_RETRY_BASE_MS       base wait before the first resume (default 10000)
 *   PI_SUBAGENT_RETRY_MAX_DELAY_MS  cap for per-wait backoff (default 120000)
 *   PI_SUBAGENT_RETRY_MAX_RESUMES   max resumes per invocation (default 100; 0 disables resumption)
 */

/**
 * Recursion guard for nested subagents.
 *
 * Each spawned subagent process inherits `PI_SUBAGENT_DEPTH` incremented by
 * one. A process whose depth is >= MAX_SUBAGENT_DEPTH does not register the
 * `subagent` tool at all, so it is structurally impossible for a subagent to
 * spawn its own subagents. With MAX_SUBAGENT_DEPTH = 1 the subagent tree is
 * capped at exactly one level: the top-level agent (depth 0) may spawn
 * subagents (depth 1), but those subagents have no `subagent` tool available.
 */
const MAX_SUBAGENT_DEPTH = 1;
const SUBAGENT_DEPTH = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;

function formatTokens(count: number): string {
        if (count < 1000) return count.toString();
        if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
        if (count < 1000000) return `${Math.round(count / 1000)}k`;
        return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const mins = Math.floor(ms / 60000);
        const secs = Math.round((ms % 60000) / 1000);
        return `${mins}m ${secs}s`;
}

function formatCompactions(count: number): string {
        return `${count} compaction${count === 1 ? "" : "s"}`;
}

function formatNetworkResumes(count: number): string {
        return `${count} network resume${count === 1 ? "" : "s"}`;
}

/**
 * Assembles the summary line for a subagent session: usage stats, then the
 * session duration followed immediately by the compaction count. Sessions
 * that are still running (or were never completed) have no `durationMs`, so
 * only the usage stats render until the session finishes.
 */
function formatResultMeta(r: SingleResult): string {
        const parts: string[] = [];
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) parts.push(usageStr);
        if (r.durationMs) {
                parts.push(formatDuration(r.durationMs));
                if (r.compactions > 0) parts.push(formatCompactions(r.compactions));
                if (r.networkResumes > 0) parts.push(formatNetworkResumes(r.networkResumes));
        }
        return parts.join(" · ");
}

function formatUsageStats(
        usage: {
                input: number;
                output: number;
                cacheRead: number;
                cacheWrite: number;
                cost: number;
                contextTokens?: number;
                turns?: number;
                lastInput?: number;
                lastOutput?: number;
                lastCacheRead?: number;
                lastCacheWrite?: number;
        },
        model?: string,
): string {
        const parts: string[] = [];
        if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
        if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
        if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
        if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
        if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
        if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
        const hasLast = (usage.lastInput ?? 0) > 0 || (usage.lastOutput ?? 0) > 0 || (usage.lastCacheRead ?? 0) > 0 || (usage.lastCacheWrite ?? 0) > 0;
        if (hasLast) {
                const lastParts: string[] = [];
                if (usage.lastInput) lastParts.push(`↑${formatTokens(usage.lastInput)}`);
                if (usage.lastOutput) lastParts.push(`↓${formatTokens(usage.lastOutput)}`);
                if (usage.lastCacheRead) lastParts.push(`R${formatTokens(usage.lastCacheRead)}`);
                if (usage.lastCacheWrite) lastParts.push(`W${formatTokens(usage.lastCacheWrite)}`);
                parts.push(`[${lastParts.join(" ")}]`);
        }
        if (usage.contextTokens && usage.contextTokens > 0) {
                parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
        }
        if (model) parts.push(model);
        return parts.join(" ");
}

function formatToolCall(
        toolName: string,
        args: Record<string, unknown>,
        themeFg: (color: any, text: string) => string,
): string {
        const shortenPath = (p: string) => {
                const home = os.homedir();
                return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
        };

        switch (toolName) {
                case "bash": {
                        const command = (args.command as string) || "...";
                        const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
                        return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
                }
                case "read": {
                        const rawPath = (args.file_path || args.path || "...") as string;
                        const filePath = shortenPath(rawPath);
                        const offset = args.offset as number | undefined;
                        const limit = args.limit as number | undefined;
                        let text = themeFg("accent", filePath);
                        if (offset !== undefined || limit !== undefined) {
                                const startLine = offset ?? 1;
                                const endLine = limit !== undefined ? startLine + limit - 1 : "";
                                text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
                        }
                        return themeFg("muted", "read ") + text;
                }
                case "write": {
                        const rawPath = (args.file_path || args.path || "...") as string;
                        const filePath = shortenPath(rawPath);
                        const content = (args.content || "") as string;
                        const lines = content.split("\n").length;
                        let text = themeFg("muted", "write ") + themeFg("accent", filePath);
                        if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
                        return text;
                }
                case "edit": {
                        const rawPath = (args.file_path || args.path || "...") as string;
                        return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
                }
                case "ls": {
                        const rawPath = (args.path || ".") as string;
                        return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
                }
                case "find": {
                        const pattern = (args.pattern || "*") as string;
                        const rawPath = (args.path || ".") as string;
                        return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
                }
                case "grep": {
                        const pattern = (args.pattern || "") as string;
                        const rawPath = (args.path || ".") as string;
                        return (
                                themeFg("muted", "grep ") +
                                themeFg("accent", `/${pattern}/`) +
                                themeFg("dim", ` in ${shortenPath(rawPath)}`)
                        );
                }
                default: {
                        const argsStr = JSON.stringify(args);
                        const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
                        return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
                }
        }
}

interface UsageStats {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens: number;
        turns: number;
        lastInput: number;
        lastOutput: number;
        lastCacheRead: number;
        lastCacheWrite: number;
}

interface SingleResult {
        agent: string;
        agentSource: "user" | "project" | "unknown";
        task: string;
        exitCode: number;
        messages: Message[];
        stderr: string;
        usage: UsageStats;
        model?: string;
        stopReason?: string;
        errorMessage?: string;
        step?: number;
        durationMs?: number;
        compactions: number;
        networkResumes: number;
        liveThinking?: string;
        liveText?: string;
}

interface SubagentDetails {
        mode: "single" | "parallel" | "chain";
        agentScope: AgentScope;
        projectAgentsDir: string | null;
        results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
        for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role === "assistant") {
                        for (const part of msg.content) {
                                if (part.type === "text") return part.text;
                        }
                }
        }
        return "";
}

function isFailedResult(result: SingleResult): boolean {
        return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
        if (isFailedResult(result)) {
                // A non-zero exit means the child itself failed (crash, startup
                // error, OOM kill): its stderr carries the real cause and must
                // win over a possibly stale error frame from an earlier run of
                // the same invocation (transcript frames accumulate across
                // resumes). Without stderr, say the process died — the last
                // known error is only a hint at that point.
                const frame = result.errorMessage || getFinalOutput(result.messages) || "";
                if (result.exitCode !== 0) {
                        if (result.stderr) return result.stderr;
                        return frame ? `process exited with code ${result.exitCode}: ${frame}` : `process exited with code ${result.exitCode} without output`;
                }
                return frame || "(no output)";
        }
        return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
        const byteLength = Buffer.byteLength(output, "utf8");
        if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

        let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
        while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
                truncated = truncated.slice(0, -1);
        }
        return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
        const items: DisplayItem[] = [];
        for (const msg of messages) {
                if (msg.role === "assistant") {
                        for (const part of msg.content) {
                                if (part.type === "text") items.push({ type: "text", text: part.text });
                                else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
                        }
                }
        }
        return items;
}

function renderThinkingTail(thinking: string, theme: { fg: (color: any, text: string) => string }): Text {
        const lines = thinking.split("\n");
        const tail = lines.slice(-LIVE_TAIL_LINES);
        const skipped = lines.length - tail.length;
        let text = theme.fg("muted", "─── Thinking (live) ───");
        if (skipped > 0) text += `\n${theme.fg("dim", `... ${skipped} earlier lines`)}`;
        text += `\n${theme.fg("toolOutput", tail.join("\n"))}`;
        return new Text(text, 0, 0);
}

function renderResponseTail(response: string, theme: { fg: (color: any, text: string) => string }): Text {
        const lines = response.split("\n");
        const tail = lines.slice(-LIVE_TAIL_LINES);
        const skipped = lines.length - tail.length;
        let text = theme.fg("muted", "─── Response (live) ───");
        if (skipped > 0) text += `\n${theme.fg("dim", `... ${skipped} earlier lines`)}`;
        text += `\n${theme.fg("toolOutput", tail.join("\n"))}`;
        return new Text(text, 0, 0);
}

async function mapWithConcurrencyLimit<TIn, TOut>(
        items: TIn[],
        concurrency: number,
        fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
        if (items.length === 0) return [];
        const limit = Math.max(1, Math.min(concurrency, items.length));
        const results: TOut[] = new Array(items.length);
        let nextIndex = 0;
        const workers = new Array(limit).fill(null).map(async () => {
                while (true) {
                        const current = nextIndex++;
                        if (current >= items.length) return;
                        results[current] = await fn(items[current], current);
                }
        });
        await Promise.all(workers);
        return results;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
        const currentScript = process.argv[1];
        const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
        if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
                return { command: process.execPath, args: [currentScript, ...args] };
        }

        const execName = path.basename(process.execPath).toLowerCase();
        const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
        if (!isGenericRuntime) {
                return { command: process.execPath, args };
        }

        return { command: "pi", args };
}

/**
 * --- Network resilience helpers --------------------------------------------
 *
 * runSingleAgent uses these to ride a subagent invocation through transient
 * provider/network outages: classify the failure, wait with backoff, then
 * resume the persisted session. See the "Network resilience" block near the
 * top of this file for the rationale and env overrides.
 */

function readPositiveIntEnv(name: string, fallback: number): number {
        const raw = process.env[name];
        if (!raw) return fallback;
        const value = Number.parseInt(raw, 10);
        return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Max number of session resumes per invocation after transient failures (0 disables resumption). */
function maxTransientResumes(): number {
        const raw = process.env.PI_SUBAGENT_RETRY_MAX_RESUMES;
        if (!raw) return RETRY_MAX_RESUMES_DEFAULT;
        const value = Number.parseInt(raw, 10);
        return Number.isFinite(value) && value >= 0 ? value : RETRY_MAX_RESUMES_DEFAULT;
}

/** Backoff wait (ms) before resume attempt N (1-indexed). */
function transientResumeDelayMs(resumeNumber: number): number {
        const base = readPositiveIntEnv("PI_SUBAGENT_RETRY_BASE_MS", RETRY_BASE_MS_DEFAULT);
        const cap = readPositiveIntEnv("PI_SUBAGENT_RETRY_MAX_DELAY_MS", RETRY_MAX_DELAY_MS_DEFAULT);
        // Clamp for setTimeout: delays beyond 2^31-1 ms would be truncated to 1 ms.
        return Math.min(base * 2 ** (resumeNumber - 1), cap, 2 ** 31 - 1);
}

function truncateText(text: string, maxLength: number): string {
        return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

/** The last assistant message in a transcript, if any. */
function lastAssistantMessage(messages: Message[]): AssistantMessage | undefined {
        for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role === "assistant") return msg;
        }
        return undefined;
}

/**
 * Classify a finished subagent run as transient (worth resuming) using pi's
 * own provider-error classifier — the extension resumes exactly the failures
 * pi itself would retry (network errors, timeouts, HTTP 429/5xx, overload,
 * stream drops) and never permanent ones (bad credentials, quota/billing
 * exhaustion, context overflow).
 *
 * IMPORTANT: `lastAssistant` and `runStderr` must describe THIS run only (see
 * the per-run snapshot in runSingleAgent). Classifying against the accumulated
 * transcript would let a crash during resumption be misread as the original
 * transient error (stale frames), silently consuming the whole resume budget
 * and surfacing a stale error message.
 *
 * Rules:
 *   - run ended with an assistant frame: only an error frame qualifies, and
 *     only when pi's classifier says so; completed/aborted runs never resume
 *   - run produced no assistant frame (child crashed, pi failed to start):
 *     transient only when it exited non-zero and this run's stderr carries a
 *     transient signature
 */
function isTransientRunFailure(exitCode: number, lastAssistant: AssistantMessage | undefined, runStderr: string): boolean {
        if (lastAssistant) {
                return (
                        lastAssistant.stopReason === "error" &&
                        isRetryableAssistantError({ stopReason: "error", errorMessage: lastAssistant.errorMessage || runStderr } as AssistantMessage)
                );
        }
        return exitCode !== 0 && isRetryableAssistantError({ stopReason: "error", errorMessage: runStderr } as AssistantMessage);
}

/** User message that restarts a failed run from its persisted session. */
function buildContinuationPrompt(errorSummary: string, hadAssistantTurn: boolean): string {
        const whatFailed = hadAssistantTurn ? "The previous assistant turn failed" : "The previous run failed";
        return `[${whatFailed} with a transient provider/network error: ${truncateText(errorSummary, 200)}. The conversation so far — including every tool call and its result — is preserved. Continue the task from exactly where it left off; do not repeat work that is already complete.]`;
}

/** True when the session file exists and the child persisted anything to it. */
function sessionHasContent(sessionPath: string): boolean {
        try {
                return fs.statSync(sessionPath).size > 0;
        } catch {
                return false;
        }
}

/** Sleep for `ms`, resolving early with "aborted" if the signal fires first. */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<"ok" | "aborted"> {
        return new Promise((resolve) => {
                if (signal?.aborted) {
                        resolve("aborted");
                        return;
                }
                const onAbort = () => {
                        clearTimeout(timer);
                        resolve("aborted");
                };
                const timer = setTimeout(() => {
                        if (signal) signal.removeEventListener("abort", onAbort);
                        resolve("ok");
                }, ms);
                signal?.addEventListener("abort", onAbort, { once: true });
        });
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
        defaultCwd: string,
        agents: AgentConfig[],
        agentName: string,
        task: string,
        cwd: string | undefined,
        step: number | undefined,
        signal: AbortSignal | undefined,
        onUpdate: OnUpdateCallback | undefined,
        makeDetails: (results: SingleResult[]) => SubagentDetails,
        currentModel: string,
        modelOverride?: string,
): Promise<SingleResult> {
        const agent = agents.find((a) => a.name === agentName);

        if (!agent) {
                const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
                return {
                        agent: agentName,
                        agentSource: "unknown",
                        task,
                        exitCode: 1,
                        messages: [],
                        stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
                        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, lastInput: 0, lastOutput: 0, lastCacheRead: 0, lastCacheWrite: 0 },
                        compactions: 0,
                        networkResumes: 0,
                        step,
                };
        }

        // Model precedence: per-invocation override > agent frontmatter `model`
        // (when not "Default") > parent's current model. The override is the
        // runtime mechanism that lets callers pick a model per agent without
        // editing the agent's markdown definition.
        const frontmatterModel = agent.model && agent.model !== "Default" ? agent.model : undefined;
        const modelToUse = modelOverride || frontmatterModel || currentModel;

        // Every invocation runs inside a private temp dir with a persistent
        // session file (`--session <file>` instead of `--no-session`): if the
        // child dies mid-task — e.g. a network outage outlasts pi's own
        // in-process retry budget — the full conversation is on disk and the
        // run can be resumed without losing progress (see the resume loop
        // below). The dir (session file included) is removed when the
        // invocation finishes, so subagent sessions never leak into the
        // user's session store.
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
        const sessionPath = path.join(tmpDir, "session.jsonl");

        const currentResult: SingleResult = {
                agent: agentName,
                agentSource: agent.source,
                task,
                exitCode: 0,
                messages: [],
                stderr: "",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, lastInput: 0, lastOutput: 0, lastCacheRead: 0, lastCacheWrite: 0 },
                model: modelToUse,
                compactions: 0,
                networkResumes: 0,
                step,
        };

        const emitUpdate = () => {
                if (onUpdate) {
                        onUpdate({
                                content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
                                details: makeDetails([currentResult]),
                        });
                }
        };

        /** Status text shown while waiting out a transient failure (backoff phase). */
        const emitStatus = (statusText: string) => {
                if (onUpdate) {
                        onUpdate({
                                content: [{ type: "text", text: statusText }],
                                details: makeDetails([currentResult]),
                        });
                }
        };

        const startTime = Date.now();
        let lastLiveEmit = 0;

        try {
                const baseArgs: string[] = ["--mode", "json", "-p", "--session", sessionPath];
                baseArgs.push("--model", modelToUse);
                if (agent.tools && agent.tools.length > 0) baseArgs.push("--tools", agent.tools.join(","));
                if (agent.systemPrompt.trim()) {
                        const promptPath = path.join(tmpDir, `prompt-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
                        await withFileMutationQueue(promptPath, async () => {
                                await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
                        });
                        baseArgs.push("--append-system-prompt", promptPath);
                }

                const originalPrompt = `Task: ${task}`;
                let prompt = originalPrompt;
                let wasAborted = false;
                let transientResumes = 0;
                let exitCode: number;

                for (;;) {
                        // One child-process run. `prompt` is the original task on the
                        // first run and a continuation note on resumed runs; everything
                        // else is identical (same session file, model, tools, system
                        // prompt), so a resume continues the exact same conversation.
                        wasAborted = false;
                        // Snapshot the transcript/stderr so the run can be
                        // classified on its own output: earlier runs' error
                        // frames must not make a crash during resumption look
                        // like the original transient error.
                        const messagesBefore = currentResult.messages.length;
                        const stderrBefore = currentResult.stderr.length;
                        exitCode = await new Promise<number>((resolve) => {
                                const invocation = getPiInvocation([...baseArgs, prompt]);
                                const proc = spawn(invocation.command, invocation.args, {
                                        cwd: cwd ?? defaultCwd,
                                        shell: false,
                                        stdio: ["ignore", "pipe", "pipe"],
                                        // Propagate the nesting depth so the child knows it is a
                                        // subagent and refuses to register the `subagent` tool.
                                        env: { ...process.env, PI_SUBAGENT_DEPTH: String(SUBAGENT_DEPTH + 1) },
                                });
                                let buffer = "";

                                // pi's JSON mode emits `message_update` as delta-only events:
                                // they carry `assistantMessageEvent` (with `contentIndex` and
                                // `delta` fragments for thinking/text/tool-call) but NOT a
                                // cumulative `message` field. Accumulate each content part per
                                // contentIndex so live reasoning/text stay available to the
                                // expanded panel until `message_end` finalizes the message.
                                type LivePart = { type: "thinking" | "text"; value: string };
                                const liveParts = new Map<number, LivePart>();

                                const processLine = (line: string) => {
                                        if (!line.trim()) return;
                                        let event: any;
                                        try {
                                                event = JSON.parse(line);
                                        } catch {
                                                return;
                                        }

                                        if (event.type === "message_update" && event.assistantMessageEvent) {
                                                const sse = event.assistantMessageEvent as {
                                                        type: string;
                                                        contentIndex?: number;
                                                        delta?: string;
                                                        content?: string;
                                                };
                                                const idx = sse.contentIndex ?? 0;
                                                const apply = (kind: "thinking" | "text", value: string) => {
                                                        const part = liveParts.get(idx) ?? { type: kind, value: "" };
                                                        part.value += value;
                                                        part.type = kind;
                                                        liveParts.set(idx, part);
                                                };
                                                if (sse.type === "thinking_delta" && sse.delta) apply("thinking", sse.delta);
                                                else if (sse.type === "text_delta" && sse.delta) apply("text", sse.delta);
                                                else if (sse.type === "thinking_start") {
                                                        if (!liveParts.has(idx)) liveParts.set(idx, { type: "thinking", value: "" });
                                                } else if (sse.type === "text_start") {
                                                        if (!liveParts.has(idx)) liveParts.set(idx, { type: "text", value: "" });
                                                } else if (sse.type === "thinking_end" && sse.content) {
                                                        liveParts.set(idx, { type: "thinking", value: sse.content });
                                                } else if (sse.type === "text_end" && sse.content) {
                                                        liveParts.set(idx, { type: "text", value: sse.content });
                                                } else {
                                                        // non-streaming events (start/done/error) carry no new content
                                                        return;
                                                }

                                                const thinking = Array.from(liveParts.values())
                                                        .filter((p) => p.type === "thinking")
                                                        .map((p) => p.value)
                                                        .join("");
                                                const text = Array.from(liveParts.values())
                                                        .filter((p) => p.type === "text")
                                                        .map((p) => p.value)
                                                        .join("");
                                                if (thinking) currentResult.liveThinking = thinking;
                                                if (text) currentResult.liveText = text;
                                                if (thinking || text) {
                                                        const now = Date.now();
                                                        if (now - lastLiveEmit >= LIVE_THROTTLE_MS) {
                                                                lastLiveEmit = now;
                                                                emitUpdate();
                                                        }
                                                }
                                        }

                                        if (event.type === "message_end" && event.message) {
                                                const msg = event.message as Message;
                                                currentResult.messages.push(msg);
                                                currentResult.liveThinking = undefined;
                                                currentResult.liveText = undefined;
                                                liveParts.clear();

                                                if (msg.role === "assistant") {
                                                        currentResult.usage.turns++;
                                                        const usage = msg.usage;
                                                        if (usage) {
                                                                currentResult.usage.input += usage.input || 0;
                                                                currentResult.usage.output += usage.output || 0;
                                                                currentResult.usage.cacheRead += usage.cacheRead || 0;
                                                                currentResult.usage.cacheWrite += usage.cacheWrite || 0;
                                                                currentResult.usage.cost += usage.cost?.total || 0;
                                                                currentResult.usage.contextTokens = usage.totalTokens || 0;
                                                                currentResult.usage.lastInput = usage.input || 0;
                                                                currentResult.usage.lastOutput = usage.output || 0;
                                                                currentResult.usage.lastCacheRead = usage.cacheRead || 0;
                                                                currentResult.usage.lastCacheWrite = usage.cacheWrite || 0;
                                                        }
                                                        if (!currentResult.model && msg.model) currentResult.model = msg.model;
                                                        if (msg.stopReason) currentResult.stopReason = msg.stopReason;
                                                        if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
                                                }
                                                emitUpdate();
                                        }

                                        // Count completed compactions in this session. pi emits `compaction_end`
                                        // with a `result` only when the compaction succeeded; aborted/failed
                                        // compactions (including a failed overflow-recovery retry) carry
                                        // `result: undefined` and are not counted. A successful overflow-recovery
                                        // compaction does emit a `result` and is a real compaction counted here.
                                        if (event.type === "compaction_end" && event.result && !event.aborted) {
                                                currentResult.compactions++;
                                        }

                                        // Note: pi emits tool_execution_start/update/end and turn_end (toolResults)
                                        // for tool execution. There is no tool_result_end event, and tool result
                                        // messages aren't needed by getDisplayItems/getFinalOutput anyway.
                                };

                                proc.stdout.on("data", (data) => {
                                        buffer += data.toString();
                                        const lines = buffer.split("\n");
                                        buffer = lines.pop() || "";
                                        for (const line of lines) processLine(line);
                                });

                                proc.stderr.on("data", (data) => {
                                        currentResult.stderr += data.toString();
                                });

                                let killProc: (() => void) | null = null;
                                const detachAbort = () => {
                                        if (signal && killProc) signal.removeEventListener("abort", killProc);
                                };

                                proc.on("close", (code) => {
                                        if (buffer.trim()) processLine(buffer);
                                        detachAbort();
                                        resolve(code ?? 0);
                                });

                                proc.on("error", () => {
                                        detachAbort();
                                        resolve(1);
                                });

                                if (signal) {
                                        killProc = () => {
                                                wasAborted = true;
                                                proc.kill("SIGTERM");
                                                setTimeout(() => {
                                                        if (!proc.killed) proc.kill("SIGKILL");
                                                }, 5000);
                                        };
                                        if (signal.aborted) killProc();
                                        else signal.addEventListener("abort", killProc, { once: true });
                                }
                        });

                        if (wasAborted) throw new Error("Subagent was aborted");
                        currentResult.exitCode = exitCode;

                        // Classify this run only (see the snapshot above).
                        const runStderr = currentResult.stderr.slice(stderrBefore).trim();
                        const lastAssistant = lastAssistantMessage(currentResult.messages.slice(messagesBefore));
                        if (
                                !isTransientRunFailure(exitCode, lastAssistant, runStderr) ||
                                transientResumes >= maxTransientResumes() ||
                                signal?.aborted
                        ) {
                                break;
                        }

                        // The run died on a transient provider/network error. The session
                        // file holds the full conversation, so after a backoff wait we
                        // resume it and tell the subagent to pick up where it left off —
                        // this is what lets an invocation ride through arbitrarily long
                        // network outages instead of losing all progress.
                        transientResumes++;
                        const reason = lastAssistant?.errorMessage || runStderr || "transient provider/network error";
                        const delayMs = transientResumeDelayMs(transientResumes);
                        const waitLabel = delayMs < 1000 ? `${delayMs}ms` : `${Math.round(delayMs / 1000)}s`;
                        emitStatus(
                                `Transient provider/network error: ${truncateText(reason, 160)}\nWaiting ${waitLabel} before resuming (attempt ${transientResumes} of ${maxTransientResumes()})...`,
                        );
                        const sleepOutcome = await abortableSleep(delayMs, signal);
                        if (sleepOutcome === "aborted" || signal?.aborted) throw new Error("Subagent was aborted");

                        // If the child never persisted anything (it died before the
                        // session file was created) there is nothing to resume: rerun
                        // the original task instead of a continuation prompt.
                        prompt = sessionHasContent(sessionPath) ? buildContinuationPrompt(reason, Boolean(lastAssistant)) : originalPrompt;
                }

                currentResult.networkResumes = transientResumes;
                // Only mark the session as having run to completion (setting `durationMs`)
                // on the non-aborted path. The compaction count is gated on `durationMs`,
                // so an aborted session must never surface a "completed" meta line even if
                // this ordering changes later. (An aborted session throws above.)
                currentResult.durationMs = Date.now() - startTime;
                return currentResult;
        } finally {
                try {
                        await fs.promises.rm(tmpDir, { recursive: true, force: true });
                } catch {
                        /* ignore */
                }
        }
}

const TaskItem = Type.Object({
        agent: Type.String({ description: "Name of the agent to invoke" }),
        task: Type.String({ description: "Task to delegate to the agent" }),
        cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
        model: Type.Optional(
                Type.String({
                        description:
                                "Model override for this task as a canonical `provider/id` reference (e.g. `openrouter/z-ai/glm-5.2`). Takes precedence over the top-level `models` map and the agent's frontmatter `model`.",
                }),
        ),
});

const ChainItem = Type.Object({
        agent: Type.String({ description: "Name of the agent to invoke" }),
        task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
        cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
        model: Type.Optional(
                Type.String({
                        description:
                                "Model override for this chain step as a canonical `provider/id` reference (e.g. `openrouter/z-ai/glm-5.2`). Takes precedence over the top-level `models` map and the agent's frontmatter `model`.",
                }),
        ),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
        description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
        default: "user",
});

const SubagentParams = Type.Object({
        agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
        task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
        tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
        chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
        agentScope: Type.Optional(AgentScopeSchema),
        confirmProjectAgents: Type.Optional(
                Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
        ),
        cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
        model: Type.Optional(
                Type.String({
                        description:
                                "Model override for single mode as a canonical `provider/id` reference (e.g. `openrouter/z-ai/glm-5.2`). Used when `agent` is set. Takes precedence over the `models` map and the agent's frontmatter `model`.",
                }),
        ),
        models: Type.Optional(
                Type.Record(Type.String(), Type.String(), {
                        description:
                                "Per-agent model overrides mapping agent name to a canonical `provider/id` reference (e.g. `{ 'worker': 'lmstudio/qwen3.6-27b', 'reviewer': 'openrouter/z-ai/glm-5.2' }`). Applies to all modes. Lets you assign different models to different agents at invocation time without editing agent markdown.",
                }),
        ),
});

export default function (pi: ExtensionAPI) {
        // Recursion guard: a process spawned by this tool runs at
        // SUBAGENT_DEPTH >= 1. Such a process must not expose the `subagent`
        // tool, otherwise a subagent could spawn its own subagents and recurse
        // without bound. Skipping registration here means the child process
        // never advertises the tool, so the model cannot invoke it.
        if (SUBAGENT_DEPTH >= MAX_SUBAGENT_DEPTH) {
                return;
        }

        pi.registerTool({
                name: "subagent",
                label: "Subagent",
                description: [
                        "Delegate tasks to specialized subagents with isolated context.",
                        "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
                        `Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
                        `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
                        "Per-agent models: pass `models` ({agentName: \"provider/id\"}) to assign different models per agent without editing agent markdown, or `model` (single mode) / per-item `model` for a single invocation. Overrides take precedence over the agent's frontmatter `model` and the parent's current model.",
                ].join(" "),
                parameters: SubagentParams,

                async execute(_toolCallId, params, signal, onUpdate, ctx) {
                        const agentScope: AgentScope = params.agentScope ?? "user";
                        const discovery = discoverAgents(ctx.cwd, agentScope);
                        const agents = discovery.agents;
                        const confirmProjectAgents = params.confirmProjectAgents ?? true;

                        // Resolve the parent's current model as a canonical "provider/id"
                        // reference so the spawned subagent targets the exact same
                        // model+provider. A bare model id is ambiguous when multiple
                        // providers serve the same id, and pi would resolve it to the
                        // first matching provider (i.e. the first model used this
                        // session) instead of the parent's current selection.
                        const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

                        const hasChain = (params.chain?.length ?? 0) > 0;
                        const hasTasks = (params.tasks?.length ?? 0) > 0;
                        const hasSingle = Boolean(params.agent && params.task);
                        const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

                        const makeDetails =
                                (mode: "single" | "parallel" | "chain") =>
                                (results: SingleResult[]): SubagentDetails => ({
                                        mode,
                                        agentScope,
                                        projectAgentsDir: discovery.projectAgentsDir,
                                        results,
                                });

                        if (modeCount !== 1) {
                                const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
                                return {
                                        content: [
                                                {
                                                        type: "text",
                                                        text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
                                                },
                                        ],
                                        details: makeDetails("single")([]),
                                };
                        }

                        if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
                                const requestedAgentNames = new Set<string>();
                                if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
                                if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
                                if (params.agent) requestedAgentNames.add(params.agent);

                                const projectAgentsRequested = Array.from(requestedAgentNames)
                                        .map((name) => agents.find((a) => a.name === name))
                                        .filter((a): a is AgentConfig => a?.source === "project");

                                if (projectAgentsRequested.length > 0) {
                                        const names = projectAgentsRequested.map((a) => a.name).join(", ");
                                        const dir = discovery.projectAgentsDir ?? "(unknown)";
                                        const ok = await ctx.ui.confirm(
                                                "Run project-local agents?",
                                                `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
                                        );
                                        if (!ok)
                                                return {
                                                        content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                                                        details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                                                };
                                }
                        }

                        if (params.chain && params.chain.length > 0) {
                                const results: SingleResult[] = [];
                                let previousOutput = "";

                                for (let i = 0; i < params.chain.length; i++) {
                                        const step = params.chain[i];
                                        const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

                                        // Create update callback that includes all previous results
                                        const chainUpdate: OnUpdateCallback | undefined = onUpdate
                                                ? (partial) => {
                                                                // Combine completed results with current streaming result
                                                                const currentResult = partial.details?.results[0];
                                                                if (currentResult) {
                                                                        const allResults = [...results, currentResult];
                                                                        onUpdate({
                                                                                content: partial.content,
                                                                                details: makeDetails("chain")(allResults),
                                                                        });
                                                                }
                                                        }
                                                : undefined;

                                        const result = await runSingleAgent(
                                                ctx.cwd,
                                                agents,
                                                step.agent,
                                                taskWithContext,
                                                step.cwd,
                                                i + 1,
                                                signal,
                                                chainUpdate,
                                                makeDetails("chain"),
                                                currentModel,
                                                step.model ?? params.models?.[step.agent],
                                        );
                                        results.push(result);

                                        const isError = isFailedResult(result);
                                        if (isError) {
                                                const errorMsg = getResultOutput(result);
                                                return {
                                                        content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
                                                        details: makeDetails("chain")(results),
                                                        isError: true,
                                                };
                                        }
                                        previousOutput = getFinalOutput(result.messages);
                                }
                                return {
                                        content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
                                        details: makeDetails("chain")(results),
                                };
                        }

                        if (params.tasks && params.tasks.length > 0) {
                                if (params.tasks.length > MAX_PARALLEL_TASKS)
                                        return {
                                                content: [
                                                        {
                                                                type: "text",
                                                                text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                                                        },
                                                ],
                                                details: makeDetails("parallel")([]),
                                        };

                                // Track all results for streaming updates
                                const allResults: SingleResult[] = new Array(params.tasks.length);

                                // Initialize placeholder results
                                for (let i = 0; i < params.tasks.length; i++) {
                                        allResults[i] = {
                                                agent: params.tasks[i].agent,
                                                agentSource: "unknown",
                                                task: params.tasks[i].task,
                                                exitCode: -1, // -1 = still running
                                                messages: [],
                                                stderr: "",
                                                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, lastInput: 0, lastOutput: 0, lastCacheRead: 0, lastCacheWrite: 0 },
                                                compactions: 0,
                                                networkResumes: 0,
                                        };
                                }

                                const emitParallelUpdate = () => {
                                        if (onUpdate) {
                                                const running = allResults.filter((r) => r.exitCode === -1).length;
                                                const done = allResults.filter((r) => r.exitCode !== -1).length;
                                                onUpdate({
                                                        content: [
                                                                { type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
                                                        ],
                                                        details: makeDetails("parallel")([...allResults]),
                                                });
                                        }
                                };

                                const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
                                        const result = await runSingleAgent(
                                                ctx.cwd,
                                                agents,
                                                t.agent,
                                                t.task,
                                                t.cwd,
                                                undefined,
                                                signal,
                                                // Per-task update callback
                                                (partial) => {
                                                        if (partial.details?.results[0]) {
                                                                allResults[index] = partial.details.results[0];
                                                                emitParallelUpdate();
                                                        }
                                                },
                                                makeDetails("parallel"),
                                                currentModel,
                                                t.model ?? params.models?.[t.agent],
                                        );
                                        allResults[index] = result;
                                        emitParallelUpdate();
                                        return result;
                                });

                                const successCount = results.filter((r) => !isFailedResult(r)).length;
                                const summaries = results.map((r) => {
                                        const output = truncateParallelOutput(getResultOutput(r));
                                        const status = isFailedResult(r)
                                                ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
                                                : "completed";
                                        return `### [${r.agent}] ${status}\n\n${output}`;
                                });
                                return {
                                        content: [
                                                {
                                                        type: "text",
                                                        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
                                                },
                                        ],
                                        details: makeDetails("parallel")(results),
                                };
                        }

                        if (params.agent && params.task) {
                                const result = await runSingleAgent(
                                        ctx.cwd,
                                        agents,
                                        params.agent,
                                        params.task,
                                        params.cwd,
                                        undefined,
                                        signal,
                                        onUpdate,
                                        makeDetails("single"),
                                        currentModel,
                                        params.model ?? params.models?.[params.agent],
                                );
                                const isError = isFailedResult(result);
                                if (isError) {
                                        const errorMsg = getResultOutput(result);
                                        return {
                                                content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
                                                details: makeDetails("single")([result]),
                                                isError: true,
                                        };
                                }
                                return {
                                        content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
                                        details: makeDetails("single")([result]),
                                };
                        }

                        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
                        return {
                                content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
                                details: makeDetails("single")([]),
                        };
                },

                renderCall(args, theme, _context) {
                        const scope: AgentScope = args.agentScope ?? "user";
                        if (args.chain && args.chain.length > 0) {
                                let text =
                                        theme.fg("toolTitle", theme.bold("subagent ")) +
                                        theme.fg("accent", `chain (${args.chain.length} steps)`) +
                                        theme.fg("muted", ` [${scope}]`);
                                for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
                                        const step = args.chain[i];
                                        // Clean up {previous} placeholder for display
                                        const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
                                        const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
                                        text +=
                                                "\n  " +
                                                theme.fg("muted", `${i + 1}.`) +
                                                " " +
                                                theme.fg("accent", step.agent) +
                                                theme.fg("dim", ` ${preview}`);
                                }
                                if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
                                return new Text(text, 0, 0);
                        }
                        if (args.tasks && args.tasks.length > 0) {
                                let text =
                                        theme.fg("toolTitle", theme.bold("subagent ")) +
                                        theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
                                        theme.fg("muted", ` [${scope}]`);
                                for (const t of args.tasks.slice(0, 3)) {
                                        const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
                                        text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
                                }
                                if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
                                return new Text(text, 0, 0);
                        }
                        const agentName = args.agent || "...";
                        const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
                        let text =
                                theme.fg("toolTitle", theme.bold("subagent ")) +
                                theme.fg("accent", agentName) +
                                theme.fg("muted", ` [${scope}]`);
                        text += `\n  ${theme.fg("dim", preview)}`;
                        return new Text(text, 0, 0);
                },

                renderResult(result, { expanded }, theme, _context) {
                        const details = result.details as SubagentDetails | undefined;
                        if (!details || details.results.length === 0) {
                                const text = result.content[0];
                                return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
                        }

                        const mdTheme = getMarkdownTheme();

                        const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
                                const toShow = limit ? items.slice(-limit) : items;
                                const skipped = limit && items.length > limit ? items.length - limit : 0;
                                let text = "";
                                if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
                                for (const item of toShow) {
                                        if (item.type === "text") {
                                                const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
                                                text += `${theme.fg("toolOutput", preview)}\n`;
                                        } else {
                                                text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
                                        }
                                }
                                return text.trimEnd();
                        };

                        if (details.mode === "single" && details.results.length === 1) {
                                const r = details.results[0];
                                const isError = isFailedResult(r);
                                const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
                                const displayItems = getDisplayItems(r.messages);
                                const finalOutput = getFinalOutput(r.messages);

                                if (expanded) {
                                        const container = new Container();
                                        let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
                                        if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                                        container.addChild(new Text(header, 0, 0));
                                        if (isError && r.errorMessage)
                                                container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
                                        container.addChild(new Spacer(1));
                                        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
                                        container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
                                        container.addChild(new Spacer(1));
                                        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
                                        if (displayItems.length === 0 && !finalOutput) {
                                                container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
                                        } else {
                                                for (const item of displayItems) {
                                                        if (item.type === "toolCall")
                                                                container.addChild(
                                                                        new Text(
                                                                                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                                                                0,
                                                                                0,
                                                                        ),
                                                                );
                                                }
                                                if (finalOutput) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                                                }
                                        }
                                        const metaStr = formatResultMeta(r);
                                        if (metaStr) {
                                                container.addChild(new Spacer(1));
                                                container.addChild(new Text(theme.fg("dim", metaStr), 0, 0));
                                        }
                                        if (r.liveThinking) {
                                                container.addChild(new Spacer(1));
                                                container.addChild(renderThinkingTail(r.liveThinking, theme));
                                        }
                                        if (r.liveText) {
                                                container.addChild(new Spacer(1));
                                                container.addChild(renderResponseTail(r.liveText, theme));
                                        }
                                        return container;
                                }

                                let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
                                if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
                                if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
                                else if (displayItems.length === 0 && !finalOutput) text += `\n${theme.fg("muted", "(no output)")}`;
                                else {
                                        text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
                                        if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                                }
                                const metaStr = formatResultMeta(r);
                                if (metaStr) text += `\n${theme.fg("dim", metaStr)}`;
                                return new Text(text, 0, 0);
                        }

                        const aggregateUsage = (results: SingleResult[]) => {
                                const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
                                for (const r of results) {
                                        total.input += r.usage.input;
                                        total.output += r.usage.output;
                                        total.cacheRead += r.usage.cacheRead;
                                        total.cacheWrite += r.usage.cacheWrite;
                                        total.cost += r.usage.cost;
                                        total.turns += r.usage.turns;
                                }
                                return total;
                        };

                        if (details.mode === "chain") {
                                const successCount = details.results.filter((r) => r.exitCode === 0).length;
                                const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

                                if (expanded) {
                                        const container = new Container();
                                        container.addChild(
                                                new Text(
                                                        icon +
                                                                " " +
                                                                theme.fg("toolTitle", theme.bold("chain ")) +
                                                                theme.fg("accent", `${successCount}/${details.results.length} steps`),
                                                        0,
                                                        0,
                                                ),
                                        );

                                        for (const r of details.results) {
                                                const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                                                const displayItems = getDisplayItems(r.messages);
                                                const finalOutput = getFinalOutput(r.messages);

                                                container.addChild(new Spacer(1));
                                                container.addChild(
                                                        new Text(
                                                                `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
                                                                0,
                                                                0,
                                                        ),
                                                );
                                                container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                                                // Show tool calls
                                                for (const item of displayItems) {
                                                        if (item.type === "toolCall") {
                                                                container.addChild(
                                                                        new Text(
                                                                                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                                                                0,
                                                                                0,
                                                                        ),
                                                                );
                                                        }
                                                }

                                                // Show final output as markdown
                                                if (finalOutput) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                                                }

                                                const stepMeta = formatResultMeta(r);
                                                if (stepMeta) container.addChild(new Text(theme.fg("dim", stepMeta), 0, 0));

                                                // Live tails at the bottom of each step block
                                                if (r.liveThinking) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(renderThinkingTail(r.liveThinking, theme));
                                                }
                                                if (r.liveText) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(renderResponseTail(r.liveText, theme));
                                                }
                                        }

                                        const usageStr = formatUsageStats(aggregateUsage(details.results));
                                        if (usageStr) {
                                                container.addChild(new Spacer(1));
                                                container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
                                        }
                                        return container;
                                }

                                // Collapsed view
                                let text =
                                        icon +
                                        " " +
                                        theme.fg("toolTitle", theme.bold("chain ")) +
                                        theme.fg("accent", `${successCount}/${details.results.length} steps`);
                                for (const r of details.results) {
                                        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
                                        const displayItems = getDisplayItems(r.messages);
                                        text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
                                        if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
                                        else text += `\n${renderDisplayItems(displayItems, 5)}`;
                                        const stepMeta = formatResultMeta(r);
                                        if (stepMeta) text += `\n${theme.fg("dim", stepMeta)}`;
                                }
                                const usageStr = formatUsageStats(aggregateUsage(details.results));
                                if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
                                text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                                return new Text(text, 0, 0);
                        }

                        if (details.mode === "parallel") {
                                const running = details.results.filter((r) => r.exitCode === -1).length;
                                const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
                                const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
                                const isRunning = running > 0;
                                const icon = isRunning
                                        ? theme.fg("warning", "⏳")
                                        : failCount > 0
                                                ? theme.fg("warning", "◐")
                                                : theme.fg("success", "✓");
                                const status = isRunning
                                        ? `${successCount + failCount}/${details.results.length} done, ${running} running`
                                        : `${successCount}/${details.results.length} tasks`;

                                if (expanded && !isRunning) {
                                        const container = new Container();
                                        container.addChild(
                                                new Text(
                                                        `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
                                                        0,
                                                        0,
                                                ),
                                        );

                                        for (const r of details.results) {
                                                const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
                                                const displayItems = getDisplayItems(r.messages);
                                                const finalOutput = getFinalOutput(r.messages);

                                                container.addChild(new Spacer(1));
                                                container.addChild(
                                                        new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
                                                );
                                                container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

                                                // Show tool calls
                                                for (const item of displayItems) {
                                                        if (item.type === "toolCall") {
                                                                container.addChild(
                                                                        new Text(
                                                                                theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                                                                                0,
                                                                                0,
                                                                        ),
                                                                );
                                                        }
                                                }

                                                // Show final output as markdown
                                                if (finalOutput) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
                                                }

                                                const taskMeta = formatResultMeta(r);
                                                if (taskMeta) container.addChild(new Text(theme.fg("dim", taskMeta), 0, 0));

                                                // Live tails at the bottom of each task block
                                                if (r.liveThinking) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(renderThinkingTail(r.liveThinking, theme));
                                                }
                                                if (r.liveText) {
                                                        container.addChild(new Spacer(1));
                                                        container.addChild(renderResponseTail(r.liveText, theme));
                                                }
                                        }

                                        const usageStr = formatUsageStats(aggregateUsage(details.results));
                                        if (usageStr) {
                                                container.addChild(new Spacer(1));
                                                container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
                                        }
                                        return container;
                                }

                                // Collapsed view (or still running)
                                let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
                                for (const r of details.results) {
                                        const rIcon =
                                                r.exitCode === -1
                                                        ? theme.fg("warning", "⏳")
                                                        : isFailedResult(r)
                                                                ? theme.fg("error", "✗")
                                                                : theme.fg("success", "✓");
                                        const displayItems = getDisplayItems(r.messages);
                                        text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
                                        if (displayItems.length === 0)
                                                text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
                                        else text += `\n${renderDisplayItems(displayItems, 5)}`;
                                        if (r.exitCode !== -1) {
                                                const taskMeta = formatResultMeta(r);
                                                if (taskMeta) text += `\n${theme.fg("dim", taskMeta)}`;
                                        }
                                }
                                if (!isRunning) {
                                        const usageStr = formatUsageStats(aggregateUsage(details.results));
                                        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
                                }
                                if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
                                return new Text(text, 0, 0);
                        }

                        const text = result.content[0];
                        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
                },
        });
}
