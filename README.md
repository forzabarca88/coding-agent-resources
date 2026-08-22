# Coding Agent Resources

A collection of agents, extensions, prompts, and skills for use with [pi coding agent](https://github.com/Earendil-Works/pi-coding-agent).

## Overview

This repository contains reusable components that can be symlinked into pi's agent directory (`~/.pi/agent/`) to extend its capabilities. The `install_for_pi.sh` script automates this process.

## Structure

```
coding-agent-resources/
├── agents/           # Agent definitions (planner, reviewer, scout, worker)
├── agent-evaluation/  # Evaluation harness (web-agent) with its own README
├── docs/             # Static documentation site (renders eval results live)
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

The script creates `~/.pi/agent` (and each `agents/`, `extensions/`, `prompts/`,
`skills/` category directory) if missing, so it works on a fresh pi install.

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

## Documentation Site

The `docs/` directory contains a static documentation site — plain HTML/CSS/JS with no build step. It is organised as an index page (`index.html`) that lists every published page as a ledger-style entry; each page lives in its own HTML file at the root of `docs/`. To add a page: create the HTML file, add one entry to the index list, and add the page to the site nav and footer (the small link lists shared by every page).

`docs/data/eval-results.md` is the **single canonical results file**. `agent-evaluation/run-eval.sh` appends each run to it directly — there is no other copy anywhere.

Shared styling lives in `assets/styles.css`; `assets/site.js` handles common behaviour (marking the current page in the site nav), while page-specific scripts such as `assets/results.js` are loaded only on the page that needs them.

Serve it locally from the `docs/` folder (or the repository root — either works):

```bash
cd docs
npx serve .          # or: npx http-server .   /   python3 -m http.server
```

### GitHub Pages

Publish the site from the `docs/` folder: **Settings → Pages → Source: Deploy from a branch → Branch: `main` → `/docs`**. The results file sits inside the published folder, so the page always reads the latest committed run — `run-eval.sh --commit` stages it.

### Pages

- **Index** — `index.html`; the landing page, listing all published pages.
- **Evaluation Results** — `evaluation-results.html`; fetches `data/eval-results.md` at runtime and renders it as HTML (live data, no build step).
- **Evaluation Chart** — `visualization.html`; fetches `data/eval-results.md` at runtime and plots successful runs (context used vs turns), coloured by model, with source, multi-select model filters, and a wildcard model search (`*`/`?`, e.g. `*qwen*`, `openrouter/*`). The model chips offered for filtering always match the selected source (Provider/Local/All) and the wildcard search is scoped to that source too.

## License

MIT License - Copyright (c) 2026 JustinDC

See [LICENSE](LICENSE) for full license text.
