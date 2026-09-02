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
