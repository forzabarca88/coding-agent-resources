# Coding Agent Resources

A collection of agents, extensions, prompts, and skills for use with [pi coding agent](https://github.com/Earendil-Works/pi-coding-agent).

## Overview

This repository contains reusable components that can be symlinked into pi's agent directory (`~/.pi/agent/`) to extend its capabilities. The `install_for_pi.sh` script automates this process.

## Structure

```
coding-agent-resources/
├── agents/           # Agent definitions (planner, reviewer, scout, worker)
├── extensions/       # Pi extensions (auto-recover, followup, provider-health-check, success-tone)
│   └── subagent/     # Subagent extension
├── prompts/          # Pre-defined prompt templates (ralph-loop)
├── references/       # Reference documentation (currently empty)
├── skills/           # Skill packages
│   └── codeberg-repo-management/  # Codeberg/Forgejo API management
│       ├── references/             # API documentation and guides
│       └── scripts/                # Helper scripts (cb.py)
├── install_for_pi.sh # Installation script
├── AGENTS.md        # Core principles and project guidelines
└── LICENSE          # MIT License
```

## Installation

Run the installation script to symlink all resources into pi's agent directory:

```bash
./install_for_pi.sh
```

Use `--dry-run` to preview changes without making them:

```bash
./install_for_pi.sh --dry-run
```

## Components

### Agents

Pre-configured agent definitions with specific roles:

- **planner** - Creates implementation plans from context and requirements
- **reviewer** - Reviews code changes for quality, security, and maintainability  
- **scout** - Performs fast codebase reconnaissance and returns compressed context
- **worker** - Executes implementation tasks with full tool access

### Extensions

Pi extensions that add new functionality:

- **auto-recover.ts** - Detects unexecuted tool calls and prompts the model to continue
- **followup.ts** - Registers `/followup` command for queuing messages after current turn
- **provider-health-check.ts** - Monitors LLM provider health
- **success-tone.ts** - Adjusts model tone for successful completions
- **subagent/** - Subagent management extension

### Prompts

Pre-defined prompt templates for common workflows:

- **ralph-loop.md** - Iterative development loop (Reconnaissance-Act-Loop-Plan-Home)

### Skills

Specialized skill packages for specific domains:

- **codeberg-repo-management** - Manage Codeberg repositories via Forgejo REST API
  - Full API coverage for repos, files, branches, PRs, issues, releases, etc.
  - Helper script (`cb.py`) for API interactions
  - Comprehensive reference documentation

## Usage

### Using Agents

Reference agents in your pi configuration or invoke them directly:

```
subagent(agent="scout", task="Investigate the codebase...")
```

### Using Extensions

Place extension files in `~/.pi/agent/extensions/` for global use, or `.pi/extensions/` for project-local use.

### Using Skills

Skills are automatically available when symlinked. Reference them by name in agent tasks.

## License

MIT License - Copyright (c) 2026 JustinDC

See [LICENSE](LICENSE) for full license text.
