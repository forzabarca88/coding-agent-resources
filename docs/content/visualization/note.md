Each point is one successful run, plotted by how it performed:

- **Total Context Used** — how many tokens were used by the model to solve the tasks.
- **Turns** — the number of turns taken by the turn to solve the tasks.

The less of each, the better. Points are coloured by model, with direct labels where space allows; hover or click a point for its full record in a tooltip.

**Quadrants.** The dashed lines split the plot at the midpoint of each axis. The bottom-left region (least context, fewest turns) is shaded strongest as the *best region*; the two adjacent quadrants step down; the top-right (most context, most turns) is faintest.

**Wildcard search.** The Models filter accepts `*` and `?` wildcards, and can filter on  model name or notes such as quant - e.g.:

- `*qwen*` — every qwen run
- `openrouter/*` — every provider run
- `Q4` — every run whose notes mention Q4
- `Q2_K_XL` — only the runs quantised at Q2_K_XL, not every run of the same model

**Sources.** Cloud results are labelled *Provider*; runs on the local test machines are labelled *Local* — for information on machine specs refer to [Evaluation results](evaluation-results.html).
