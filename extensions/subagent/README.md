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

The extension can be configured through the pi configuration file:

```json
{
  "extensions": {
    "subagent": {
      "maxParallel": 5,
      "timeout": 300,
      "retryOnFailure": true,
      "maxRetries": 3
    }
  }
}
```

## API

### Subagent Configuration

```typescript
interface SubagentConfig {
  agent: string;           // Agent name
  task: string;            // Task description
  cwd?: string;            // Working directory
  context?: Record<string, any>;  // Additional context
  timeout?: number;        // Timeout in seconds
  retry?: boolean;         // Retry on failure
}
```

### Execution Modes

- **single**: Execute one subagent
- **parallel**: Execute multiple subagents concurrently
- **chain**: Execute subagents sequentially with context passing

## Best Practices

- **Context size**: Keep context passed between agents focused and relevant
- **Error handling**: Always handle potential subagent failures
- **Timeouts**: Set appropriate timeouts for long-running tasks
- **Result validation**: Validate subagent results before proceeding

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

## See Also

- [Extensions README](../README.md) - Parent directory documentation
- [Main README](../../README.md) - Repository overview
