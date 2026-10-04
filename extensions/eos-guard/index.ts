/**
 * eos-guard — prevent llama.cpp/LM Studio special-token turn cuts.
 *
 * Problem: a llama.cpp server (LM Studio included) ends generation the
 * moment the model emits a chat-template special token — even when the
 * model only quotes it as literal text (e.g. while discussing a GGUF
 * tokenizer). The token is consumed as EOS and stripped, pi sees
 * finish_reason "stop" mid-sentence, and the turn appears empty or cut.
 *
 * This extension is the PREVENTION layer; recovery from cuts that still
 * happen lives in auto-recover.ts (thinking-only stop-turn detection).
 *
 * Opt-in by design: the system-prompt rule and context rewriting change
 * model behavior for every turn, so both stay OFF until the user asks for
 * them in a session where special-token-heavy work is expected:
 *
 *   /eos-guard         toggle for this session
 *   /eos-guard on      enable explicitly
 *   /eos-guard off     disable explicitly
 *
 * Set PI_EOS_GUARD=1 to flip the per-session default to enabled (e.g. in
 * a project where every session does tokenizer work).
 *
 * Subagent inheritance: spawned subagent pi processes are separate sessions
 * that would otherwise default to off — while the workers doing the
 * special-token-heavy work are exactly the sessions that need the guard.
 * The top-level session therefore publishes its resolved state to
 * PI_EOS_GUARD_INHERIT ("1"/"0") at session_start and on every toggle; a
 * subagent process (PI_SUBAGENT_DEPTH >= 1, set by the subagent extension
 * at spawn) reads that directive as its default instead of the shell env.
 * The directive uses the same channel pattern as PI_SUBAGENT_DEPTH: parent
 * process env, inherited at spawn. Top-level sessions never READ the
 * directive (only write it), so a toggle stays session-scoped and cannot
 * leak into the next session via /new or /resume.
 *
 * What it does while enabled:
 *   1. `context` event — before every LLM call, defuse special-token
 *      spellings anywhere in the outgoing context (tool results, assistant
 *      thinking/text, tool-call arguments, user text). Non-destructive:
 *      the session record keeps the originals; only the request payload is
 *      sanitized. The exact byte sequence that tokenizes to the special
 *      token never reaches the model, so it cannot echo it back by copy.
 *   2. `before_agent_start` — append a system-prompt rule telling the
 *      model to refer to special tokens by name/id instead of writing
 *      them verbatim (covers tokens the model knows from pretraining).
 *
 * Scope: covers the main session and, through directive inheritance, every
 * subagent session spawned from it. Recovery from cuts that still happen
 * lives in auto-recover.ts (thinking-only stop-turn detection).
 *
 * Place in ~/.pi/agent/extensions/eos-guard/ (global) or
 * .pi/extensions/eos-guard/ (project-local).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeMessages, type TokenPattern } from "./sanitize.ts";

// Spelling families that servers commonly install as EOS/stop strings.
// Keep patterns anchored to delimiter structure, not to specific models,
// so newly discovered GGUF special tokens are covered automatically.
export const DEFAULT_PATTERNS: readonly TokenPattern[] = [
	// ChatML/Qwen-style: <|im_end|>, <|endoftext|>, <|fim_prefix|>, ...
	/<\|[^|<>\n]{1,80}\|>/g,
	// SentencePiece/classic: </s>, <s>
	/<\/?s>/g,
	// Mistral/Meta markers: [INST], [/INST], <<SYS>>, <</SYS>>
	/\[\/?INST\]/g,
	/<<\/?SYS>>/g,
];

// Set PI_EOS_GUARD_DEBUG=1 to log sanitization details to stderr.
const DEBUG = process.env.PI_EOS_GUARD_DEBUG === "1";

// Directive published by a parent session for its spawned subagent
// processes (same channel pattern as PI_SUBAGENT_DEPTH: parent process
// env, inherited at spawn). Read only by subagent instances; written by
// every instance to cover whatever depth the subagent extension allows.
const INHERIT_DIRECTIVE_VAR = "PI_EOS_GUARD_INHERIT";

/**
 * The per-session default for this instance: subagent sessions inherit the
 * spawning session's resolved state; top-level sessions take the shell env
 * (and deliberately never read the directive, so a toggle cannot leak into
 * the next session on /new or /resume). Depth is evaluated per call — it is
 * constant for a process's lifetime, but per-call keeps instances testable.
 */
function resolvedDefault(): boolean {
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10) || 0;
	if (depth > 0) return process.env[INHERIT_DIRECTIVE_VAR] === "1";
	return process.env.PI_EOS_GUARD === "1";
}

/** Publish this session's resolved state to future subagent spawns. */
function syncInheritDirective(enabled: boolean): void {
	process.env[INHERIT_DIRECTIVE_VAR] = enabled ? "1" : "0";
}

const SYSTEM_PROMPT_RULE = `

## Special-token output guard

Your responses are served through an inference gateway that terminates generation whenever a chat-template special token is emitted, even when you only quote one as literal text. If that happens your turn is cut off mid-sentence and your work is lost. Therefore NEVER write such a token verbatim — not in prose, not in thinking, not inside tool arguments. Refer to special tokens by name or id (for example: "the im_end token"), or reuse the defanged lookalike spellings (guillemet-delimited) if they appear in tool output. If a task seems to require the verbatim string, describe it precisely instead and let the surrounding code construct it.`;

export default function (pi: ExtensionAPI) {
	// Session-scoped opt-in. Extension instances are fresh per session, so
	// this naturally resets to the resolved default on /new, /resume, and
	// /reload — and session_start re-publishes the directive so subagents
	// spawned by the new session inherit ITS state, not the old one's.
	let enabled = resolvedDefault();

	// One notification per agent run (reset when a run starts with the guard
	// active), so the user sees that sanitization happened without per-call
	// spam.
	let notifiedThisRun = false;

	const reflectState = (ctx: ExtensionContext) => {
		// Footer indicator so the active guard is never invisible. Clearing
		// with undefined removes the status entirely.
		if (ctx.hasUI) ctx.ui.setStatus("eos-guard", enabled ? "eos-guard: on" : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		enabled = resolvedDefault();
		syncInheritDirective(enabled);
		reflectState(ctx);
	});

	pi.registerCommand("eos-guard", {
		description:
			"Toggle special-token cut prevention (context defusing + model rule) for this session",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
			} else if (arg === "") {
				enabled = !enabled;
			} else {
				ctx.ui.notify(`Usage: /eos-guard [on|off] — currently ${enabled ? "on" : "off"}`, "warning");
				return;
			}
			syncInheritDirective(enabled);
			reflectState(ctx);
			ctx.ui.notify(
				enabled
					? "eos-guard ON — special tokens will be defused in context and the model gets the no-verbatim rule"
					: "eos-guard OFF — context passes through unmodified",
				"info",
			);
		},
	});

	pi.on("before_agent_start", async (event) => {
		notifiedThisRun = false;
		if (!enabled) return;
		return { systemPrompt: event.systemPrompt + SYSTEM_PROMPT_RULE };
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		const count = sanitizeMessages(event.messages, DEFAULT_PATTERNS);
		if (count === 0) return;

		if (DEBUG) {
			console.error(`[eos-guard] defused ${count} special-token occurrence(s) in outgoing context`);
		}
		if (!notifiedThisRun && ctx.hasUI) {
			notifiedThisRun = true;
			ctx.ui.notify(`eos-guard: defused ${count} special-token occurrence(s) in context`, "info");
		}
		// event.messages is a deep copy; return it so the sanitized copy is used.
		return { messages: event.messages };
	});
}
