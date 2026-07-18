# AGENTS.md

## Core Principles

- **DESIGN AND BUILD PRODUCTION GRADE CODE FROM THE START** - i.e. no monolithic files if they should be  modularised, no unnecessary duplication of code, no hardcoded values if they can be placed in a centralised config file, etc.
- Keep AGENTS.md minimal - **only** keep information which will be required every time you look at this codebase. `Repository Structure` should **always** be kept up to date, and include a CONCISE single sentence description of each file in the project.  Do not modify `Core Principles`, but review and remove anything else from the document which is not required.
- After completing any task, always review/amend any related README.md file(s) to ensure that they remain correct. 
- Do **not** make assumptions without testing and validating first. Follow the scientific method.
- Write the bare minimum of tests - follow **ARRANGE, ACT, ASSERT**. You must test the end result, NOT the implmentation details.
- Use mocks for testing sparingly - if the code requires excessive mocking, then redesign the implementation to be easier to test.
- **You must assume that your knowledge is outdated** - always research topics and frameworks before making decisions.

## Important Notes

### Project Structure

```
coding-agent-resources/
├── AGENTS.md                 # Core principles and project guidelines
├── LICENSE                   # MIT License
├── README.md                 # Repository overview and usage instructions
├── install_for_pi.sh         # Installation script for symlinking resources to pi
├── agents/
│   ├── README.md             # Agent definitions overview
│   ├── planner.md            # Creates implementation plans from context and requirements
│   ├── reviewer.md           # Reviews code changes for quality, security, and maintainability
│   ├── scout.md              # Performs fast codebase reconnaissance and returns compressed context
│   └── worker.md             # Executes implementation tasks with full tool access
├── extensions/
│   ├── README.md             # Extensions overview
│   ├── auto-recover.ts       # Detects unexecuted tool calls and prompts model to continue
│   ├── followup.ts           # Registers /followup command for queuing messages after current turn
│   ├── provider-health-check.ts # Monitors LLM provider health
│   ├── success-tone.ts       # Adjusts model tone for successful completions
│   └── subagent/
│       ├── README.md         # Subagent extension documentation
│       ├── index.ts          # Subagent extension entry point
│       └── agents.ts         # Subagent management utilities
├── prompts/
│   ├── README.md             # Prompts overview
│   └── ralph-loop.md         # Iterative development loop prompt template
├── references/
│   └── README.md             # References overview
└── skills/
    ├── README.md             # Skills overview
    └── codeberg-repo-management/
        ├── README.md         # Codeberg repo management skill documentation
        ├── SKILL.md          # Skill definition and configuration
        ├── references/
        │   ├── README.md     # Reference documentation overview
        │   ├── agent-workflow-rules.md # Workflow rules for the agent
        │   ├── codeberg-api-quirks.md # Codeberg API specific behaviors
        │   ├── codeberg-merge-verification.md # Merge verification procedures
        │   ├── codeberg-pr-branch-pitfalls.md # PR branch common issues
        │   ├── pr-merge-sync.md # PR merge synchronization guide
        │   └── swagger.v1.json # Forgejo API specification
        └── scripts/
            ├── README.md     # Scripts documentation
            └── cb.py         # Codeberg API helper script
```
