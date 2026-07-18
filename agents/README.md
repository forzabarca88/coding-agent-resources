# Agents

Pre-configured agent definitions for use with pi coding agent.

## Overview

These agents are designed to work together in a coordinated workflow, each with specific responsibilities and tool access levels. They follow the principle of separation of concerns - read-only agents gather information and plan, while the worker executes changes.

## Available Agents

### [planner.md](./planner.md)
- **Role**: Creates implementation plans from context and requirements
- **Tools**: `read`, `grep`, `find`, `ls` (read-only)
- **Purpose**: Receives context from scout and requirements, produces clear implementation plans
- **Output**: Goal, Plan (numbered steps), Files to Modify, New Files, Risks

### [reviewer.md](./reviewer.md)
- **Role**: Reviews code changes for quality, security, and maintainability
- **Tools**: `read`, `grep`, `find`, `ls`, `bash` (read-only)
- **Purpose**: Validates worker output, identifies issues and improvements
- **Output**: Files Reviewed, Critical (must fix), Warnings (should fix), Suggestions (consider), Summary

### [scout.md](./scout.md)
- **Role**: Fast codebase reconnaissance
- **Tools**: `read`, `grep`, `find`, `ls`, `bash` (read-only)
- **Purpose**: Quickly investigates codebase and returns structured findings for other agents
- **Output**: Files Retrieved, Key Code, Architecture, Start Here

### [worker.md](./worker.md)
- **Role**: Executes implementation tasks
- **Tools**: Full capabilities (`read`, `write`, `edit`, `bash`, etc.)
- **Purpose**: The only agent that makes changes to the codebase
- **Output**: Completed, Files Changed, Notes

## Usage Pattern

The agents are designed to work together in a pipeline:

```
Scout → Planner → Worker(s) → Reviewer → (Iterate)
```

1. **Scout** investigates the codebase and returns structured findings
2. **Planner** creates an implementation plan based on scout's findings
3. **Worker(s)** execute individual tasks from the plan
4. **Reviewer** validates the changes
5. **Iterate** based on reviewer feedback

## Agent Capabilities

| Agent | Read Files | Write Files | Execute Commands | Make Changes |
|-------|-----------|-------------|------------------|--------------|
| scout | ✅ | ❌ | ✅ | ❌ |
| planner | ✅ | ❌ | ✅ | ❌ |
| reviewer | ✅ | ❌ | ✅ | ❌ |
| worker | ✅ | ✅ | ✅ | ✅ |

## Best Practices

- **Scout first**: Always start with scout to gather context
- **Plan thoroughly**: Use planner to break work into small, actionable tasks
- **Isolate workers**: Each worker should handle one specific task
- **Review everything**: Always run reviewer on completed work
- **Limit iterations**: Cap review cycles to prevent infinite loops (recommended max: 3)

## File Format

Each agent definition follows this structure:

```markdown
---
name: agent-name
description: Brief description of the agent's purpose
tools: comma-separated-list
template: optional template reference
---

You are a [role]. [Instructions for the agent]

[Detailed guidance on behavior, output format, etc.]
```

## See Also

- [RALPH Loop Prompt](../prompts/ralph-loop.md) - Iterative development workflow using these agents
- [Main README](../README.md) - Repository overview
