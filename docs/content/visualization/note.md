Each point in this scatter plot is one successful run, plotted by how it performed.

**Shapes:** every run keeps the same glyph it has on the range chart below — the
shape marks the weight quantisation, the outline the KV cache quant — only the
fill changes, from status to the model colour. The legend above the plot
carries the range chart's Quant and KV quant keys, joined by a Model key for
the fill colour.

**Point size:** the shared *Small / Medium / Large* control in the filter bar
scales the marks in both charts; *Large* (the default) doubles the scatter's
original size, *Medium* and *Small* declutter dense regions.

**Total Context Used:** How many tokens were used by the model to solve the tasks.

**Turns:** The number of turns taken by the turn to solve the tasks.

**Quadrants:** The dashed lines split the plot at the midpoint of each axis.

The bottom-left shaded region (least context, fewest turns) can be considered as the *optimal* result.

**Wildcard search:** The Models filter can filter model name or notes such as quant - e.g.:

- `qwen` — every qwen run
- `openrouter/` — every provider run
- `Q4` — every run whose notes mention Q4
- `Q2_K_XL` — only the runs quantised at Q2_K_XL, not every run of the same model
- `qwen3.8-27b*Q4_0` - Only Qwen 3.8 27B with Q4 KV cache 

**Sources:** Cloud results are labelled *Provider*; runs on the local test machines are labelled *Local*.

for information on machine specs, refer to [Evaluation results](evaluation-results.html).
