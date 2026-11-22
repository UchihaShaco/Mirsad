# Evaluation: dev set, lmstudio reviewer

Generated 2026-11-22T03:34:23.920Z. Model: qwen3.5-9b. Transcripts: 12. Incoming messages reviewed: 37.

Synthetic transcripts only. This report holds counts, IDs and timings, never message text or extracted values. See README.md in this folder for how to read it.

| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 37 | 0 | 33 | 0 | 0 | 100.0% | 100.0% | 0 | 9 of 10 | 204 / 251 / 10145 / 24255 |
| Arabic | 12 | 0 | 11 | 0 | 0 | 100.0% | 100.0% | 0 | 3 of 3 | 225 / 248 / 10145 / 10145 |
| English | 13 | 0 | 15 | 0 | 0 | 100.0% | 100.0% | 0 | 5 of 5 | 227 / 2144 / 24255 / 24255 |
| Mixed | 12 | 0 | 7 | 0 | 0 | 100.0% | 100.0% | 0 | 1 of 2 | 204 / 228 / 8104 / 8104 |

## Messages

| Transcript | Message | Language | Expected | TP | FP | FN | Unsupported | Missed | Extra | Latency (ms) | Error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev-ar-01 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 225 | - |
| dev-ar-01 | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 225 | - |
| dev-ar-01 | m4 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 251 | - |
| dev-ar-02 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 237 | - |
| dev-ar-02 | m2 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 2918 | - |
| dev-ar-02 | m4 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 2950 | - |
| dev-ar-03 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 245 | - |
| dev-ar-03 | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 237 | - |
| dev-ar-03 | m4 | ar | 2 | 2 | 0 | 0 | 0 | - | - | 4447 | - |
| dev-ar-04 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 236 | - |
| dev-ar-04 | m2 | ar | 3 | 3 | 0 | 0 | 0 | - | - | 9119 | - |
| dev-ar-04 | m4 | ar | 4 | 4 | 0 | 0 | 0 | - | - | 10145 | - |
| dev-en-01 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 259 | - |
| dev-en-01 | m3 | en | 1 | 1 | 0 | 0 | 0 | - | - | 2909 | - |
| dev-en-01 | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 234 | - |
| dev-en-02 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 242 | - |
| dev-en-02 | m3 | en | 1 | 1 | 0 | 0 | 0 | - | - | 2948 | - |
| dev-en-02 | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 242 | - |
| dev-en-02 | m5 | en | 1 | 1 | 0 | 0 | 0 | - | - | 2144 | - |
| dev-en-03 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 240 | - |
| dev-en-03 | m2 | en | 2 | 2 | 0 | 0 | 0 | - | - | 6196 | - |
| dev-en-03 | m4 | en | 1 | 1 | 0 | 0 | 0 | - | - | 3245 | - |
| dev-en-04 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 227 | - |
| dev-en-04 | m2 | en | 5 | 5 | 0 | 0 | 0 | - | - | 24255 | - |
| dev-en-04 | m4 | en | 4 | 4 | 0 | 0 | 0 | - | - | 9965 | - |
| dev-mixed-01 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 204 | - |
| dev-mixed-01 | m2 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2868 | - |
| dev-mixed-01 | m4 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2033 | - |
| dev-mixed-01 | m5 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 208 | - |
| dev-mixed-02 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 223 | - |
| dev-mixed-02 | m2 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2203 | - |
| dev-mixed-02 | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 208 | - |
| dev-mixed-03 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 224 | - |
| dev-mixed-03 | m2 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 226 | - |
| dev-mixed-03 | m3 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 2532 | - |
| dev-mixed-04 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 230 | - |
| dev-mixed-04 | m2 | mixed | 3 | 3 | 0 | 0 | 0 | - | - | 8104 | - |
