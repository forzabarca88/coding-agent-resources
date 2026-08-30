# Extensions

Pi coding agent extensions that add new functionality and behaviors.

## Overview

Extensions are TypeScript modules that hook into pi's event system to provide additional capabilities. They can register commands, modify agent behavior, or add UI notifications.

## Available Extensions

### [auto-recover.ts](./auto-recover.ts)
- **Purpose**: Detects when an agent run ends with an interrupted attempt (an unexecuted trailing tool call, or an empty completion after a tool result)
- **Behavior**: Automatically queues a user message prompting the model to continue
- **Trigger**: `agent_end` (primary) — the recovery follow-up is queued before pi decides whether to continue, so the agent loop keeps going and the recovery runs inside the same prompt call (essential for single-shot `--mode json`/`--mode print`, where pi exits as soon as a run settles). `agent_settled` (fallback) catches the case where an `input`-handling extension made the queueing asynchronous.
- **Features**:
  - Strict trigger: only fires when the END of the final assistant message is an interrupted attempt — either a structured, unexecuted `toolCall` part, final text/thinking that literally ends with a leaked tool-call tag (e.g. Gemma's `<|tool_call|>call:...<tool_call|>`), or an EMPTY assistant message that directly follows a tool result whose own toolCall is present in the branch (a mid-task blank completion)
  - Never fires on messages that merely mention tool-call syntax and end in normal prose
  - stopReason-aware: user-aborted frames (`"aborted"`) never trigger nor reset; provider-error frames (`"error"`) never reset the guard, are deferred to pi's own auto-retry at `agent_end`, and are only recovered by the `agent_settled` fallback if retries leave the run interrupted
  - Gives up after 3 consecutive interrupted runs without a normal completion (at most 2 recovery attempts, then a latch until a normal run; error/aborted runs neither count nor reset the latch)
  - Tolerates pi's shutdown/replacement race: a run aborted during shutdown still emits `agent_end`/`agent_settled` after the extension runtime is invalidated, and the handler then bails quietly instead of throwing a stale-ctx error
  - Known limitation: the `agent_settled` fallback starts a fresh run, which never executes in single-shot `--mode json`/`--mode print` (the process exits at settlement) — so an error-interrupted run in those modes (retries disabled / non-retryable provider error) is not recovered; non-error interruptions are recovered in-process via the `agent_end` path
  - Provides UI notifications for recovery status

### [followup.ts](./followup.ts)
- **Purpose**: Registers `/followup` command for queuing messages
- **Behavior**: 
  - If agent is idle: sends message immediately (triggers new turn)
  - If agent is streaming: queues message for delivery after current turn ends
- **Command**: `/followup <message>`
- **Features**:
  - Prevents message loss during active processing
  - Provides feedback via UI notifications

### [provider-health-check.ts](./provider-health-check.ts)
- **Purpose**: Monitors LLM provider health and availability
- **Features**:
  - Tracks provider response times
  - Detects provider failures
  - Provides health status notifications
  - Can trigger fallback providers

### [success-tone.ts](./success-tone.ts)
- **Purpose**: Adjusts model tone for successful task completions
- **Features**:
  - Detects successful task completion patterns
  - Modifies prompt context to encourage positive reinforcement
  - Provides completion summaries

### [subagent/](./subagent/)
- **Purpose**: Subagent management and coordination
- **Components**:
  - [agents.ts](./subagent/agents.ts) - Subagent definitions
  - [index.ts](./subagent/index.ts) - Main subagent extension
- **Features**:
  - Manages subagent lifecycle
  - Handles context passing between agents
  - Provides subagent coordination utilities

## Installation

### Global Installation

Place extension files in `~/.pi/agent/extensions/` to make them available to all projects.

### Project-Local Installation

Place extension files in `.pi/extensions/` within your project directory.

### Using the Install Script

Run the repository's install script to symlink all extensions:

```bash
./install_for_pi.sh
```

## Extension API

Extensions receive an `ExtensionAPI` object with the following methods:

```typescript
interface ExtensionAPI {
  on(event: string, handler: Function): void
  registerCommand(name: string, options: CommandOptions): void
  sendUserMessage(message: string, options?: MessageOptions): void
  // ... and more
}
```

## Creating Extensions

To create a new extension:

1. Create a `.ts` file in this directory
2. Export a default function that receives the `ExtensionAPI`
3. Register event handlers or commands in the function

Example structure:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("agent_start", (event, ctx) => {
    // Handle agent start
  });
  
  pi.registerCommand("mycommand", {
    description: "My command description",
    handler: async (args, ctx) => {
      // Handle command
    }
  });
}
```

## Available Events

Common events to hook into:

- `agent_start` - Fired when an agent starts processing
- `agent_end` - Fired when an agent finishes processing
- `message` - Fired when a message is sent or received
- `tool_call` - Fired when a tool is called
- `tool_result` - Fired when a tool returns a result

## Best Practices

- **Minimal impact**: Extensions should have minimal performance impact
- **Clear feedback**: Use UI notifications to inform users of extension actions
- **Error handling**: Handle errors gracefully and provide useful error messages
- **Configuration**: Consider making extension behavior configurable

## See Also

- [Pi Extension Documentation](https://github.com/Earendil-Works/pi-coding-agent/docs/extensions.md)
- [Main README](../README.md) - Repository overview
