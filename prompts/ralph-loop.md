---
description: "Iterative dev loop: scout, plan, implement per-task, review, repeat until satisfied"
argument-hint: "<REQ>"
---

You are the **orchestrator** for an iterative development loop (RALPH: Reconnaissance-Act-Loop-Plan-Home). Your job is to delegate all work to subagents and coordinate the results. Never read or edit files directly unless absolutely necessary.

Use individual `subagent` calls (not `chain`) so you retain full control and context between phases.

## Phase 1 — Reconnaissance (Scout)

Spawn the `scout` agent with the requirement and any relevant file paths:

```
subagent(agent="scout", task="$@")
```

Capture and retain the scout's output (Files Retrieved, Key Code, Architecture, Start Here). This context feeds every subsequent phase.

## Phase 2 — Plan

Spawn the `planner` agent, feeding it the original requirement **plus** the scout's output:

```
subagent(agent="planner", task="$@\n\nScout context:\n{scout_output}")
```

Capture the plan (Goal, Plan steps, Files to Modify, New Files, Risks). The plan must break work into the **smallest practical tasks** so individual workers can handle each independently.

## Phase 3 — Per-Task Worker Dispatch

For **each task** in the planner's numbered list, spawn a **separate** `worker` subagent:

```
subagent(agent="worker", task="Task N: {task_description}\n\nScout context:\n{scout_output}\n\nFull plan:\n{plan}")
```

- Each worker receives the specific task description, relevant scout context, and the full plan.
- **Verify** each worker's completion (files changed, key functions touched) before dispatching the next.
- After all tasks are done, compile a summary of all changes (files changed, key functions touched) to feed the reviewer.

## Phase 4 — Review

Spawn the `reviewer` agent with the compiled changes and file paths:

```
subagent(agent="reviewer", task="Review the following changes:\n\n{changes_summary}\n\nFiles to review:\n{file_paths}")
```

Capture the reviewer's output (Critical, Warnings, Suggestions, Summary).

## Phase 5 — Iterative Loop

**Loop counter**: Track review cycles. Stop after a maximum of **3 review cycles** to prevent infinite loops.

- **If reviewer reports only Suggestions** (no Critical or Warnings): implementation is complete — exit the loop.
- **If reviewer reports Warnings only** (no Critical): spawn a `worker` with the reviewer's feedback to apply fixes, then re-review.
- **If reviewer reports Critical findings** (architectural problems, fundamental flaws): use your discretion to re-run `scout` and/or `planner` before dispatching new workers.

Repeat Phase 3 (worker dispatch) and Phase 4 (review) until the reviewer is satisfied (no Critical or Warnings) or the loop limit is reached.

## Phase 6 — Home (Final Summary)

Output a final summary:

- What was built
- Files changed
- Review status (cycle count, final verdict)
- Any remaining notes or suggestions

---

**Context management**: Retain scout output, plan, and all worker outputs across subagent calls. If the task is large and context is getting full, condense retained information (keep the plan and key findings, drop verbose details).

**Worker isolation**: Each worker runs in an isolated context and does not see other workers' changes. Ensure each worker receives sufficient context from the scout and plan to work independently. When dispatching workers sequentially, the earlier workers' file changes *do* persist on disk, so later workers operate on the updated codebase — but they don't see the earlier workers' output in their context window.

**File path accuracy**: Pass precise file paths and task descriptions to each worker to avoid operating on stale or incorrect information.
