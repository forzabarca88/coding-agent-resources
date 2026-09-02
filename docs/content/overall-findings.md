> Last updated on **2 September, 2026**

## Understanding the data

Messages sent from a coding harness to the API (using the `/completions` endpoint) are stateless. This means that the size of the messages always grow as the number of turns increases, as the latest message sent is the combination of the previous message's input + output tokens.

This leads into the metrics which are tracked by this eval - `Context Used` and `Turns`.


### Context Used

This refers to the total number of tokens contained in the **last** message before the eval task was completed.

There are multiple reasons why a lower value for this metric can be considered better:

1. More tokens used = higher cost
1. Less tokens will result in less "pollution" of the context window
1. More tokens will require more memory (usually VRAM due to performance reasons) for storage of past tokens in the KV cache


### Turns

This refers to the total number of input + output token cycles required by the agent to complete the evaluation task.

This metric has a bit more nuance, but generally it is more efficient in terms of cost and duration to complete tasks in as few agent turns as possible.


### Turns + Context

**High turns + Low context:** Large number of tool calls, but limited reasoning tokens.

**Low turns + High context:** Fewer tool calls, but large amount of reasoning and/or tool call output.

A large number of tool calls may suggest:
- Lots of corrections to its created files.
- Lots of repeated tool calls due to aggressive truncation of output in order to reduce context size.

A large amount of reasoning tokens can be useful for reducing the number of turns spent on a complicated task (i.e. less corrections), but for this eval it may suggest that the model "overthinks".

### Recommendations

**The following recommendations are only based on the data collected for this eval** - please keep in mind that this eval does not represent the wide spectrum of software engineering tasks, but only a tiny subset.

- For many models, KV quantization at Q4_0 appears to have minimal impact on the outcome - while providing a substantial increase in the potential size of the context window.
  - E.g. the best `Qwen 3.6 27B` and `Qwen 3.8 27B` runs being at Q4 KV.
- Current non-uniform quantization (specifically `unsloth` as tested) seems very good - it may be preferable to run a larger model at Q3 (or even Q2) rather than a smaller model at Q8.
  - E.g. `Qwen 3.8 27B` at `Q2_K_XL` outperforms all 9B models tested.
- The recommended sampling parameters for each model are extremely important for coherent results - this is very evident in the results of some models such as `Laguna S 2.1` where the incorrect parameters produced far poorer results than the corrected settings.
- **Non-determinism is a feature and not a bug for LLMs.** Results show significant variance across multiple runs for both Provider and Local models - worth keeping in mind during day to day use, as ultimately consistent outputs require deterministic guardrails for any of these models.
  - E.g. difference between best and worst `deepseek-v4-flash-0731` runs at the same `xhigh` reasoning is 30k.
