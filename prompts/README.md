# Prompts

Pre-defined prompt templates for common development workflows.

## Overview

These prompts provide structured templates for coordinating multi-agent workflows. They define the conversation flow, agent interactions, and output formats for complex tasks.

## Available Prompts

### [ralph-loop.md](./ralph-loop.md)
- **Description**: Iterative development loop (Reconnaissance-Act-Loop-Plan-Home)
- **Purpose**: Orchestrates a complete development workflow using multiple agents
- **Workflow**:
  1. **Reconnaissance (Scout)**: Investigate the codebase
  2. **Plan**: Create implementation plan
  3. **Act**: Execute tasks via workers
  4. **Loop**: Review and iterate
  5. **Home**: Final summary

## RALPH Loop Details

The RALPH loop is designed for complex development tasks that require multiple iterations:

### Phase 1: Reconnaissance (Scout)
- Uses the **scout** agent to investigate the codebase
- Returns structured findings without making changes
- Output includes: Files Retrieved, Key Code, Architecture, Start Here

### Phase 2: Plan
- Uses the **planner** agent to create an implementation plan
- Breaks work into small, actionable tasks
- Output includes: Goal, Plan (numbered steps), Files to Modify, New Files, Risks

### Phase 3: Per-Task Worker Dispatch
- Uses **worker** agents to implement each task
- Each worker receives: task description, scout context, full plan
- Each worker operates independently on one specific task
- Verifies completion before dispatching next worker

### Phase 4: Review
- Uses the **reviewer** agent to validate changes
- Checks for: quality, security, maintainability
- Output includes: Files Reviewed, Critical, Warnings, Suggestions, Summary

### Phase 5: Iterative Loop
- Tracks review cycles (max 3 to prevent infinite loops)
- **Suggestions only**: Implementation complete
- **Warnings only**: Spawn worker with feedback, re-review
- **Critical findings**: Re-run scout/planner as needed, then dispatch workers

### Phase 6: Home (Final Summary)
- Compiles final summary of all work
- Includes: what was built, files changed, review status, remaining notes

## Usage

To use a prompt, reference it in your pi configuration or invoke it directly:

```
Use the ralph-loop prompt for this task: "Implement feature X"
```

Or invoke it programmatically:

```javascript
// Use the RALPH loop for a development task
subagent({
  agent: "orchestrator",
  task: "Use the RALPH loop to implement: Add user authentication"
})
```

## Prompt Format

Prompts follow this structure:

```markdown
---
description: "Brief description of the prompt's purpose"
argument-hint: "<PLACEHOLDER>"
---

You are the [role] for [workflow]. [Instructions]

[Detailed workflow description]

## Phase 1 - [Phase Name]
[Phase instructions]

## Phase 2 - [Phase Name]
[Phase instructions]

...
```

## Creating Custom Prompts

To create a custom prompt:

1. Create a `.md` file in this directory
2. Add YAML frontmatter with description and argument hint
3. Define the workflow and agent interactions
4. Specify output formats for each phase

## Best Practices

- **Clear phases**: Define distinct, logical phases
- **Agent roles**: Assign appropriate agents to each phase
- **Context passing**: Specify what context to pass between phases
- **Output formats**: Define structured output for each phase
- **Error handling**: Include instructions for handling failures
- **Iteration limits**: Set maximum iteration counts to prevent infinite loops

## See Also

- [Agents](../agents/README.md) - Agent definitions used in prompts
- [Main README](../README.md) - Repository overview
