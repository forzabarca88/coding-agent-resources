> Last updated on **22 September, 2026**

# Understanding the data

Messages sent from a coding harness to the API (using the `/completions` endpoint) are stateless. This means that the size of the messages always grow as the number of turns increases, as the latest message sent is the combination of the previous message's input + output tokens.

This leads into the metrics which are tracked by this eval - `Context Used` and `Turns`.


## Context Used

This refers to the total number of tokens contained in the **last** message before the eval task was completed.

There are multiple reasons why a lower value for this metric can be considered better:

1. More tokens used = higher cost
1. More tokens will result in more noise and more "pollution" in the context window
1. More tokens will require more memory (usually VRAM due to performance reasons) for storage of past tokens in the KV cache


## Turns

This refers to the **total number of input + output token cycles** required by the agent to complete the evaluation task.

This metric has a bit more nuance, but generally it is more efficient in terms of cost and duration to complete tasks in as few agent turns as possible.


## Interpretting Turns + Context 

**High turns + Low context:** Large number of tool calls, but limited reasoning tokens.

**Low turns + High context:** Fewer tool calls, but large amount of reasoning and/or tool call output.

A large number of tool calls may suggest:
- Lots of corrections to its created files.
- Lots of repeated tool calls due to aggressive truncation of output in order to reduce context size.

A large amount of reasoning tokens can be useful for reducing the number of turns spent on a complicated task (i.e. less corrections), or may even be necessary in order for the model to be able to solve the task.

For this eval, too many tokens compared to other models in the resultset may suggest that the model in question "overthinks".


## Recommendations

**The following recommendations are only based on the data collected for this eval - please keep in mind that this eval does not represent the wide spectrum of software engineering tasks, only a tiny subset.**

### QV cache quantisation

**Claim:** For many models, KV quantization at Q4_0 appears to have minimal impact on the outcome - while providing a substantial increase in the potential size of the context window.

**Evidence:** The best `Qwen 3.6 27B` and `Qwen 3.8 27B` runs recorded were infact at Q4_0.

### Model quantisation

**Claim:** Current non-uniform quantisation (specifically `unsloth` as tested) seems very good at preserving the model's ability to solve problems - it may be preferable to run a larger model at Q3 (or even Q2) rather than a smaller model at Q8.

**Evidence:** `Qwen 3.8 27B` at `Q2_K_XL` and especially at `Q3_K_XL` outperforms all 9B at Q8 models tested.

**Claim:** For smaller models, quantisation may have a more noticable negative impact compared to larger models.

**Evidence:** `Ornith 1.5 35B A3B` did not show any significant improvement in results at BF16 compared to Q8_0. However, `Ornith 1.5 9B` shows a noticable improvement when left at full precision (both weights and KV) compared to the results at Q8_0.


### Sampling parameters

**Claim:** The recommended sampling parameters for each model are extremely important for coherent results - historical assumptions such as lower temperature being better for coding should NOT be followed with current models.

**Evidence:** Evident in the results of some models such as `Laguna S 2.1`, where sampling parameters which did not match the recommended produced far poorer results than the corrected settings. On the flip side, there were instances where "incorrect" parameters produced comparatively better results (some `Ornith 1.5 35B A3B` runs) but this remains inconclusive. 

### Non-determinism

**Claim:** The biggest impact is non-determinism. This is a "feature" for LLMs, and results show significant variance across multiple runs for both Provider and Local models. This is worth keeping in mind during day to day use and when making judgements about the output of your model, as consistency ultimately require deterministic guardrails for any of these models.

**Evidence:** Seen across many results, but a specific example is the best and worst `Deepseek V4 Flash 0731` runs at the same `xhigh` reasoning (up to 30k token variance). A local example is `Qwen 3.6 27B MTP`, where runs with the same settings show similar variations of around 35k tokens.


# FAQ

### Why are you using LM Studio instead of X or Y?

Because it's a solid user experience - it's as simple as that.

The goal of this data is to help newcomers understand the **practical** impacts of quantisation in local LLMs, and from that standpoint I believe LM Studio (and other GUI based options) are a solid starting point instead of dealing with 32534524 command line parameters.

Also, the metrics I'm focused on (Context Used and Turns) are based on the behaviour of the model - not performance based metrics like tokens/sec, which may benefit from running bare `llama.cpp`, `vLLM`, etc.


### Why don't you use a generation seed for more consistent results?

The goal of the eval is to try and collect realistic results - I'm less interested in where a model places on the leaderboard, and more on the characteristics of the model at different quants or reasoning levels.

Using a seed is not how we use the models in the real world, and that invalidates it as a control for this use case.
