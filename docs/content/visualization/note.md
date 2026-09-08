Each point in this scatter plot is one **successful** run, plotted by how it performed.

Each point represents its run visually in three ways.

- **Model identifier** (fill)
- **Quant** (shape)
  - Represents the model's quantisation (e.g. Q4_K_M)
  - "None" means no quantisation
- **KV quant** (outline)
  - The outline colour is the KV cache quantisation used for that run (e.g. Q4_0)
  - "None" means KV cache was not quantised for that run

The core mertrics displayed are:

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

**Sources:** Cloud results are labelled *Provider*, while runs on the local test machines are labelled *Local*.

For information on machine specs, refer to [Evaluation results](evaluation-results.html).
