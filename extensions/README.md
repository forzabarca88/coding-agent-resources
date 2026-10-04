# Extensions

Pi coding agent extensions that add new functionality and behaviors.

## Overview

Extensions are TypeScript modules that hook into pi's event system to provide additional capabilities. They can register commands, modify agent behavior, or add UI notifications.

## Available Extensions

### [auto-recover.ts](./auto-recover.ts)
- **Purpose**: Detects when an agent run ends with an interrupted attempt (an unexecuted trailing tool call, an empty completion after a tool result, or a thinking-only turn cut by a special-token stop)
- **Behavior**: Automatically queues a user message prompting the model to continue
- **Trigger**: `agent_end` (primary) — the recovery follow-up is queued before pi decides whether to continue, so the agent loop keeps going and the recovery runs inside the same prompt call (essential for single-shot `--mode json`/`--mode print`, where pi exits as soon as a run settles). `agent_settled` (fallback) catches the case where an `input`-handling extension made the queueing asynchronous.
- **Features**:
  - Strict trigger: only fires when the END of the final assistant message is an interrupted attempt — either a structured, unexecuted `toolCall` part, final text/thinking that literally ends with a leaked tool-call tag (e.g. Gemma's `<|tool_call|>call:...<tool_call|>`), an EMPTY assistant message that directly follows a tool result whose own toolCall is present in the branch (a mid-task blank completion), or a message containing ONLY thinking (no text, no tool call) that ended with stopReason `"stop"`/`"length"` — the signature of a server-side EOS cut (a llama.cpp/LM Studio server consumed a chat-template special token the model emitted as literal text, stripped it, and returned finish_reason `"stop"`) or of a max-token cut of a long thinking block
  - Never fires on messages that merely mention tool-call syntax and end in normal prose
  - stopReason-aware: user-aborted frames (`"aborted"`) never trigger nor reset — and abort-shaped errorMessages (e.g. `"This operation was aborted"` from an ESC or `/hold`, which pi's provider setup phase classifies as an `"error"` stop) count as user aborts too, except timeouts (`"The operation was aborted due to timeout"`), which are real failures and still recover; provider-error frames (`"error"`) never reset the guard, are deferred to pi's own auto-retry at `agent_end`, and are only recovered by the `agent_settled` fallback if retries leave the run interrupted
  - Gives up after 3 consecutive interrupted runs without a normal completion (at most 2 recovery attempts, then a latch until a normal run; error/aborted runs neither count nor reset the latch)
  - Tolerates pi's shutdown/replacement race: a run aborted during shutdown still emits `agent_end`/`agent_settled` after the extension runtime is invalidated, and the handler then bails quietly instead of throwing a stale-ctx error
  - Known limitation: the `agent_settled` fallback starts a fresh run, which never executes in single-shot `--mode json`/`--mode print` (the process exits at settlement) — so an error-interrupted run in those modes (retries disabled / non-retryable provider error) is not recovered; non-error interruptions are recovered in-process via the `agent_end` path. An EOS cut that lands mid-TEXT (after visible prose was already emitted) is indistinguishable from a legitimate final sentence and is not recovered — the eos-guard extension prevents that case upstream
  - Provides UI notifications for recovery status

### [eos-guard/](./eos-guard/)
- **Purpose**: Prevents llama.cpp/LM Studio servers from cutting turns mid-generation when the model emits a chat-template special token as literal text (e.g. while discussing GGUF tokenizer internals)
- **Opt-in**: OFF by default — both hooks below only apply after `/eos-guard` (toggle), `/eos-guard on`/`off`, or `PI_EOS_GUARD=1` (per-session default). The system-prompt rule and context rewriting change model behavior for every turn, so they must never apply uninvited; the footer shows a persistent `eos-guard on` indicator while active, and state resets to the default on /new, /resume, and /reload
- **Behavior while enabled**:
  - `context` hook — before every LLM call, defuses special-token spellings (`<|...|>` pipe tokens, `</s>`, `[INST]`, `<<SYS>>`) anywhere in the outgoing payload — tool results, assistant thinking/text, tool-call arguments, user text — by swapping ASCII delimiters for lookalike Unicode (guillemets/mathematical brackets). Non-destructive: the session record keeps originals; only the request payload changes. The exact byte sequence that tokenizes to the special token never reaches the model, so it cannot echo it back by copy; sanitization is idempotent
  - `before_agent_start` hook — appends a system-prompt rule telling the model to refer to special tokens by name/id instead of writing them verbatim (covers tokens the model knows from pretraining, which context sanitization cannot remove)
- **Scope**: covers the main session and, via directive inheritance, every subagent session spawned from it — the workers doing the special-token-heavy work are exactly the sessions that need the guard. The top-level session publishes its resolved state to `PI_EOS_GUARD_INHERIT` ("1"/"0") at `session_start` and on every toggle; subagent processes (which carry spawn-set `PI_SUBAGENT_DEPTH`, the same channel pattern as the subagent extension uses) read that directive as their default instead of the shell env. Top-level sessions never read the directive, so a toggle stays session-scoped and cannot leak into the next session on /new or /resume. Recovery from cuts that still happen is auto-recover's job — the two are designed as prevention + recovery layers
- **Debug**: set `PI_EOS_GUARD_DEBUG=1` to log defuse counts to stderr

### [followup.ts](./followup.ts)
- **Purpose**: Registers `/followup` command for queuing messages
- **Behavior**: 
  - If agent is idle: sends message immediately (triggers new turn)
  - If agent is streaming: queues message for delivery after current turn ends
- **Command**: `/followup <message>`
- **Features**:
  - Prevents message loss during active processing
  - Provides feedback via UI notifications

### [hold.ts](./hold.ts)
- **Purpose**: Registers `/hold` command (a toggle — repeat `/hold` while armed to disarm it) — the automated, deferred equivalent of pressing ESC: stops the session's processing at the END of the current agent turn
- **Behavior**:
  - If agent is busy: arms the hold; the current turn (its LLM call plus every tool call in it) completes normally, then the session stops; pi stays open for the next prompt. A second `/hold` while armed disarms it: submissions flow again, no aborts happen, and (if before the current turn's `turn_end`) the stop is cancelled entirely
  - If agent is idle: no turn in progress — notifies that the session is already stopped
- **Command**: `/hold`
- **Implementation**: pi fires `turn_end` after EVERY assistant message and the agent loop keeps going while tool calls are pending, so merely reporting the stop at `turn_end` would not stop the session (the loop starts the next LLM call right after). The hold therefore: (1) rejects EVERY submission while armed at the `input` gate — mid-run `steer`/`followUp` offers AND idle submissions, which is the shape recovery messages from extensions (e.g. auto-recover) arrive in while the session settles — interactive submissions are put back into the editor (like ESC), extension/RPC submissions are dropped with a notification; (2) on the first `turn_end` after arming, calls `ctx.abort()` (the same operation ESC performs) so the loop's next LLM call fails before any provider work and the run ends — pi never auto-retries an abort, and auto-recover ignores abort-shaped stops (including the one pi classifies as `"error"` with the abort reason as errorMessage); (3) stays armed until `agent_settled`, aborting any continuation run (pi auto-retry, compaction, or queued-message continuation) that starts meanwhile at its `agent_start` before it does work, and disarms one macrotask after `agent_settled` so messages other extensions queue from their own `agent_settled` handlers are dropped regardless of extension load order; shows a persistent footer status while armed. Covers the TUI's mid-stream Enter (steer) and Alt+Enter (follow-up) submissions and extension `sendUserMessage(..., { deliverAs })`; note pi's raw RPC `steer`/`follow_up` commands bypass the input gate entirely
- **Features**:
  - Never cuts a turn short (unlike ESC/abort) and never exits pi (unlike shutdown)
  - Nothing queued after `/hold` continues the session (raw RPC `steer`/`follow_up` commands and custom messages bypass the input gate and are not covered); messages already queued before it are restored to the editor by the abort in the TUI (like ESC), and in other modes are either recorded at the stop point without being processed or left queued for the next prompt
  - Repeat `/hold` while armed is a toggle: it disarms the hold (clearing the status and cancelling an unfired stop); the armed state otherwise survives until just after the session settles (cleared on `/reload`/`/new`, which recreate the extension)

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
  - [tests/resilience.test.mjs](./subagent/tests/resilience.test.mjs) - End-to-end network-resilience tests (doubles as a fake `pi` executable)
  - [tests/render.test.mjs](./subagent/tests/render.test.mjs) - Result-view rendering tests (expanded shows full steps, collapsed keeps previews)
- **Features**:
  - Manages subagent lifecycle
  - Handles context passing between agents
  - Provides subagent coordination utilities
  - Shows the compaction count of each completed subagent session next to its duration in the result panel
  - Expanded result view (Ctrl+O) shows every step in full — complete commands and tool arguments, never truncated — while the collapsed view keeps one-line previews
  - Network resilience: transient provider/network failures are survived by resuming the invocation's private session after exponential backoff (default up to 5 resumptions, raise `PI_SUBAGENT_RETRY_MAX_RESUMES` for longer outages); permanent errors fail immediately

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
