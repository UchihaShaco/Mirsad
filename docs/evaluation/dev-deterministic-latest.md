# Evaluation: dev set, deterministic reviewer

Generated 2026-11-22T03:34:45.542Z. Model: none. Transcripts: 12. Incoming messages reviewed: 37.

Synthetic transcripts only. This report holds counts, IDs and timings, never message text or extracted values. See README.md in this folder for how to read it.

| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 37 | 0 | 21 | 2 | 12 | 91.3% | 63.6% | 0 | 4 of 9 | 0 / 0 / 1 / 3 |
| Arabic | 12 | 0 | 6 | 1 | 5 | 85.7% | 54.5% | 0 | 2 of 3 | 0 / 0 / 3 / 3 |
| English | 13 | 0 | 11 | 0 | 4 | 100.0% | 73.3% | 0 | 2 of 5 | 0 / 0 / 1 / 1 |
| Mixed | 12 | 0 | 4 | 1 | 3 | 80.0% | 57.1% | 0 | 0 of 1 | 0 / 0 / 0 / 0 |

## Messages

| Transcript | Message | Language | Expected | TP | FP | FN | Unsupported | Missed | Extra | Latency (ms) | Error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| dev-ar-01 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 3 | - |
| dev-ar-01 | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 1 | - |
| dev-ar-01 | m4 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-02 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-02 | m2 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-02 | m4 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-03 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-03 | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-03 | m4 | ar | 2 | 0 | 1 | 2 | 0 | payment_recipient, payment_recipient | phone_number | 0 | - |
| dev-ar-04 | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-ar-04 | m2 | ar | 3 | 2 | 0 | 1 | 0 | payment_recipient | - | 1 | - |
| dev-ar-04 | m4 | ar | 4 | 2 | 0 | 2 | 0 | payment_recipient, payment_recipient | - | 0 | - |
| dev-en-01 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 1 | - |
| dev-en-01 | m3 | en | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-01 | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-02 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-02 | m3 | en | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-02 | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-02 | m5 | en | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-03 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-03 | m2 | en | 2 | 1 | 0 | 1 | 0 | payment_recipient | - | 1 | - |
| dev-en-03 | m4 | en | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-04 | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-en-04 | m2 | en | 5 | 4 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| dev-en-04 | m4 | en | 4 | 2 | 0 | 2 | 0 | payment_recipient, payment_recipient | - | 0 | - |
| dev-mixed-01 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-01 | m2 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-01 | m4 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-01 | m5 | mixed | 0 | 0 | 1 | 0 | 0 | - | payment_link | 0 | - |
| dev-mixed-02 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-02 | m2 | mixed | 1 | 0 | 0 | 1 | 0 | phone_number | - | 0 | - |
| dev-mixed-02 | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-03 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-03 | m2 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-03 | m3 | mixed | 1 | 0 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| dev-mixed-04 | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| dev-mixed-04 | m2 | mixed | 3 | 2 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
