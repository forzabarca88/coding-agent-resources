/**
 * ralph-loop-prompt — keep the ralph-loop orchestrator protocol alive across compaction.
 *
 * Problem: a prompt template expands into a USER message, and user messages are exactly
 * what compaction summarizes away. The ralph loop is a long-running orchestrator protocol;
 * after a mid-loop compaction its phases, delegation rules, and model-assignment contract
 * would survive only as a lossy summary — derailing the rest of the run.
 *
 * Fix: while a ralph loop is active in this session, append the template's contents
 * (minus YAML frontmatter) as a dedicated system-prompt section. pi rebuilds the system
 * prompt fresh for EVERY request and never compacts or summarizes it, so the protocol
 * survives any number of compactions verbatim.
 *
 * Append-only by construction: the pin is added by mutating
 * `event.systemPromptOptions.sections` — pi's structured, per-section diffable prompt
 * state. The handler never returns `{ systemPrompt }`, which pi implements internally as
 * `forceSystemPrompt`, a whole-prompt replacement for the run. Existing sections and the
 * default prompt are never touched, and unchanged content produces no transcript delta,
 * so pinning is cache-friendly across loop turns.
 *
 * Activation:
 *   /ralph-loop <REQ>   auto-activates the pin for this session — the `input` event sees
 *                       the raw text BEFORE template expansion (agent-session.prompt runs
 *                       input handlers before expandPromptTemplate), so the loop's very
 *                       first run is already protected
 *   /ralph-loop-prompt  toggle for this session; `on`/`off` set it explicitly
 *
 * Scope: session-scoped. Extension instances are fresh per session, so the pin resets on
 * /new and /reload; after /resume, re-arm with `/ralph-loop-prompt on`. Subagent sessions
 * do not need the pin: the protocol governs the orchestrator, which already frames each
 * subagent's task itself.
 *
 * Template source: PI_RALPH_LOOP_PROMPT overrides the path; otherwise the installed pi
 * layout (`~/.pi/agent/prompts/ralph-loop.md`, as install_for_pi.sh creates — a symlink,
 * so repo edits apply immediately) and then the repository-relative path are tried. The
 * file is re-read on every pinned run, so edits to the template apply on the next turn
 * without restarting the loop.
 *
 * Place in ~/.pi/agent/extensions/ (global) or .pi/extensions/ (project-local).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Structured system-prompt section the pinned protocol is appended under. */
export const SECTION_NAME = "ralph_loop_prompt";

/** Template filename, shared by both default candidate locations. */
const TEMPLATE_FILENAME = "ralph-loop.md";

/** Path override for non-standard layouts (e.g. project-local extension installs). */
const PATH_OVERRIDE_VAR = "PI_RALPH_LOOP_PROMPT";

/** Raw input that IS a ralph-loop template invocation (start-anchored, word-bounded). */
export const INVOCATION_PATTERN = /^\/ralph-loop(?:\s|$)/;

/**
 * Strip the YAML frontmatter pi's template loader consumes (description,
 * argument-hint). It is template plumbing, not prompt content.
 */
export function stripFrontmatter(source: string): string {
	const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(source);
	return match ? source.slice(match[0].length) : source;
}

function templatePaths(): string[] {
	const override = process.env[PATH_OVERRIDE_VAR];
	if (override) return [override];
	return [
		// Installed pi layout (install_for_pi.sh symlinks prompts/ into ~/.pi/agent).
		join(homedir(), ".pi", "agent", "prompts", TEMPLATE_FILENAME),
		// Repository checkout, when pi runs from the repo root without installing.
		join("prompts", TEMPLATE_FILENAME),
	];
}

function readTemplate(): string | undefined {
	for (const path of templatePaths()) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Try the next candidate location.
		}
	}
	return undefined;
}

function sectionContent(template: string): string {
	const body = stripFrontmatter(template).trim();
	return [
		`Ralph loop protocol, pinned verbatim from prompts/${TEMPLATE_FILENAME} when the loop was invoked. This section is part of the system prompt and is never compacted or summarized; follow it for the whole loop even if earlier conversation turns were summarized away. The literal $@ marks where the invoked requirement was substituted.`,
		body,
	].join("\n\n");
}

export default function (pi: ExtensionAPI) {
	// Session-scoped state; the instance is fresh per /new, /resume, and /reload.
	let active = false;
	// Last successfully read template — the fallback if the file becomes
	// unreadable mid-loop, so a deleted file degrades to a stale pin instead
	// of a silently unprotected run.
	let lastContent: string | undefined;

	const reflectState = (ctx: ExtensionContext) => {
		// Persistent footer indicator so an active pin is never invisible.
		// Clearing with undefined removes the status entirely.
		if (ctx.hasUI) ctx.ui.setStatus("ralph-loop-prompt", active ? "ralph-loop: pinned" : undefined);
	};

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	pi.on("input", async (event, ctx) => {
		// Observe-only: return nothing so the invocation proceeds untouched.
		if (active || !INVOCATION_PATTERN.test(event.text)) return;
		const template = readTemplate();
		if (template === undefined) {
			notify(ctx, `ralph-loop-prompt: template not found (searched ${templatePaths().join(", ")}) — the loop is NOT protected from compaction`, "warning");
			return;
		}
		lastContent = template;
		active = true;
		reflectState(ctx);
		notify(ctx, "ralph-loop-prompt: protocol pinned to the system prompt (survives compaction) — /ralph-loop-prompt off to release", "info");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!active) return;
		const template = readTemplate() ?? lastContent;
		if (template === undefined) {
			// Unreachable while active (activation stores content), but guard
			// anyway so a run can never fail because of this extension.
			notify(ctx, "ralph-loop-prompt: template unreadable — this run is NOT protected from compaction", "warning");
			return;
		}
		lastContent = template;
		// Append-only: add a dedicated section to the structured prompt state.
		// Never return { systemPrompt } — pi implements that as forceSystemPrompt,
		// a whole-prompt replacement for the run.
		event.systemPromptOptions.sections[SECTION_NAME] = sectionContent(template);
	});

	pi.registerCommand("ralph-loop-prompt", {
		description: "Toggle pinning the ralph-loop protocol into the system prompt (survives compaction)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				active = arg === "on";
			} else if (arg === "") {
				active = !active;
			} else {
				notify(ctx, `Usage: /ralph-loop-prompt [on|off] — currently ${active ? "on" : "off"}`, "warning");
				return;
			}
			reflectState(ctx);
			notify(ctx, active
				? "ralph-loop-prompt ON — the ralph-loop protocol is pinned into the system prompt and survives compaction"
				: "ralph-loop-prompt OFF — the protocol lives only in conversation history again",
				"info");
		},
	});
}
