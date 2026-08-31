This page contains the results of an evaluation harness which sends the coding agent a task within [https://github.com/forzabarca88/coding-agent-resources/tree/main/agent-evaluation](https://github.com/forzabarca88/coding-agent-resources/tree/main/agent-evaluation).

It logs how it performed in terms of:

- whether the model generated code which passed the tasks
- how long it took in terms of turns and time
- how much context it consumed

Please note that the default output token limit was set to 64000 unless specified otherwise.

> **Note on Total Context Used** (observed 2026-08-22): per-turn totals are prompt + completion as reported by the provider, so a decrease is only possible if the provider under-reports the prompt. As of this date, OpenRouter's `gpt-5.6-luna` drops the previous assistant completion from the next turn's usage (13 per-turn drops in one 98-turn session), while `deepseek-v4-flash` reports the full prompt every turn (0 drops; totals strictly increasing). Treat the column as provider-reported and not directly comparable across providers — re-verify this behaviour before cross-provider token comparisons, as it may change.
