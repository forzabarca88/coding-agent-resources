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

### [index.ts](./index.ts)
- **Purpose**: Main subagent extension implementation
- **Features**:
  - Subagent lifecycle management
  - Context isolation and sharing
  - Result aggregation
  - Error handling and recovery

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

## See Also

- [Extensions README](../README.md) - Parent directory documentation
- [Main README](../../README.md) - Repository overview
