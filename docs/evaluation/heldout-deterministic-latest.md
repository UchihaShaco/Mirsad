# Evaluation: heldout set, deterministic reviewer

Generated 2026-11-22T01:33:31.308Z. Model: none. Transcripts: 18. Incoming messages reviewed: 55.

Synthetic transcripts only. This report holds counts, IDs and timings, never message text or extracted values. See README.md in this folder for how to read it.

| Group | Messages | Unavailable | TP | FP | FN | Precision | Recall | Unsupported | Concern agreement | Latency min / median / p95 / max (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Overall | 55 | 0 | 13 | 6 | 8 | 68.4% | 61.9% | 0 | 0 of 4 | 0 / 0 / 1 / 3 |
| Arabic | 19 | 0 | 4 | 2 | 2 | 66.7% | 66.7% | 0 | 0 of 1 | 0 / 0 / 3 / 3 |
| English | 18 | 0 | 3 | 2 | 3 | 60.0% | 50.0% | 0 | 0 of 1 | 0 / 0 / 1 / 1 |
| Mixed | 18 | 0 | 6 | 2 | 3 | 75.0% | 66.7% | 0 | 0 of 2 | 0 / 0 / 0 / 0 |

## Messages

| Transcript | Message | Language | Expected | TP | FP | FN | Unsupported | Missed | Extra | Latency (ms) | Error |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ar-01-gulf-maintenance | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 3 | - |
| ar-01-gulf-maintenance | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 1 | - |
| ar-01-gulf-maintenance | m4 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-02-egyptian-curtains-link | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-02-egyptian-curtains-link | m3 | ar | 2 | 1 | 0 | 1 | 0 | payment_recipient | - | 1 | - |
| ar-02-egyptian-curtains-link | m4 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-03-levantine-sister-call | m1 | ar | 0 | 0 | 1 | 0 | 0 | - | phone_number | 0 | - |
| ar-03-levantine-sister-call | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-03-levantine-sister-call | m4 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| ar-04-msa-course-fee-link | m1 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| ar-04-msa-course-fee-link | m3 | ar | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| ar-04-msa-course-fee-link | m4 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-05-customs-fee-injection | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-05-customs-fee-injection | m2 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-05-customs-fee-injection | m3 | ar | 0 | 0 | 1 | 0 | 0 | - | payment_recipient | 0 | - |
| ar-05-customs-fee-injection | m5 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-06-tracking-then-code | m1 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-06-tracking-then-code | m3 | ar | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| ar-06-tracking-then-code | m4 | ar | 1 | 0 | 0 | 1 | 0 | phone_number | - | 0 | - |
| en-01-delivery-followup | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 1 | - |
| en-01-delivery-followup | m3 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-01-delivery-followup | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-02-catering-invoice | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-02-catering-invoice | m3 | en | 2 | 1 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| en-02-catering-invoice | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-03-cousin-was-called | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-03-cousin-was-called | m3 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-03-cousin-was-called | m4 | en | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| en-04-new-collection-account | m1 | en | 1 | 0 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| en-04-new-collection-account | m3 | en | 1 | 0 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| en-04-new-collection-account | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-05-system-note-injection | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-05-system-note-injection | m2 | en | 1 | 1 | 2 | 0 | 0 | - | payment_recipient, phone_number | 0 | - |
| en-05-system-note-injection | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-06-holding-deposit-no-details | m1 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-06-holding-deposit-no-details | m3 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| en-06-holding-deposit-no-details | m4 | en | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-01-photo-deposit | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-01-photo-deposit | m3 | mixed | 2 | 1 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| mixed-01-photo-deposit | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-02-rent-iban-switch | m1 | mixed | 2 | 1 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| mixed-02-rent-iban-switch | m3 | mixed | 2 | 1 | 0 | 1 | 0 | payment_recipient | - | 0 | - |
| mixed-02-rent-iban-switch | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-03-supplier-no-recipient | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-03-supplier-no-recipient | m3 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-03-supplier-no-recipient | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-04-neighbour-number-injection | m1 | mixed | 0 | 0 | 1 | 0 | 0 | - | phone_number | 0 | - |
| mixed-04-neighbour-number-injection | m3 | mixed | 0 | 0 | 1 | 0 | 0 | - | phone_number | 0 | - |
| mixed-04-neighbour-number-injection | m4 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-05-shop-hours | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-05-shop-hours | m3 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-05-shop-hours | m4 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-06-pickup-map-and-charge | m1 | mixed | 0 | 0 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-06-pickup-map-and-charge | m3 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
| mixed-06-pickup-map-and-charge | m4 | mixed | 1 | 1 | 0 | 0 | 0 | - | - | 0 | - |
