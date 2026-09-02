# AGENTS.md — docs/

This folder is the static documentation site: plain HTML/CSS/JS with **no build step**, publishable straight from `docs/` on GitHub Pages. Every block of written content — paragraphs, notes, machine specs, page blurbs — lives as human-edited markdown under `content/`; the HTML pages are shells that fetch those files at runtime and render them with `marked` (loaded from a CDN). There is never anything to rebuild or redeploy for a wording change: edit the `.md` and reload the page.

## Content model

- One markdown file per visible content block, named after the page/section it belongs to:

  ```
  content/
  ├── index.md                       # index.html subtitle
  ├── pages.md                       # published-page registry (rendered by index.html)
  ├── overall-findings.md            # shared "Overall findings" block (one file, both data pages)
  ├── evaluation-results/
  │   ├── masthead.md                # results page subtitle
  │   ├── intro.md                   # intro paragraph + callout note
  │   └── specs.md                   # machine specs card + run command
  └── visualization/
      ├── masthead.md                # chart page subtitle
      ├── note.md                    # "Reading the chart" note
      └── breakdown.md               # "Runs by model" ranges-chart note
  ```

- A content slot is any element with a `data-content="content/<path>.md"` attribute. `assets/content.js` fetches the file and replaces the slot's inner HTML with the rendered markdown. Slots must stay free of prose.
- `data-content-mode="page-index"` (on `index.html`'s page list) is a special mode: `content/pages.md` is a list of `## [Title](page.html)` headings each followed by one description paragraph, rebuilt into the ledger-style items. Adding a page = one heading + one paragraph.
- HTML keeps only structure and UI chrome: head metadata (`title`, `description`), nav/footer links, section headings with chips (`Data`, `Hardware`, `Read`), filter controls, the results/chart sections. Comments in JS that explain behaviour are code documentation, not content — they stay in the code.

## Editing written content

1. Find the block: match the page section to `content/...`.
2. Edit the markdown. Inline code (backticks), links, emphasis, blockquotes, tables, and fenced code blocks are all supported.
3. Reload the page — content is re-fetched per visit (`cache: no-store`).

> **Trust boundary**: markdown is rendered as-is by `marked` (no sanitisation) and injected via `innerHTML`, so raw HTML in a content file executes in the browser. Content files are repository-controlled and trusted, but never paste third-party HTML into them.

## Conventions to respect

- On `evaluation-results.html`, the "Total Context Used" callout is a `blockquote` in `content/evaluation-results/intro.md`; it is styled by `.intro__md > blockquote`. If it is changed to a plain paragraph, its callout styling is lost.
- The machine specs are markdown tables in `content/evaluation-results/specs.md` — first column is the spec label (styled as a `dt`), `###` headings name the machines, and the table header row is intentionally hidden. Do not add a fourth column.
- The run command on the same page is a fenced code block; `.specs__md pre::before` adds the `$ ` prompt, so do not type a `$` prefix in the file.
- The "Overall findings" section on `evaluation-results.html` and `visualization.html` is one shared file, `content/overall-findings.md`: both pages point a slot at it, so one edit updates both. It renders inside a native `<details class="findings">` (collapsed on load, no JS) whose `<summary>` row is the whole toggle — do not add a second heading around it, do not set `open` in the HTML, and do not split the file per page.
- `data/eval-results.md` is generated data — `agent-evaluation/run-eval.sh` appends rows. Never edit it by hand; it is not content markdown.
- How a markdown construct renders is defined **once** in `assets/styles.css`, in the shared "Rendered markdown" block: `:is()` rules over the slot classes (`.masthead__subhead`, `.intro__md`, `.specs__md`, `.viz__md`, `.brk__md`, `.findings__md`) plus the `.md` results container cover paragraphs, lists, inline code, fenced code blocks, blockquotes, `strong`, headings and tables, so identical markdown renders identically in every slot. (`em` needs no rule — the browser's italics apply; links use the global link rule.) The shared block sits **before** the slot sections so slot overrides win.
- Slot sections in `styles.css` only add tone (colour/size/line-height on the slot container, so `li`/`code`/`strong` inherit it), measure (`p { max-width }` — per-paragraph, since a container max-width would clip the wide results tables), trailing-spacing cleanup, and slot-specific components: the specs machine grid + `$ ` prompt, the wide `.md` results tables, the `.intro__md > blockquote` callout, and the findings `<details>` toggle chrome. Do not add per-construct prose rules to a slot, and do not reuse the `.md` class on content slots — it also carries the wide results-table rules. `.content-error` stays a slot-specific failure style.

## Adding a page

1. Create `foo.html` (copy an existing page's shell).
2. Add its content files under `content/` (at least one slot to point at them).
3. Add the page to the site nav and footer on **every** HTML page.
4. Register it in `content/pages.md` with `## [Title](foo.html)` plus one description paragraph.

## Structure

```
docs/
├── AGENTS.md                     # This file — the content-editing pattern
├── index.html                    # Shell: subtitle + page registry (both from content/)
├── evaluation-results.html       # Shell: intro, note, specs + live results tables
├── visualization.html            # Shell: reading-note + interactive chart
├── content/                      # Human-edited markdown — all written content
│   ├── index.md                  # Index page subtitle
│   ├── pages.md                  # Published-page registry
│   ├── overall-findings.md       # Shared "Overall findings" block (one file, both data pages)
│   ├── evaluation-results/       # Results page content (masthead, intro, specs)
│   └── visualization/            # Chart page content (masthead, note, breakdown)
├── data/
│   └── eval-results.md           # Single canonical results file; run-eval.sh appends runs here (data, not prose)
├── assets/
│   ├── styles.css                # Site stylesheet (shared rendered-markdown rules + slot overrides)
│   ├── content.js                # Fetches content/*.md into [data-content] slots (marked)
│   ├── site.js                   # Shared site behaviour (active page in nav)
│   ├── results.js                # Fetches data/eval-results.md and renders it as HTML
│   └── visualization.js          # Plots eval results as a scatter chart
└── tests/
    ├── visualization-search.test.mjs # End-to-end wildcard-search tests (run: node --test 'docs/tests/*.test.mjs')
    └── findings-slot.test.mjs        # Shared Overall-findings block tests (run: node --test 'docs/tests/*.test.mjs')
```

## Workflow for agents

- When asked to change any wording on the site, edit the `.md` under `content/` — never inline prose in the HTML.
- `assets/visualization.js`'s wildcard search matches each run's model name and Notes, with `*`/`?` able to span both fields (a NUL joins them in `searchHaystack`, so literal text cannot bridge). `tests/visualization-search.test.mjs` covers the semantics — run it with `node --test 'docs/tests/*.test.mjs'` after changing that logic.
- After adding/renaming/removing a content file, grep the HTML for `data-content="content/...` to keep slots in sync, and re-check `docs/README`-adjacent docs (root `README.md`) if page-level behaviour changed.
- The pattern lives here so future agents know: content = `content/*.md`, chrome = HTML, behaviour = JS, styles = `assets/styles.css` (shared rendered-markdown typography first, slot tone/components after).