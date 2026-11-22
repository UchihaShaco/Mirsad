# Evaluation: dev set, lmstudio reviewer

Generated 2026-11-22T00:48:58.126Z. Model: qwen3.5-9b. Transcripts: 9. Incoming messages reviewed: 29.

Synthetic transcripts only. This report holds counts, IDs and timings, never message text or extracted values. See README.md in this folder for how to read it.

| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 29 | 0 | 14 | 0 | 0 | 100.0% | 100.0% | 0 | 4 of 4 | 210 / 250 / 4449 / 6240 |
| Arabic | 9 | 0 | 4 | 0 | 0 | 100.0% | 100.0% | 0 | 1 of 1 | 230 / 257 / 4449 / 4449 |
| English | 10 | 0 | 6 | 0 | 0 | 100.0% | 100.0% | 0 | 2 of 2 | 238 / 1320 / 6240 / 6240 |
| Mixed | 10 | 0 | 4 | 0 | 0 | 100.0% | 100.0% | 0 | 1 of 1 | 210 / 237 / 2961 / 2961 |

## Messages

| Transcript | Message | Language | Expected | TP | FP | FN | Unsupported | Missed | Extra | Latency (ms) | Error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev-ar-01 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 230 | - |
| dev-ar-01 | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 239 | - |
| dev-ar-01 | m4 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 232 | - |
| dev-ar-02 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 264 | - |
| dev-ar-02 | m2 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 3347 | - |
| dev-ar-02 | m4 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 3134 | - |
| dev-ar-03 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 257 | - |
| dev-ar-03 | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 237 | - |
| dev-ar-03 | m4 | ar | 2 | 2 | 0 | 0 | 0 | - | - | 4449 | - |
| dev-en-01 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 240 | - |
| dev-en-01 | m3 | en | 1 | 1 | 0 | 0 | 0 | - | - | 2922 | - |
| dev-en-01 | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 241 | - |
| dev-en-02 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 247 | - |
| dev-en-02 | m3 | en | 1 | 1 | 0 | 0 | 0 | - | - | 2980 | - |
| dev-en-02 | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 250 | - |
| dev-en-02 | m5 | en | 1 | 1 | 0 | 0 | 0 | - | - | 2390 | - |
| dev-en-03 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 238 | - |
| dev-en-03 | m2 | en | 2 | 2 | 0 | 0 | 0 | - | - | 6240 | - |
| dev-en-03 | m4 | en | 1 | 1 | 0 | 0 | 0 | - | - | 3239 | - |
| dev-mixed-01 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 220 | - |
| dev-mixed-01 | m2 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2961 | - |
| dev-mixed-01 | m4 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2682 | - |
| dev-mixed-01 | m5 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 232 | - |
| dev-mixed-02 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 225 | - |
| dev-mixed-02 | m2 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2216 | - |
| dev-mixed-02 | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 210 | - |
| dev-mixed-03 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 242 | - |
| dev-mixed-03 | m2 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 227 | - |
| dev-mixed-03 | m3 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2781 | - |
