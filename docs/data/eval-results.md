# Evaluation Results (Provider)

| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |
|---|---|---|---|---|---|---|---|---|---|---|
| openrouter/openai/gpt-5.6-sol | thinking: medium | 2m 17s | 45496 | 19 | 128000 | No | 0 | 247 | 0 | 2026-08-08 13:37 |
| openrouter/openai/gpt-5.6-luna | thinking: xhigh | 3m 55s | 52210 | 26 | 128000 | No | 0 | 247 | 0 | 2026-08-07 14:00 |
| openrouter/xiaomi/mimo-v2.5-pro | thinking: high | 5m 49s | 67944 | 35 | 128000 | No | 0 | 247 | 0 | 2026-08-08 13:09 |
| openrouter/deepseek/deepseek-v4-flash-0731 | thinking: xhigh | 24m 45s | 103218 | 60 | 128000 | No | 0 | 247 | 0 | 2026-08-05 22:59 |
| openrouter/deepseek/deepseek-v4-flash | version: 0423, thinking: xhigh | 12m 54s | 106855 | 43 | 128000 | No | 0 | 247 | 0 | 2026-08-03 17:01 |
| mistral/mistral-medium-latest | interrupted, vitest failed | 41m 3s | 128266 | 216 | 128000 | Yes | 1 | 238 | 9 | 2026-08-03 18:25 |

# Evaluation Results (Local)

| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |
|---|---|---|---|---|---|---|---|---|---|---|
| lmstudio-jdcmedia/deepreinforce-ai/ornith-1.0-35b | quant: Q4_K_M, KV quant: Q8_0 | 70m 43s | 96197 | 138 | 128000 | No | 0 | 247 | 0 | 2026-08-03 23:23 |
| lmstudio-jdcmedia/deepreinforce-ai/ornith-1.0-35b | quant: Q4_K_M, KV quant: Q8_0 | 78m 24s | 109184 | 133 | 128000 | No | 0 | 247 | 0 | 2026-08-05 21:31 |
| lmstudio-jdc-ws/deepreinforce-ai/ornith-1.0-35b | quant: Q4_K_M, KV quant: Q8_0 | 49m 20s | 111640 | 160 | 128000 | No | 0 | 247 | 0 | 2026-08-17 17:23 |
| lmstudio-jdc-ws/ornith-ai/ornith-1.0-35b | quant: Q8_0, KV quant: Q8_0 | 56m 51s | 114180 | 105 | 128000 | No | 0 | 247 | 0 | 2026-08-17 20:36 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q4_0 | 71m 13s | 115361 | 93 | 128000 | No | 0 | 247 | 0 | 2026-08-03 18:44 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q4_0 | 64m 30s | 123968 | 96 | 128000 | No | 0 | 247 | 0 | 2026-08-05 20:18 |
| lmstudio-jdc-ws/qwen/qwen3.8-27b | quant: Q4_K_M, KV quant: Q4_0, thinking: xhigh, MTP | 135m 0s | 144189 | 60 | 196000 | No | 0 | 247 | 0 | 2026-08-19 23:47 |
| lmstudio-jdc-ws/qwen/qwen3.8-27b | quant: Q4_K_M, KV quant: Q4_0, thinking: low, MTP, vitest failed | 111m 0s | 123925 | 51 | 128000 | Yes | 1 | 246 | 1 | 2026-08-17 21:46 |
| lmstudio-jdc-ws/unsloth/qwen3.8-27b | quant: Q4_K_XL, KV quant: Q4_0, thinking: low, MTP, vitest failed | 117m 3s | 123924 | 37 | 128000 | Yes | 1 | 236 | 11 | 2026-08-17 18:12 |
| lmstudio-jdc-ws/unsloth/ornith-1.0-35b | quant: Q8_K_XL, KV quant: Q8_0, vitest failed | 90m 1s | 124066 | 37 | 128000 | Yes | 1 | 226 | 21 | 2026-08-17 15:42 |
| lmstudio-jdc-ws/unsloth/qwen3.8-27b | quant: Q4_K_XL, KV quant: Q4_0, thinking: xhigh, MTP, vitest failed | 125m 40s | 123916 | 41 | 128000 | No | 1 | 224 | 23 | 2026-08-16 15:49 |
| lmstudio-jdcmedia/deepreinforce-ai/ornith-1.0-9b | quant: Q4_K_M, KV quant: Q8_0, vitest failed, thinking hit output limit | 71m 56s | 167439 | 141 | 262000 | Yes | 1 | 169 | 78 | 2026-08-04 12:31 |
| lmstudio-jdc-ws/unsloth/muse-glimmer-30b | quant: Q4_K_XL, KV quant: Q8_0, thinking: high, vitest failed, exhibits laziness | 102m 6s | 126998 | 257 | 131000 | Yes | 1 | 165 | 82 | 2026-08-18 21:01 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q4_0, vitest failed | 27m 52s | 81307 | 22 | 80000 | Yes | 1 | 133 | 114 | 2026-08-03 22:43 |
| lmstudio-jdcmedia/deepreinforce-ai/ornith-1.0-9b | quant: Q4_K_M, KV quant: None, vitest failed | 31m 44s | 122292 | 49 | 128000 | Yes | 1 | 130 | 117 | 2026-08-04 11:16 |
| lmstudio-jdcmedia/unsloth/qwen3.5-9b | quant: Q8_0, KV quant: Q8_0, vitest failed | 46m 14s | 124153 | 119 | 128000 | Yes | 1 | 128 | 119 | 2026-08-04 10:07 |
| lmstudio-jdcmedia/unsloth/qwen3.6-27b | quant: Q3_K_S, KV quant: Q8_0, vitest failed | 37m 42s | 86454 | 25 | 80000 | Yes | 1 | 121 | 126 | 2026-08-03 21:25 |
| lmstudio-jdc-ws/unsloth/laguna-s-2.1 | quant: Q4_K_XL, KV quant: Q8_0, thinking: off, vitest failed, tool hit output limit | 266m 3s | 119010 | 25 | 128000 | No | 1 | 98 | 149 | 2026-08-18 16:00 |
| lmstudio-jdcmedia/unsloth/gemma-4-31b-it | quant: IQ3_XXS, KV quant: Q4_0, vitest failed | 19m 28s | 55377 | 21 | 48000 | Yes | 1 | 67 | 149 | 2026-08-04 12:09 |
| lmstudio-jdcmedia/unsloth/gemma-4-12b-it-qat | quant: Q4_K_XL, KV quant: Q8_0, vitest failed, tool call formatting issues | 2m 45s | 25421 | 14 | 128000 | No | 1 | 13 | 234 | 2026-08-04 11:55 |
| lmstudio-jdcmedia/lmstudio-community/bonsai-27b | quant: Q1_0, KV quant: Q8_0, vitest failed, garbled response issues | 40m 9s | 81315 | 38 | 128000 | No | 1 | 26 | 133 | 2026-08-07 23:00 |
| lmstudio-jdc-ws/unsloth/laguna-s-2.1 | quant: Q4_K_XL, KV quant: Q8_0, vitest failed, thinking hit output limit | 208m 53s | 104868 | 8 | 128000 | No | 1 | 13 | 10 | 2026-08-18 12:14 |
| lmstudio-jdc-ws/unsloth/gemma-4-31b-it-qat | quant: Q4_K_XL, KV quant: Q4_0, vitest failed, tool call formatting issues | 21m 56s | 44128 | 20 | 131000 | No | 1 | 19 | 0 | 2026-08-20 19:08 |
| lmstudio-jdcmedia/unsloth/gemma-4-12b-it-qat | quant: Q4_K_XL, KV quant: Q8_0, vitest failed, tool call formatting issues | 2m 55s | 37761 | 16 | 128000 | No | 1 | ? | ? | 2026-08-04 11:13 |
| lmstudio-jdc-ws/unsloth/qwen3.8-27b | quant: Q4_K_XL, KV quant: Q4_0, thinking: xhigh | 130m 20s | 132392 | 50 | 196000 | No | 0 | 247 | 0 | 2026-08-21 08:47 |
| lmstudio-jdc-ws/unsloth/qwen3.6-27b-mtp | quant: Q4_K_XL, KV quant: Q4_0 | 26m 2s | 70436 | 46 | 131000 | No | 0 | 247 | 0 | 2026-08-21 10:57 |
| lmstudio-jdc-ws/unsloth/qwen3.6-27b-mtp | quant: Q4_K_XL, KV quant: Q4_0, vitest failed | 50m 42s | 126940 | 106 | 131000 | No | 1 | 245 | 2 | 2026-08-21 12:20 |
| lmstudio-jdc-ws/unsloth/qwen3.6-27b-mtp | quant: Q4_K_XL, KV quant: Q4_0, preserve thinking: false | 45m 50s | 105611 | 79 | 131000 | No | 0 | 247 | 0 | 2026-08-21 13:41 |
| lmstudio-jdc-ws/unsloth/qwen3.8-27b | quant: Q4_K_XL, KV quant: Q4_0, thinking: medium | 85m 3s | 100050 | 67 | 131000 | No | 0 | 247 | 0 | 2026-08-21 14:27 |
