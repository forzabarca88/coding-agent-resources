Each point is one successful run (exit code 0), plotted by how it performed:

- **Total Context Used** — the cumulative context consumed during the run.
- **Turns** — the number of agent turns taken.

The less of each, the better. Points are coloured by model, with direct labels where space allows; hover or click a point for its full record in a tooltip.

**Quadrants.** The dashed lines split the plot at the midpoint of each axis. The bottom-left region (least context, fewest turns) is shaded strongest as the *best region*; the two adjacent quadrants step down; the top-right (most context, most turns) is faintest.

**Default view.** The 25 runs with the least context are shown by default, ranked by context alone. Use the filters above to change the selection — an active search or model selection shows *all* matching runs, so the default 25-run limit no longer applies.

**Wildcard search.** The Models filter accepts `*` and `?` wildcards, tested against each run's model name and Notes, and the runs shown narrow to exactly those that match:

- `*qwen*` — every qwen run
- `openrouter/*` — every provider run
- `Q4` — every run whose notes mention Q4
- `Q2_K_XL` — only the runs quantised at Q2_K_XL, not every run of the same model

**Sources.** Cloud results are labelled *Provider*; runs on the local test machines are labelled *Local* — see the machine specs on [Evaluation results](evaluation-results.html).