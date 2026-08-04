# Evaluation Results

| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |
|---|---|---|---|---|---|---|---|---|---|---|
| lmstudio-jdcmedia/ornith-1.0-35b | quant: Q4_K_M, KV quant: Q8_0 | 70m 43s | 96197 | 138 | 128000 | No | 0 | 247 | 0 | 2026-08-03 23:23 |
| openrouter/deepseek/deepseek-v4-flash | thinking: xhigh | 12m 54s | 106855 | 43 | 128000 | No | 0 | 247 | 0 | 2026-08-03 17:01 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q4_0 | 71m 13s | 115361 | 93 | 128000 | No | 0 | 247 | 0 | 2026-08-03 18:44 |
| mistral/mistral-medium-latest | interrupted, vitest failed | 41m 3s | 128266 | 216 | 128000 | Yes | 1 | 238 | 9 | 2026-08-03 18:25 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q4_0, vitest failed | 27m 52s | 81307 | 22 | 80000 | Yes | 1 | 133 | 114 | 2026-08-03 22:43 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q8_0, vitest failed | 37m 42s | 86454 | 25 | 80000 | Yes | 1 | 121 | 126 | 2026-08-03 21:25 |
