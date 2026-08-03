# Evaluation Results

| Date | Model | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08-03 17:01 | openrouter/deepseek/deepseek-v4-flash | 12m 54s | 106855 | 43 | 128000 | No | 0 | 247 | 0 | thinking: xhigh |
| 2026-08-03 18:25 | mistral/mistral-medium-latest | 41m 3s | 128266 | 216 | 128000 | Yes | 1 | 238 | 9 | interrupted, vitest failed |
| 2026-08-03 18:44 | lmstudio-jdcmedia/unsloth/qwen3.6-27b | 71m 13s | 115361 | 93 | 128000 | No | 0 | 247 | 0 | quant: Q3_K_S, KV quant: Q4_0 |
| 2026-08-03 21:25 | lmstudio-jdcmedia/unsloth/qwen3.6-27b | 37m 42s | 86454 | 25 | 80000 | Yes | 1 | 121 | 126 | quant: Q3_K_S, KV quant: Q8_0, vitest failed |
| 2026-08-03 22:43 | lmstudio-jdcmedia/unsloth/qwen3.6-27b | 27m 52s | 81307 | 22 | 80000 | Yes | 1 | 133 | 114 | quant: Q3_K_S, KV quant: Q4_0, vitest failed |
