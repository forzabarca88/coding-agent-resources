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

- **auto-recover.ts** - Detects interrupted turns (unexecuted tool calls or blank completions) and prompts the model to continue
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

The `docs/` directory contains a static documentation site — plain HTML/CSS/JS with no build step, publishable straight from the `docs/` folder on GitHub Pages. The HTML files are thin shells: every block of written content (paragraphs, notes, machine specs, the index's page blurbs) lives as markdown under `docs/content/`, one file per block. Pages fetch their content files at runtime and render them with `marked` (loaded from a CDN), so a wording change is just an edit to a `.md` file — nothing to build, nothing to redeploy.

How it works:

- A content slot is any element with a `data-content="content/<path>.md"` attribute; `assets/content.js` fetches the file and replaces the slot's contents with the rendered markdown.
- `index.html`'s published-page list is generated from `content/pages.md` (via `data-content-mode="page-index"`), where each page is a `## [Title](page.html)` heading followed by one description paragraph.
- HTML holds only structure and UI chrome — head metadata, nav/footer links, section headings and chips, filter controls. See `docs/AGENTS.md` for the full pattern.

To change any wording, edit the matching file under `content/`; paths mirror the pages (`content/evaluation-results/specs.md`, `content/visualization/note.md`, …). To add a page: create the HTML shell with its `data-content` slots, add the content files, add the page to the site nav and footer on every page, and register it in `content/pages.md`.

`docs/data/eval-results.md` is the **single canonical results file**. `agent-evaluation/run-eval.sh` appends each run to it directly — there is no other copy anywhere, and it is generated data, not prose, so it is never edited by hand.

Serve it locally from the `docs/` folder (or the repository root — either works):

```bash
cd docs
npx serve .          # or: npx http-server .   /   python3 -m http.server
```

### GitHub Pages

Publish the site from the `docs/` folder: **Settings → Pages → Source: Deploy from a branch → Branch: `main` → `/docs`**. The results file sits inside the published folder, so the page always reads the latest committed run — `run-eval.sh --commit` stages it.

### Pages

- **Index** — `index.html`; the landing page, listing all published pages.
- **Evaluation Result** — `evaluation-results.html`; fetches `data/eval-results.md` at runtime and renders it as HTML (live data, no build step). An interactive filter bar (`assets/results.js`) sits above the tables: a free-text search matches any run cell, a status segmented control narrows to (All / Passed / Failed / Over limit, where Passed means exit code 0 with zero failed tests), and a sort control orders runs by the default ranking (most tests passed, then least context used, then fewest turns, following the source file's intended order), or by date, context, duration, or turns. The status line always reports how many of the total runs are shown, and Clear restores the full table.
- **Evaluation Chart** — `visualization.html`; fetches `data/eval-results.md` at runtime and plots successful runs (context used vs turns), coloured by model, with source, multi-select model filters, and a wildcard search (`*`/`?`, e.g. `*qwen*`, `openrouter/*`) that filters to exactly the runs matching — the pattern is tested against each run's model name and Notes column, so `Q4` shows every run whose notes mention Q4, and `Q2_K_XL` shows only the runs quantised at Q2_K_XL (not every run of the same model). Selecting a model shows all of its successful in-source runs. The model chips offered for filtering always match the selected source (Provider/Local/All) and the wildcard search is scoped to that source too. A chart-specific **Runs** select — "25 with least context" by default — sits in a caption band attached to the scatter figure itself, not in the shared filter bar, so it is visibly specific to the first chart. Below the scatter, a **Runs by Model** (range) chart groups *every* run — passed or failed — by model: one row per model carries range rails for Context Used and Turns. A **Context Used / Turns** toggle shows one rail at a time, and the chosen scale is pinned above the rows as they scroll, so the value is never scrolled out of view. Each mark encodes status (carbon = success, red = failed), weight quantisation by shape, and KV quant by its real value (Q4_0, Q8_0, None…, with None dashed); a stacked bar shows each model's pass/fail split. Marks open the same tooltip as the scatter. Both charts share the filters, but the top-N limit applies to the scatter only.

## License

MIT License - Copyright (c) 2026 JustinDC

See [LICENSE](LICENSE) for full license text.
