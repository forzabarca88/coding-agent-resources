# Subagent Extension

Subagent management and coordination extension for pi coding agent.

## Overview

This extension provides enhanced subagent capabilities, allowing for more sophisticated agent coordination and context management.

## Components

### [agents.ts](./agents.ts)
- **Purpose**: Subagent definitions and configuration
- **Features**:
  - Subagent role definitions
  - Context passing utilities
  - Agent capability specifications
  - Reads an optional `model` field from each agent's frontmatter (canonical `provider/id` reference). When omitted or set to `Default`, the subagent inherits the parent's current model.

### [index.ts](./index.ts)
- **Purpose**: Main subagent extension implementation
- **Features**:
  - Subagent lifecycle management
  - Context isolation and sharing
  - Result aggregation
  - Error handling and recovery
  - Defaults to the parent's current model (resolved as a canonical `provider/id` reference so a mid-session model switch is honoured even when multiple providers share the same model id); an agent's `model` frontmatter overrides this
  - Per-invocation model overrides via the `model` (single mode) / `models` ({agentName: `provider/id`}) / per-item `model` parameters, so different agents can run on different models without editing agent markdown
  - Live thinking tail in the expanded panel: streams the last 15 lines of a reasoning model's thinking in realtime (throttled), cleared at each turn end so finalized reasoning is never retained or surfaced to the parent context
  - Live response tail in the expanded panel: streams the last 15 lines of the assistant's response text in realtime (throttled, same mechanism as the thinking tail); cleared at each turn end, after which the finalized text renders as Markdown in the Output section
  - Compaction count in the result panel: the number of times the subagent session was compacted (successful `compaction_end` events) is shown next to the session duration in the completed result summary line
  - Network resilience: survives transient provider/network failures (timeouts, connection drops, 5xx/429 responses, DNS errors) by resuming the invocation's private session after exponential backoff — see [Network Resilience](#network-resilience); the number of resumptions is reported in the completed result summary line (e.g. `2 network resumes`)

## Recursion Guard

The extension enforces a **single level of nesting** to prevent runaway
recursion. Each spawned subagent process inherits an environment variable
`PI_SUBAGENT_DEPTH` incremented by one. A process whose depth is at or above
`MAX_SUBAGENT_DEPTH` (currently `1`) does **not** register the `subagent` tool
at all — so a subagent literally has no way to spawn further subagents, rather
than failing at call time.

Practical effect:

- The top-level agent (depth 0) may spawn subagents (depth 1).
- Those subagents have no `subagent` tool available and cannot recurse.

Because the tool is absent rather than erroring, no model tokens are wasted on
doomed recursive calls. To allow deeper trees, raise `MAX_SUBAGENT_DEPTH` in
`index.ts` (the child depth is always `parentDepth + 1`).

## Usage

The subagent extension is automatically loaded when placed in the extensions directory. It provides:

- **Parallel execution**: Run multiple subagents concurrently
- **Sequential execution**: Run subagents in sequence with context passing
- **Result aggregation**: Collect and combine results from multiple subagents
- **Error handling**: Manage failures in subagent execution

## Example Usage

### Parallel Subagents

```javascript
subagent({
  tasks: [
    { agent: "scout", task: "Investigate module A" },
    { agent: "scout", task: "Investigate module B" }
  ],
  mode: "parallel"
})
```

### Sequential Subagents with Context

```javascript
subagent({
  chain: [
    { agent: "scout", task: "Investigate codebase" },
    { agent: "planner", task: "Create plan using {previous}" },
    { agent: "worker", task: "Implement plan" }
  ],
  mode: "chain"
})
```

## Configuration

There is no pi settings-file configuration for this extension. All knobs are
environment variables (read at invocation time, so they can be set per shell
session) or constants in `index.ts`:

| Variable / constant | Default | Purpose |
| --- | --- | --- |
| `PI_SUBAGENT_RETRY_BASE_MS` | `10000` | Base delay for transient-failure resumptions (doubles each time) |
| `PI_SUBAGENT_RETRY_MAX_DELAY_MS` | `120000` | Cap on the backoff delay |
| `PI_SUBAGENT_RETRY_MAX_RESUMES` | `100` | Maximum resumptions per invocation before it fails (0 disables resumption) |
| `PI_SUBAGENT_DEPTH` | `0` | Set automatically by the extension; do not set manually |
| `MAX_PARALLEL_TASKS` (code constant) | `8` | Hard cap on `tasks` array length |
| `MAX_CONCURRENCY` (code constant) | `4` | Max simultaneous subagent processes |

## API

### Parameters

```typescript
interface SubagentParams {
  agent?: string;      // Agent name (single mode)
  task?: string;       // Task description (single mode)
  cwd?: string;        // Working directory
  model?: string;      // Model override, canonical `provider/id` (single mode)
  models?: Record<string, string>;  // Per-agent model overrides
  tasks?: Array<{ agent: string; task: string; cwd?: string; model?: string }>;  // Parallel mode
  chain?: Array<{ agent: string; task: string; cwd?: string; model?: string }>;  // Sequential mode, {previous} placeholder
}
```

### Execution Modes

- **single**: Execute one subagent (`agent` + `task`)
- **parallel**: Execute multiple subagents concurrently (`tasks`)
- **chain**: Execute subagents sequentially with context passing (`chain`, `{previous}` placeholder)

## Best Practices

- **Context size**: Keep context passed between agents focused and relevant
- **Error handling**: Always handle potential subagent failures (`isError` is set on the result)
- **Result validation**: Validate subagent results before proceeding

## Network Resilience

Each subagent invocation runs in a **private, persistent session file** (created
in a per-call temp directory) instead of pi's stateless `--no-session` mode.
When the child process ends on a transient provider/network error — classified
with pi's own retryable-error patterns (timeouts, connection failures, DNS
errors, HTTP 429/5xx) — the extension:

1. Emits a live status update naming the error and the wait time.
2. Waits with exponential backoff (base `PI_SUBAGENT_RETRY_BASE_MS`, doubling,
capped at `PI_SUBAGENT_RETRY_MAX_DELAY_MS`), respecting abort the whole time.
3. Resumes the session file with a continuation prompt that tells the
   subagent its previous turn failed and that it should verify its work and
   continue. The full conversation history is preserved, so no progress is
   lost.

This repeats up to `PI_SUBAGENT_RETRY_MAX_RESUMES` times (default 100 — with
the default backoff that spans several hours, comfortably covering a 15-minute
or longer network outage; set 0 to disable resumption entirely). Permanent
errors (e.g. invalid API key, auth failures) are **not** resumed — they fail
immediately with the provider error. Only the most recent run's output is
inspected when deciding whether to resume: a crash *during* resumption is
never misread as the original transient error. The number of resumptions is exposed per result as `networkResumes`
and rendered in the completed result summary line (e.g. `2 network resumes`),
next to the session duration and compaction count.

If the network stays down past the resume budget the invocation fails with
the provider error; nothing hangs, and aborting the parent session at any
point (including mid-backoff) still terminates the invocation promptly.

## Per-Agent Models

Each subagent invocation can target a specific model without editing the agent's
markdown definition. Models are referenced as canonical `provider/id` strings
(e.g. `lmstudio/qwen3.6-27b`, `openrouter/z-ai/glm-5.2`) — the same form used by
`pi --model`.

Resolution precedence (highest first):

1. Per-item `model` on a `tasks`/`chain` entry
2. Top-level `models` map value for the agent name
3. Top-level `model` (single mode only)
4. Agent frontmatter `model` (unless `Default`)
5. Parent's current model

### Assigning models for a whole call

Pass a `models` map so every agent in the call uses its assigned model:

```javascript
subagent({
  agent: "worker",
  task: "Refactor the auth module",
  models: {
    worker: "lmstudio/qwen3.6-27b",
    reviewer: "openrouter/z-ai/glm-5.2",
    scout: "openrouter/z-ai/glm-5.2",
    planner: "openrouter/z-ai/glm-5.2"
  }
})
```

### Single-mode shorthand

```javascript
subagent({
  agent: "reviewer",
  task: "Review the staged diff",
  model: "openrouter/z-ai/glm-5.2"
})
```

### Per-task override

```javascript
subagent({
  tasks: [
    { agent: "worker", task: "Implement A", model: "lmstudio/qwen3.6-27b" },
    { agent: "worker", task: "Implement B", model: "openrouter/z-ai/glm-5.2" }
  ]
})
```

### Persistent defaults

To set a persistent per-agent default without editing markdown every time you
switch, set the `model` field in the agent's frontmatter once. Runtime overrides
above always win, so the frontmatter value acts as a fallback.

## Tests

`node --test extensions/subagent/tests/resilience.test.mjs`

End-to-end resilience tests: the test file doubles as a fake `pi` executable
(the extension spawns child pi processes by re-running `process.argv[1]`, so
when launched with `--mode` the file emulates pi's JSON-mode behaviour,
including session persistence). Covers: normal completion; recovery from
transient failures via real session resumption (the final answer provably sees
the original task plus continuation prompts); no-resume on permanent errors;
no re-resume when a resumed run crashes without frames (stale cross-run error
frames must not trigger further resumes, and the surfaced error must be the
crash, not the stale frame); rerun of the original task when the session file
was never persisted; and abort during a backoff wait.

## See Also

- [Extensions README](../README.md) - Parent directory documentation
- [Main README](../../README.md) - Repository overview
