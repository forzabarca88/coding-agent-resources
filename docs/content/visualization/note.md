Each point in this scatter plot is one **successful** run, plotted by how it performed.

Each point represents its run visually in three ways.

- **Model identifier** (fill)
- **Model quant** (shape)
  - Represents the model's quantisation (e.g. Q4_K_M)
  - "None" means no quantisation
- **KV quant** (outline)
  - The outline colour is the KV cache quantisation used for that run (e.g. Q4_0)
  - "None" means KV cache was not quantised for that run

The bottom-left shaded region (least context, fewest turns) can be considered as the *optimal* result.

**Wildcard search:** The Models filter can filter model name or notes such as quantisation - e.g.:

- `qwen` — every qwen run
- `Q2_K_XL` — only the runs quantised at Q2_K_XL
- `Model quant:*Q4_K_XL` — only the runs whose **Model quant** is Q4_K_XL
- `KV quant:*None` — only the runs whose **KV quant** is None
- `qwen3.8-27b*Q4_0` - Only Qwen 3.8 27B with Q4_0 in its notes

For information on machine specs, refer to [Evaluation results](evaluation-results.html).
