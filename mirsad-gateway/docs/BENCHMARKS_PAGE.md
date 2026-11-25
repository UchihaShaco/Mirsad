# Page-content model — benchmarks

Owner: ML (page model). Code: `src/scamshield/models/page_features.py`, `src/scamshield/models/page_model.py`,
`ml/page/`. Results in the shared format: `ml/results/<model>__<dataset>.json` (every model and
baseline, with per-page latency p50 / p95 measured one page at a time).

## TL;DR

**Served system** = `score_page` in the engine with the GPU encoder service up: CPU page model
(page-combo-3) + fine-tuned encoder (page_gte_ft_v2), combined on validation. Thresholds: ≤0.5% FPR on
validation legitimate pages (incl. engine-fetched live pages). Latency: per page, one at a time, through
`score_page` inside the engine container.

| model | pages_test P / R / FPR | R @ FPR 0.1% / 1% | live legitimate test FPR (n=516) | synthetic UAE FPR / R | latency p50 / p95 |
|---|---|---|---|---|---|
| **page_served (CPU + GPU encoder)** | **0.993 / 0.820 / 0.61%** | **0.53 / 0.86** | **0.58% (3)** | 2.0% / 1.00 | **90 / 153 ms** |
| page_combo-3 alone (CPU; fallback path) | 0.988 / 0.385 / 0.48% | 0.24 / 0.46 | 0.00% (0) | 2.7% / 0.95 | 20 / 44 ms (in container) |
| page_gte_ft_v2 alone (GPU) | 0.992 / 0.822 / 0.67% | 0.41 / 0.87 | 0.19% (1) | 0.7% / 1.00 | GPU only (433 ms in the unoptimised eval loop; served path above) |
| page_gte_ft v1 (no live negatives) | 0.994 / 0.822 / 0.53% | 0.56 / 0.89 | 2.71% (14) | 4.8% / 1.00 | – |
| hf_ealvaradob_bert_large (public, HTML) | 0.577 / 0.482 / 36.8% | 0.00 / 0.01 | – | 70% / 1.00 | 3.7 s (1 core) / 53 ms GPU |
| hf_huynq3_mbert_webpage (public) | 0.526 / 0.593 / 55.7% | 0.00 / 0.02 | – | 2.7% / 0.21 | 0.9 s (1 core) / 21 ms GPU |
| hf_horizon_mmbert_scam (public, Arabic-capable) | 0.517 / 0.751 / 73.2% | 0.00 / 0.01 | – | 74% / 1.00 | 1.9 s (1 core) / 43 ms GPU |
| LLM judge, Qwen3.5-9B zero-shot (300-page sample) | 0.901 / 0.487 / 5.3% | – | – | – | 3.8 s (concurrency 1) |
| rules_baseline / keyword_baseline | 0.70 / 0.10 / 4.5% ; 0.46 / 0.20 / 23.8% | ≈0 | – | 0% / 0.97 ; 53% / 0.60 | 6 ms |

* At a realistic **1% scam base rate** (`pages_test_1pct`): served precision 0.58 at recall 0.83;
  CPU alone 0.44 at 0.38; encoder alone 0.56 at 0.83.
* **Arabic** (small sample, 45 pages, 26 scam): served R 0.962, 0 FP; CPU R 0.769; encoder alone
  R 0.962 with 1 FP. **Arabic + Gulf-relevant** (208 pages): served R 0.70, 0 FP; CPU 0.26; encoder 0.73, 1 FP.
* Engine-fetched hard negatives fixed the encoder's live false positives: v1 flagged 14 of 516 unseen
  live legitimate pages (2.7%), v2 flags 1 (0.19%), at the same pages_test recall (0.822). The
  combination trades a little: 3 live FPs, but better recall at 0.1% FPR (0.53 vs 0.41) and no
  Arabic FP. The CPU model retrained with the same negatives (page-combo-3) went from 4 to 0 live
  FPs at unchanged recall (0.385 vs 0.388) and replaced page-combo-2.
* The served system's 3 false positives on the 516 unseen live legitimate pages: a small site's home
  page (0.96), a placeholder page titled after a large online retailer (0.997) and a site builder's
  "connect your domain" error page (0.97).
* When the service is unset, slow (>1.2 s) or down, `score_page` returns the CPU score; killing the
  service mid-run (v2) switched the remaining 217 of 320 pages to the CPU path (p50 20 ms) with 0 errors; slowest page 175 ms.
* The public pretrained page models are at chance on this fresh, domain-disjoint test set
  (ROC-AUC 0.52–0.56). The sections below this TL;DR describe the CPU model and the first round of
  results (pages_test tables for page_combo there are page-combo-2, the version before the live negatives).

## Serving: CPU model + GPU encoder service

```
engine container ── score_page(snapshot) ──► page_features.extract  (CPU, ~6 ms)
                                         ├─► page_combo (TF-IDF LR + LightGBM, CPU, ~3 ms)
                                         └─► POST http://host.docker.internal:8003/score   (only if
                                             SCAMSHIELD_PAGE_ENCODER_URL is set; 1.2 s timeout,
                                             30 s circuit breaker) ─► page encoder on the host GPU
                         served score = logistic combination fitted on validation (page_served.json)
                         no / slow / failed answer ─► the CPU score, exactly as before
```

* Service: `ml/serve/page_encoder_server.py` (FastAPI + uvicorn from `.venv-gpu`, port 8003 on 0.0.0.0,
  bf16, requests pooled for 8 ms / up to 32 texts, input capped at 6,000 characters / 512 tokens /
  32 texts per request, `GET /health`). Start:
  from the repository root, `nohup nice -n 19 .venv-gpu/bin/python -m ml.serve.page_encoder_server > data/page_encoder_server.log 2>&1 &`
  (`SCAMSHIELD_PAGE_ENCODER_DIR` selects the checkpoint).
* Engine side: set `SCAMSHIELD_PAGE_ENCODER_URL=http://host.docker.internal:8003` (passed through by
  `docker-compose.yml`, documented in `.env.example`). The engine builds the encoder text itself
  (`page_features.encoder_input`), so the service never sees raw HTML and fetches nothing.
* `info()["gpu_tier"]` reports the encoder URL, the fitted combination, whether the breaker is open,
  the path of the last score (`combined` / `cpu` / `cpu_fallback` / `abstain`) and counts per path.
  `top_features` always explains the CPU model.
* Combination (`ml/page/fit_served.py`): logistic regression over [CPU logit (0 when the CPU model
  would abstain), encoder logit, abstain flag] on the validation split (18,636 pages incl. 484
  engine-fetched legitimate pages), threshold ≤0.5% FPR on validation legitimate pages.

## Hard negatives fetched by our own engine (live legitimate set)

`ml/page/crawl_legit.py` fetched legitimate pages with `scamshield.engine.fetch_page` (mobile profile,
GET only, concurrency 16): the home pages of Tranco top-1,300 sites plus up to two same-site links each
(login / account / pay links first), and official UAE pages (allowlist domains, the UAE seed list and
Common Crawl URLs from `processed/uae_legit.parquet`, login / payment URLs first). 2,359 pages were kept
(bot challenges, consent walls and error pages included as they came), split by registered domain into
live_train 1,359 / live_val 484 / **live_legit_test 516** (domain-disjoint). Both models were retrained
with live_train added (the encoder sees it 4×); validation thresholds include live_val.

## What the model sees

`page_features.extract(url, html)` runs identically at training time and in the engine (from a
`PageSnapshot`: `html` + `final_url`; `title` / `text` only as fallbacks). The HTML is parsed as
data with selectolax (lexbor); nothing is rendered, executed or fetched. HTML is capped at 300 KB.

* **Text** (TF-IDF model): title, form field names / placeholders / labels, and up to 12k
  characters of visible text, NFKC + lower-cased, Arabic normalised (alef / ya / ta-marbuta /
  hamza forms, tatweel and diacritics removed, Arabic-Indic digits → ASCII). Word 1–2-grams and
  character 2–5-grams (`char_wb`) in one vocabulary for Arabic, English and mixed pages.
* **125 structural / behavioural features**: forms and what they ask for (password, card, OTP,
  national / Emirates ID, bank account, e-mail, phone, personal data — English and Arabic field
  names and labels), form action on another host / `.php` / `mailto:` / empty, inputs outside forms,
  `autocomplete=off`; external / null / `tel:` / `wa.me` link ratios; iframes (hidden, external);
  script count, external-script ratio, inline-script size; scrambling markers (`eval`, `atob`,
  `fromCharCode`, `unescape`, `_0x` identifiers, `\x` escapes, long base64 blobs); Telegram-bot and
  Discord-webhook exfiltration, IP lookups, anti-bot checks; **client-side cloaking gates**
  (user-agent / referrer / cookie checks, mouse / touch gates, timed redirects, `debugger`);
  meta refresh (and to another host), `noindex`, `<base>`; favicon / image / CSS hosts on another
  domain; **brand vs domain**: ~75 brands (UAE government, police, banks, telecom, couriers, Gulf
  and global brands; English + Arabic names) named in the title, copyright line, login form or body
  while the page's registered domain is not one the brand owns; urgency / payment / prize /
  verification / login / delivery / crypto / government / investment lexicons (English + Arabic,
  density and presence, lure wording from `docs/research/uae_threat_landscape.md` §2); text length,
  low-text flag, script mix, detected language, bilingual flag; a little URL context (https, IP host,
  free-hosting suffix, subdomain depth, punycode).
* **Deliberately left out:** URL path depth and URL length. In the public corpora legitimate pages
  are mostly deep links and phishing pages mostly site roots; with those features the first model
  scored every live home page (bbc.com, adcb.com, u.ae …) 0.9+ (see the live check below).

Feature extraction costs ~6 ms p50 / ~17 ms p95 per page on one core; the whole served model
9 ms p50 / 25 ms p95 measured alone (15 / 39 ms while other jobs shared the CPU, as recorded in the
result JSONs).

## Models

| name | what |
|---|---|
| `page_text_lr` | TF-IDF (150k word + 150k char n-grams; vocabulary fitted on 15k training pages) → logistic regression, C chosen on validation |
| `page_struct_lgbm` | LightGBM over the 125 structural features |
| **`page_combo`** (served) | LightGBM over the structural features + the text model's *out-of-fold* margin (5-fold, grouped by registered domain), Platt-calibrated on validation; threshold = ≤0.5% FPR on validation (0.976); abstains on contentless pages |
| `page_gte_ft` | `Alibaba-NLP/gte-multilingual-base` fine-tuned 1 epoch (bf16 autocast, batch 32, 512 tokens) on `url [SEP] title [SEP] form summary + signals [SEP] visible text`, plus 10.9k real Arabic scam / legit messages as auxiliary training text (`arabic_scam_text.parquet`: call transcripts, real Saudi SMS, survey smishing, bilingual e-mails, 3k spam tweets, 2k Gulf templates; no page text, no machine translation) |
| `rules_baseline` | hand-written weights over the same extracted signals (sensitive form, brand mismatch, off-site / PHP form action, urgency / verify / payment / prize words, scrambling, free host), threshold 0.5 |
| `keyword_baseline` | count of classic phishing keywords (English + Arabic) in the page text, threshold 0.5 |
| `hf_*` | public pretrained models, verified on Hugging Face: `ealvaradob/bert-finetuned-phishing` (BERT-large; fed raw HTML), `huynq3Cyradar/bert-large-finetuned-phishing-webpage-version` (mBERT; page text), `Horizon-Labs/phishing-scam-detector-base` (ModernBERT, multilingual incl. Arabic; page text, P(spam)+P(fraud)). Scored on the full test set on the GPU; per-page latency measured on one CPU thread (10 pages) and on the GPU (20 pages) |

**Abstention.** `score_page` returns `None` when a page has under 300 characters of visible text,
no form or input field, and no active-content signal (scrambled script, JS / meta redirect, external
iframe, Telegram exfiltration, cloaking gate, `document.write`). Such pages (example.com, parked
pages, JS-only shells) resemble many tiny phishing pages in the training data, so a score would
mostly reflect that bias. On pages_test this affects 1,240 of 15,048 pages (863 scam, 377 legit):
recall drops from 0.419 to 0.388 at the same FPR. Those pages are left to the URL / domain layers.

**Reasons.** `top_features(page, k)` returns the LightGBM SHAP contributions (log-odds, scaled by the
calibration slope) of the features present on the page; the text model's share is expanded into the
page n-grams that carry it, e.g. `('page wording: “رقم”, “cvv”, “field_card”', 2.97)`,
`('title names a brand this domain does not belong to', 0.41)`.

## Data and splits (leak-free)

* `ml/data/processed/pages.parquet` (final, 100,306 pages): split by registered domain, domains
  ordered by first-seen date, newest 15% of rows → test, previous 15% → val. Train has all four
  sources (PhreshPhish, KnowPhish TR-OP, Mendeley, Phishpedia — the last is phishing-only); val and
  test are PhreshPhish only. Train 70,214 / val 15,044 / test 15,048 pages.
* Validation is used for C / early stopping / calibration / thresholds; test is touched only here.
* `pages_test_1pct` keeps every legitimate test page and draws scam pages so they are 1% of the set
  (mean over 20 draws): precision there is what an operator would see at a realistic base rate.
* `synthetic_uae` (**SYNTHETIC**, `ml/page/synthetic_uae.py`, `ml/data/synthetic_uae/`): 150 scam +
  147 legitimate-style generic HTML pages from templates (traffic fine, toll / parking, parcel fee,
  UAE PASS / Emirates ID OTP, bank account suspended; English, Arabic, mixed; brand names in text
  only). Never used for training. Caveats: the official domains of these brands are in the model's
  brand table, and the rules baseline is built from the same lure lexicon the generator uses, so its
  perfect score there is circular. In its slice table, "lang=other" means the mixed-language pages.
* Leave-one-source-out (train on three sources, test on the fourth; 60k + 60k n-grams, C=16, same
  pipeline, served abstention) is in the tables below and `ml/page/cache/loso.json`. Older collections
  (KnowPhish 2022-23, Mendeley 2020-23, Phishpedia 2019-20) are recognised well from the rest
  (recall 0.79–0.92 at 0–3% FPR), but a model trained without PhreshPhish catches only 22% of the
  fresh 2025 PhreshPhish test pages (ROC-AUC 0.81): page content drifts fast, which is also why the
  public pretrained models are at chance here. Retrain on fresh feeds regularly.
* An earlier iteration also used extra PhreshPhish rows from local shards and the ealvaradob HTML set
  (`ml/page/corpus.py --with-extra`); the final processed set supersedes them.

<!-- tables:start -->
### Headline results (our thresholds fixed on validation: ≤0.5% of legitimate validation pages flagged; baselines at their native 0.5)

#### pages_test

| model | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC | R@FPR 0.1% | R@FPR 1% | TP / FP / TN / FN | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| page_combo | 15048 | 0.990 | 0.388 | 0.558 | 0.0041 | 0.857 | 0.909 | 0.231 | 0.486 | 2983 / 30 / 7331 / 4704 | 15.3 / 38.6 |
| page_combo_no_abstain | 15048 | 0.990 | 0.419 | 0.589 | 0.0043 | 0.958 | 0.960 | 0.239 | 0.534 | 3223 / 32 / 7329 / 4464 | 15.3 / 38.6 |
| page_gte_ft | 15048 | 0.990 | 0.888 | 0.936 | 0.0095 | 0.989 | 0.991 | 0.558 | 0.891 | 6829 / 70 / 7291 / 858 | 190.7 / 326.6 |
| page_text_lr | 15048 | 0.978 | 0.275 | 0.429 | 0.0064 | 0.914 | 0.916 | 0.135 | 0.363 | 2112 / 47 / 7314 / 5575 | 13.2 / 36.7 |
| page_struct_lgbm | 15048 | 0.986 | 0.375 | 0.543 | 0.0057 | 0.945 | 0.946 | 0.232 | 0.466 | 2880 / 42 / 7319 / 4807 | 6.3 / 23.3 |
| hf_ealvaradob_bert_large | 15048 | 0.577 | 0.482 | 0.525 | 0.3682 | 0.560 | 0.558 | 0.000 | 0.013 | 3704 / 2710 / 4651 / 3983 | 3715.6 / 4224.3 |
| hf_huynq3_mbert_webpage | 15048 | 0.526 | 0.593 | 0.558 | 0.5574 | 0.543 | 0.560 | 0.005 | 0.024 | 4560 / 4103 / 3258 / 3127 | 875.1 / 1171.3 |
| hf_horizon_mmbert_scam | 15048 | 0.517 | 0.751 | 0.613 | 0.7317 | 0.516 | 0.545 | 0.000 | 0.009 | 5773 / 5386 / 1975 / 1914 | 1947.3 / 2602.7 |
| rules_baseline | 15048 | 0.703 | 0.103 | 0.179 | 0.0454 | 0.465 | 0.542 | 0.018 | 0.041 | 789 / 334 / 7027 / 6898 | 6.0 / 22.0 |
| keyword_baseline | 15048 | 0.464 | 0.197 | 0.276 | 0.2377 | 0.458 | 0.493 | 0.000 | 0.000 | 1512 / 1750 / 5611 / 6175 | 6.2 / 20.4 |

#### pages_test_1pct

| model | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC | R@FPR 0.1% | R@FPR 1% | TP / FP / TN / FN | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| page_combo | 7435 | 0.486 | 0.386 | 0.430 | 0.0041 | 0.853 | 0.414 | 0.241 | 0.486 | 28.6 / 30.0 / 7331.0 / 45.4 | 15.3 / 38.6 |
| page_combo_no_abstain | 7435 | 0.488 | 0.416 | 0.449 | 0.0043 | 0.956 | 0.459 | 0.247 | 0.534 | 30.75 / 32.0 / 7329.0 / 43.25 | 15.3 / 38.6 |
| page_gte_ft | 7435 | 0.485 | 0.891 | 0.628 | 0.0095 | 0.991 | 0.786 | 0.578 | 0.896 | 65.9 / 70.0 / 7291.0 / 8.1 | 190.7 / 326.6 |
| page_text_lr | 7435 | 0.300 | 0.275 | 0.287 | 0.0064 | 0.913 | 0.245 | 0.132 | 0.356 | 20.35 / 47.0 / 7314.0 / 53.65 | 13.2 / 36.7 |
| page_struct_lgbm | 7435 | 0.393 | 0.371 | 0.382 | 0.0057 | 0.943 | 0.365 | 0.236 | 0.460 | 27.45 / 42.0 / 7319.0 / 46.55 | 6.3 / 23.3 |
| hf_ealvaradob_bert_large | 7435 | 0.012 | 0.459 | 0.024 | 0.3682 | 0.547 | 0.012 | 0.000 | 0.013 | 33.95 / 2710.0 / 4651.0 / 40.05 | 3715.6 / 4224.3 |
| hf_huynq3_mbert_webpage | 7435 | 0.011 | 0.589 | 0.021 | 0.5574 | 0.542 | 0.015 | 0.007 | 0.027 | 43.6 / 4103.0 / 3258.0 / 30.4 | 875.1 / 1171.3 |
| hf_horizon_mmbert_scam | 7435 | 0.010 | 0.746 | 0.020 | 0.7317 | 0.509 | 0.013 | 0.000 | 0.012 | 55.2 / 5386.0 / 1975.0 / 18.8 | 1947.3 / 2602.7 |
| rules_baseline | 7435 | 0.022 | 0.101 | 0.036 | 0.0454 | 0.463 | 0.021 | 0.016 | 0.051 | 7.45 / 334.0 / 7027.0 / 66.55 | 6.0 / 22.0 |
| keyword_baseline | 7435 | 0.007 | 0.177 | 0.014 | 0.2377 | 0.446 | 0.009 | 0.000 | 0.000 | 13.1 / 1750.0 / 5611.0 / 60.9 | 6.2 / 20.4 |

#### synthetic_uae

| model | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC | R@FPR 0.1% | R@FPR 1% | TP / FP / TN / FN | p50 / p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| page_combo | 297 | 0.932 | 1.000 | 0.965 | 0.0748 | 0.999 | 0.999 | 0.893 | 0.913 | 150 / 11 / 136 / 0 | 15.3 / 38.6 |
| page_combo_no_abstain | 297 | 0.920 | 1.000 | 0.958 | 0.0884 | 0.999 | 0.999 | 0.893 | 0.913 | 150 / 13 / 134 / 0 | 15.3 / 38.6 |
| page_gte_ft | 297 | 0.926 | 1.000 | 0.962 | 0.0816 | 1.000 | 1.000 | 0.987 | 0.987 | 150 / 12 / 135 / 0 | 190.7 / 326.6 |
| page_text_lr | 297 | 0.872 | 0.953 | 0.911 | 0.1429 | 0.973 | 0.974 | 0.293 | 0.573 | 143 / 21 / 126 / 7 | 13.2 / 36.7 |
| page_struct_lgbm | 297 | 0.784 | 0.993 | 0.876 | 0.2789 | 0.995 | 0.997 | 0.973 | 0.987 | 149 / 41 / 106 / 1 | 6.3 / 23.3 |
| hf_ealvaradob_bert_large | 297 | 0.593 | 1.000 | 0.744 | 0.7007 | 0.733 | 0.735 | 0.127 | 0.180 | 150 / 103 / 44 / 0 | 3715.6 / 4224.3 |
| hf_huynq3_mbert_webpage | 297 | 0.886 | 0.207 | 0.335 | 0.0272 | 0.828 | 0.804 | 0.000 | 0.020 | 31 / 4 / 143 / 119 | 875.1 / 1171.3 |
| hf_horizon_mmbert_scam | 297 | 0.579 | 1.000 | 0.733 | 0.7415 | 0.899 | 0.876 | 0.127 | 0.127 | 150 / 109 / 38 / 0 | 1947.3 / 2602.7 |
| rules_baseline | 297 | 1.000 | 0.973 | 0.986 | 0.0000 | 0.998 | 0.997 | 0.973 | 0.973 | 146 / 0 / 147 / 4 | 6.0 / 22.0 |
| keyword_baseline | 297 | 0.536 | 0.600 | 0.566 | 0.5306 | 0.536 | 0.507 | 0.000 | 0.000 | 90 / 78 / 69 / 60 | 6.2 / 20.4 |

### Per-language and other slices

#### page_combo by slice — pages_test

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 15048 | 7687 | 0.990 | 0.388 | 0.558 | 0.0041 | 30 | 4704 | 0.857 |
| lang=en (dataset) | 11250 | 4951 | 0.993 | 0.465 | 0.634 | 0.0027 | 17 | 2647 | 0.874 |
| lang=ar (dataset) | 41 | 22 | 1.000 | 0.909 | 0.952 | 0.0000 | 0 | 2 | 0.945 |
| lang=other (dataset) | 3239 | 2221 | 0.980 | 0.289 | 0.446 | 0.0128 | 13 | 1580 | 0.805 |
| lang unknown (dataset) | 518 | 493 | 1.000 | 0.037 | 0.070 | 0.0000 | 0 | 475 | 0.560 |
| lang=ar (detected) | 43 | 24 | 1.000 | 0.750 | 0.857 | 0.0000 | 0 | 6 | 0.934 |
| Arabic or Gulf-brand rows | 206 | 171 | 1.000 | 0.281 | 0.438 | 0.0000 | 0 | 123 | 0.824 |
| very little text (<200 chars) | 3764 | 2586 | 0.992 | 0.253 | 0.403 | 0.0042 | 5 | 1932 | 0.693 |
| page asks for password/card/OTP/ID | 1966 | 909 | 0.965 | 0.519 | 0.675 | 0.0161 | 17 | 437 | 0.917 |
| bank / government / payment-like domain | 490 | 137 | 0.922 | 0.343 | 0.500 | 0.0113 | 4 | 90 | 0.788 |

#### page_combo by slice — synthetic_uae

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 297 | 150 | 0.932 | 1.000 | 0.965 | 0.0748 | 11 | 0 | 0.999 |
| lang=en (dataset) | 99 | 50 | 0.980 | 1.000 | 0.990 | 0.0204 | 1 | 0 | 1.000 |
| lang=ar (dataset) | 99 | 50 | 0.862 | 1.000 | 0.926 | 0.1633 | 8 | 0 | 0.993 |
| lang=other (dataset) | 99 | 50 | 0.962 | 1.000 | 0.980 | 0.0408 | 2 | 0 | 1.000 |
| lang=ar (detected) | 198 | 100 | 0.909 | 1.000 | 0.952 | 0.1020 | 10 | 0 | 0.997 |
| Arabic or Gulf-brand rows | 297 | 150 | 0.932 | 1.000 | 0.965 | 0.0748 | 11 | 0 | 0.999 |
| very little text (<200 chars) | 105 | 1 | 0.091 | 1.000 | 0.167 | 0.0962 | 10 | 0 | 0.981 |
| page asks for password/card/OTP/ID | 224 | 149 | 0.974 | 1.000 | 0.987 | 0.0533 | 4 | 0 | 0.997 |
| bank / government / payment-like domain | 69 | 24 | 0.960 | 1.000 | 0.980 | 0.0222 | 1 | 0 | 1.000 |

#### hf_ealvaradob_bert_large by slice — pages_test

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 15048 | 7687 | 0.577 | 0.482 | 0.525 | 0.3682 | 2710 | 3983 | 0.560 |
| lang=en (dataset) | 11250 | 4951 | 0.514 | 0.427 | 0.467 | 0.3181 | 2004 | 2835 | 0.554 |
| lang=ar (dataset) | 41 | 22 | 0.556 | 0.909 | 0.690 | 0.8421 | 16 | 2 | 0.816 |
| lang=other (dataset) | 3239 | 2221 | 0.679 | 0.645 | 0.662 | 0.6640 | 676 | 788 | 0.504 |
| lang unknown (dataset) | 518 | 493 | 0.906 | 0.274 | 0.421 | 0.5600 | 14 | 358 | 0.287 |
| lang=ar (detected) | 43 | 24 | 0.590 | 0.958 | 0.730 | 0.8421 | 16 | 1 | 0.809 |
| Arabic or Gulf-brand rows | 206 | 171 | 0.770 | 0.450 | 0.568 | 0.6571 | 23 | 94 | 0.388 |
| very little text (<200 chars) | 3764 | 2586 | 0.726 | 0.547 | 0.624 | 0.4533 | 534 | 1172 | 0.558 |
| page asks for password/card/OTP/ID | 1966 | 909 | 0.548 | 0.618 | 0.581 | 0.4380 | 463 | 347 | 0.569 |
| bank / government / payment-like domain | 490 | 137 | 0.342 | 0.577 | 0.429 | 0.4306 | 152 | 58 | 0.556 |

#### hf_horizon_mmbert_scam by slice — pages_test

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 15048 | 7687 | 0.517 | 0.751 | 0.613 | 0.7317 | 5386 | 1914 | 0.516 |
| lang=en (dataset) | 11250 | 4951 | 0.457 | 0.793 | 0.580 | 0.7406 | 4665 | 1025 | 0.547 |
| lang=ar (dataset) | 41 | 22 | 0.583 | 0.955 | 0.724 | 0.7895 | 15 | 1 | 0.478 |
| lang=other (dataset) | 3239 | 2221 | 0.721 | 0.822 | 0.768 | 0.6935 | 706 | 395 | 0.573 |
| lang unknown (dataset) | 518 | 493 | 0.000 | 0.000 | 0.000 | 0.0000 | 0 | 493 | 0.500 |
| lang=ar (detected) | 43 | 24 | 0.605 | 0.958 | 0.742 | 0.7895 | 15 | 1 | 0.518 |
| Arabic or Gulf-brand rows | 206 | 171 | 0.835 | 0.918 | 0.875 | 0.8857 | 31 | 14 | 0.547 |
| very little text (<200 chars) | 3764 | 2586 | 0.665 | 0.495 | 0.568 | 0.5467 | 644 | 1305 | 0.432 |
| page asks for password/card/OTP/ID | 1966 | 909 | 0.511 | 0.702 | 0.592 | 0.5771 | 610 | 271 | 0.582 |
| bank / government / payment-like domain | 490 | 137 | 0.292 | 0.613 | 0.395 | 0.5779 | 204 | 53 | 0.565 |

#### hf_huynq3_mbert_webpage by slice — pages_test

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 15048 | 7687 | 0.526 | 0.593 | 0.558 | 0.5574 | 4103 | 3127 | 0.543 |
| lang=en (dataset) | 11250 | 4951 | 0.478 | 0.674 | 0.560 | 0.5776 | 3638 | 1613 | 0.580 |
| lang=ar (dataset) | 41 | 22 | 0.500 | 0.182 | 0.267 | 0.2105 | 4 | 18 | 0.612 |
| lang=other (dataset) | 3239 | 2221 | 0.725 | 0.548 | 0.625 | 0.4528 | 461 | 1003 | 0.570 |
| lang unknown (dataset) | 518 | 493 | 0.000 | 0.000 | 0.000 | 0.0000 | 0 | 493 | 0.500 |
| lang=ar (detected) | 43 | 24 | 0.429 | 0.125 | 0.194 | 0.2105 | 4 | 21 | 0.575 |
| Arabic or Gulf-brand rows | 206 | 171 | 0.862 | 0.439 | 0.581 | 0.3429 | 12 | 96 | 0.601 |
| very little text (<200 chars) | 3764 | 2586 | 0.708 | 0.370 | 0.486 | 0.3362 | 396 | 1628 | 0.536 |
| page asks for password/card/OTP/ID | 1966 | 909 | 0.489 | 0.784 | 0.603 | 0.7039 | 744 | 196 | 0.598 |
| bank / government / payment-like domain | 490 | 137 | 0.267 | 0.555 | 0.360 | 0.5921 | 209 | 61 | 0.536 |

#### page_gte_ft by slice — pages_test

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 15048 | 7687 | 0.990 | 0.888 | 0.936 | 0.0095 | 70 | 858 | 0.989 |
| lang=en (dataset) | 11250 | 4951 | 0.989 | 0.871 | 0.926 | 0.0078 | 49 | 641 | 0.988 |
| lang=ar (dataset) | 41 | 22 | 1.000 | 1.000 | 1.000 | 0.0000 | 0 | 0 | 1.000 |
| lang=other (dataset) | 3239 | 2221 | 0.990 | 0.910 | 0.948 | 0.0196 | 20 | 201 | 0.989 |
| lang unknown (dataset) | 518 | 493 | 0.998 | 0.968 | 0.982 | 0.0400 | 1 | 16 | 0.989 |
| lang=ar (detected) | 43 | 24 | 1.000 | 0.958 | 0.979 | 0.0000 | 0 | 1 | 1.000 |
| Arabic or Gulf-brand rows | 206 | 171 | 1.000 | 0.871 | 0.931 | 0.0000 | 0 | 22 | 0.972 |
| very little text (<200 chars) | 3764 | 2586 | 0.989 | 0.940 | 0.964 | 0.0238 | 28 | 154 | 0.992 |
| page asks for password/card/OTP/ID | 1966 | 909 | 0.966 | 0.825 | 0.890 | 0.0246 | 26 | 159 | 0.957 |
| bank / government / payment-like domain | 490 | 137 | 0.975 | 0.839 | 0.902 | 0.0085 | 3 | 22 | 0.984 |

#### hf_ealvaradob_bert_large by slice — synthetic_uae

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 297 | 150 | 0.593 | 1.000 | 0.744 | 0.7007 | 103 | 0 | 0.733 |
| lang=en (dataset) | 99 | 50 | 0.649 | 1.000 | 0.787 | 0.5510 | 27 | 0 | 0.755 |
| lang=ar (dataset) | 99 | 50 | 0.521 | 1.000 | 0.685 | 0.9388 | 46 | 0 | 0.735 |
| lang=other (dataset) | 99 | 50 | 0.625 | 1.000 | 0.769 | 0.6122 | 30 | 0 | 0.757 |
| lang=ar (detected) | 198 | 100 | 0.568 | 1.000 | 0.725 | 0.7755 | 76 | 0 | 0.740 |
| Arabic or Gulf-brand rows | 297 | 150 | 0.593 | 1.000 | 0.744 | 0.7007 | 103 | 0 | 0.733 |
| very little text (<200 chars) | 105 | 1 | 0.013 | 1.000 | 0.025 | 0.7404 | 77 | 0 | 0.837 |
| page asks for password/card/OTP/ID | 224 | 149 | 0.716 | 1.000 | 0.835 | 0.7867 | 59 | 0 | 0.706 |
| bank / government / payment-like domain | 69 | 24 | 0.421 | 1.000 | 0.593 | 0.7333 | 33 | 0 | 0.530 |

#### hf_horizon_mmbert_scam by slice — synthetic_uae

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 297 | 150 | 0.579 | 1.000 | 0.733 | 0.7415 | 109 | 0 | 0.899 |
| lang=en (dataset) | 99 | 50 | 0.610 | 1.000 | 0.758 | 0.6531 | 32 | 0 | 0.938 |
| lang=ar (dataset) | 99 | 50 | 0.617 | 1.000 | 0.763 | 0.6327 | 31 | 0 | 0.931 |
| lang=other (dataset) | 99 | 50 | 0.521 | 1.000 | 0.685 | 0.9388 | 46 | 0 | 0.853 |
| lang=ar (detected) | 198 | 100 | 0.565 | 1.000 | 0.722 | 0.7857 | 77 | 0 | 0.874 |
| Arabic or Gulf-brand rows | 297 | 150 | 0.579 | 1.000 | 0.733 | 0.7415 | 109 | 0 | 0.899 |
| very little text (<200 chars) | 105 | 1 | 0.013 | 1.000 | 0.025 | 0.7500 | 78 | 0 | 0.875 |
| page asks for password/card/OTP/ID | 224 | 149 | 0.716 | 1.000 | 0.835 | 0.7867 | 59 | 0 | 0.911 |
| bank / government / payment-like domain | 69 | 24 | 0.393 | 1.000 | 0.565 | 0.8222 | 37 | 0 | 0.923 |

#### hf_huynq3_mbert_webpage by slice — synthetic_uae

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 297 | 150 | 0.886 | 0.207 | 0.335 | 0.0272 | 4 | 119 | 0.828 |
| lang=en (dataset) | 99 | 50 | 0.957 | 0.440 | 0.603 | 0.0204 | 1 | 28 | 0.925 |
| lang=ar (dataset) | 99 | 50 | 0.571 | 0.080 | 0.140 | 0.0612 | 3 | 46 | 0.791 |
| lang=other (dataset) | 99 | 50 | 1.000 | 0.100 | 0.182 | 0.0000 | 0 | 45 | 0.828 |
| lang=ar (detected) | 198 | 100 | 0.750 | 0.090 | 0.161 | 0.0306 | 3 | 91 | 0.808 |
| Arabic or Gulf-brand rows | 297 | 150 | 0.886 | 0.207 | 0.335 | 0.0272 | 4 | 119 | 0.828 |
| very little text (<200 chars) | 105 | 1 | 0.000 | 0.000 | 0.000 | 0.0288 | 3 | 1 | 0.577 |
| page asks for password/card/OTP/ID | 224 | 149 | 0.909 | 0.201 | 0.330 | 0.0400 | 3 | 119 | 0.758 |
| bank / government / payment-like domain | 69 | 24 | 0.667 | 0.083 | 0.148 | 0.0222 | 1 | 22 | 0.846 |

#### page_gte_ft by slice — synthetic_uae

| slice | n | scam | precision | recall | F1 | FPR | FP | FN | ROC-AUC |
|---|---|---|---|---|---|---|---|---|---|
| all | 297 | 150 | 0.926 | 1.000 | 0.962 | 0.0816 | 12 | 0 | 1.000 |
| lang=en (dataset) | 99 | 50 | 0.926 | 1.000 | 0.962 | 0.0816 | 4 | 0 | 0.999 |
| lang=ar (dataset) | 99 | 50 | 0.909 | 1.000 | 0.952 | 0.1020 | 5 | 0 | 1.000 |
| lang=other (dataset) | 99 | 50 | 0.943 | 1.000 | 0.971 | 0.0612 | 3 | 0 | 1.000 |
| lang=ar (detected) | 198 | 100 | 0.926 | 1.000 | 0.962 | 0.0816 | 8 | 0 | 1.000 |
| Arabic or Gulf-brand rows | 297 | 150 | 0.926 | 1.000 | 0.962 | 0.0816 | 12 | 0 | 1.000 |
| very little text (<200 chars) | 105 | 1 | 0.100 | 1.000 | 0.182 | 0.0865 | 9 | 0 | 1.000 |
| page asks for password/card/OTP/ID | 224 | 149 | 0.974 | 1.000 | 0.987 | 0.0533 | 4 | 0 | 1.000 |
| bank / government / payment-like domain | 69 | 24 | 1.000 | 1.000 | 1.000 | 0.0000 | 0 | 0 | 1.000 |

### Abstentions (page_combo returns no score: < 300 chars of text, no form, no active-content signal)

| dataset | pages | abstained | of which scam | of which legit |
|---|---|---|---|---|
| pages_test | 15048 | 1240 | 863 | 377 |
| synthetic_uae | 297 | 35 | 0 | 35 |

### Leave-one-source-out

| trained on | tested on | n | precision | recall | F1 | FPR | ROC-AUC | PR-AUC |
|---|---|---|---|---|---|---|---|---|
| all except knowphish_tr_op | knowphish_tr_op | 9921 | 0.969 | 0.839 | 0.899 | 0.0274 | 0.941 | 0.963 |
| all except mendeley_n96ncsr5g4 | mendeley_n96ncsr5g4 | 9999 | 0.958 | 0.787 | 0.864 | 0.0344 | 0.900 | 0.939 |
| all except phishpedia_phish30k | phishpedia_phish30k | 4818 | 1.000 | 0.920 | 0.958 | 0.0000 | – | – |
| all except phreshphish | phreshphish | 15048 | 0.931 | 0.223 | 0.360 | 0.0173 | 0.808 | 0.839 |

### False positives on legitimate sensitive pages

#### pages_test: legitimate login / payment / bank / government pages

19 flagged out of 1354 (FPR 1.40%).

All false positives in pages_test: 30.

#### synthetic_uae: legitimate login / payment / bank / government pages

5 flagged out of 94 (FPR 5.32%).

All false positives in synthetic_uae: 11.

### Latency (one thread, end to end: HTML parse + features + model, 300 pages)

| model | p50 ms | p95 ms | max ms |
|---|---|---|---|
| page_combo | 15.3 | 38.6 | 83.9 |
| page_text_lr | 13.2 | 36.7 | 69.1 |
| page_struct_lgbm | 6.3 | 23.3 | 35.6 |
| rules_baseline | 6.0 | 22.0 | 46.4 |
| keyword_baseline | 6.2 | 20.4 | 34.7 |
| page_combo_no_abstain | 15.3 | 38.6 | 83.9 |
<!-- tables:end -->

## Live sanity check on legitimate sites

`ml/page/live_legit.py` fetched 20 well-known legitimate pages once through the engine's own
`fetch_page` (mobile Chrome identity) and scores the cached snapshots. "v1" is the first artifact
(with URL-depth features) as the engine saw it; v2 is the served model (threshold 0.976).

| site | v1 | page_combo v2 (served) | page_gte_ft (threshold 0.265) |
|---|---|---|---|
| IANA example page | 0.993 | abstain | 0.002 |
| Khaleej Times, home | 0.921 | 0.073 | 0.001 |
| ADCB, personal banking | 0.935 | 0.075 | 0.001 |
| FAB, personal banking | 0.966 | 0.194 | 0.000 |
| Emirates NBD, home | 0.960 | 0.105 | 0.003 |
| UAE government portal, home | 0.947 | 0.202 | 0.003 |
| TAMM, home | 0.991 | 0.815 | **0.859** |
| Dubai Police, app home | 0.973 | 0.061 | 0.001 |
| RTA, home | 0.972 | 0.255 | 0.001 |
| noon, UAE home | 0.981 | 0.167 | 0.000 |
| Amazon UAE (bot-check page) | 0.953 | 0.064 | **0.996** |
| BBC, home | 0.912 | 0.026 | 0.000 |
| Al Jazeera, home | 0.926 | 0.166 | 0.001 |
| Al Khaleej, home | 0.925 | 0.279 | 0.025 |
| Wikipedia, home | 0.987 | 0.441 | 0.000 |
| GitHub, sign-in | 0.952 | 0.318 | 0.003 |
| PayPal, sign-in | 0.991 | 0.802 | 0.001 |
| Microsoft, sign-in without JavaScript | 0.973 | abstain | 0.003 |
| e&, home | 0.888 | 0.046 | 0.001 |
| Emirates Post, home | 0.950 | 0.096 | 0.004 |

**With the GPU tier (served, threshold 0.955), inside the engine container:** 0 of 20 flagged
(example.com 0.21, khaleejtimes 0.02, adcb 0.02, TAMM 0.07, Amazon bot-check 0.49, Microsoft login
0.23, Wikipedia 0.20, all others ≤ 0.07). Caveat: 14 of these 20 registered domains are in the
hard-negative training split (the crawl started from Tranco and the UAE lists), so this is a
sanity check, not a benchmark; the unbiased number is the domain-disjoint live legitimate test set
(served FPR 0.58%, 3 of 516).

Demo scenarios (fetched by `fetch_page` inside the engine container; CPU / served):
a clean small business 0.15 / 0.52 · b traffic-fine lure 0.996 / 0.998 · c short link → fine lure
0.996 / 0.998 · d clean tour operator abstain / 0.40 · e cloaking parcel-fee scam 0.999 / 0.999 ·
f empty page with scrambled script abstain / 0.98. All scams above the served threshold, both clean
sites below it (scenario a at 0.52 adds ≈0 points through `model_reason`).

v2 flags none of the 20 (highest: TAMM 0.815, PayPal sign-in 0.802 — both below 0.976). The v1
column was the URL-depth shortcut plus a feature-list mismatch; both are fixed (the serving code
now maps features by name, so an artifact trained on an older feature list still loads and scores).

## False positives on legitimate login / payment pages

Of 1,354 legitimate pages_test pages that ask for a password / card / OTP / ID or sit on a bank /
government / payment-like domain, page_combo flags 19 (1.4%); the list is in the tables above.
They are mostly **generic webmail and back-office logins** (Roundcube / cPanel webmail, MDaemon,
CenturyLink webmail, small-business portals, a card-payment page) — exactly what phishing kits copy —
plus two bank pages (NBS New Zealand internet-banking login, a FirstBank application portal) and an
Intesa Sanpaolo FAQ page. No UAE bank or government page is among them (the test set has very few).
The fine-tuned encoder has a similar profile (26 FPs among 1,966 sensitive-form pages).

## GPU scripts

* `ml/page/train_gpu.py` (run once tonight on the RTX PRO 6000 in `.venv-gpu`, torch 2.11+cu128):
  `PYTHONPATH=src:. .venv-gpu/bin/python -m ml.page.train_gpu --epochs 1 --batch 32`. 81k training
  texts, 2,405 steps, 11 min of training + ~3 min evaluation, ~29 GB GPU memory (capped at 35 GB via
  `set_per_process_memory_fraction`). Val PR-AUC 0.9941 (CPU combo: 0.983). Weights in
  `ml/artifacts/page_encoder/` (1.2 GB, git-ignored by size policy — do not commit).
* `ml/page/export_encoder.py`: per-page latency and live-site scores of the encoder. ONNX export works
  (`--onnx`) but onnxruntime crashed (SIGSEGV) loading the 1.2 GB graph in this environment, so the
  numbers are PyTorch: 1.36 s p50 on one CPU core (fp32), 152 ms p50 / 188 ms p95 on the shared GPU
  (bf16, batch 1, tokenisation included).
* `ml/page/llm_judge_eval.py`: zero-shot LLM judge over an OpenAI-compatible endpoint (vLLM,
  JSON-schema output, untrusted-text markers), on 300 balanced test pages + every Arabic / Gulf test
  page, with and without our signals (`--with-signals`); compares with page_combo on identical rows
  and at a 1% base rate. Results below.

### Decision on the GPU tier

First decision (22:20): the encoder was kept out of `score_page` because the engine container has no
GPU (1.4 s per page on one CPU core) and it flagged 2 of 20 live legitimate pages. **Revised (23:50):**
it now runs as a host GPU service the engine calls over HTTP (see "Serving"), and the live false
positives were fixed with engine-fetched hard negatives (page_gte_ft_v2: 2 epochs, early stopping on
validation PR-AUC — best after epoch 1, val PR-AUC 0.9919 on the new validation set where v1 scores
0.9934, but live legitimate FPR 0.19% vs 2.7% at the same pages_test recall). v2 is served.

## Zero-shot LLM judge (local `Qwen/Qwen3.5-9B` on vLLM, served as `scamshield-llm`, thinking off)

Sample: 300 pages from pages_test (150 scam / 150 legit, fixed seed) plus every Arabic / Gulf-relevant
test page; the judge sees URL, title, language, form summary and the first 1,200 characters of visible
text inside untrusted-content markers, and returns JSON (`risk_0_100`, threshold 50). Unparseable /
failed answers (8.3%) count as "not flagged". page_combo is scored on the identical rows (served
behaviour, abstentions count as not flagged).

| rows | model | n | TP / FP / TN / FN | precision | recall | F1 | FPR | ROC-AUC |
|---|---|---|---|---|---|---|---|---|
| balanced sample | LLM judge | 300 | 73 / 8 / 142 / 77 | 0.901 | 0.487 | 0.632 | 5.3% | 0.744 |
| balanced sample | page_combo | 300 | 58 / 0 / 150 / 92 | 1.000 | 0.387 | 0.558 | 0.0% | 0.816 |
| Arabic pages (small sample) | LLM judge | 45 | 21 / 2 / 17 / 5 | 0.913 | 0.808 | 0.857 | 10.5% | 0.777 |
| Arabic pages (small sample) | page_combo | 45 | 20 / 0 / 19 / 6 | 1.000 | 0.769 | 0.870 | 0.0% | 0.939 |
| Arabic + Gulf-relevant | LLM judge | 208 | — | 0.977 | 0.491 | 0.654 | 5.7% | 0.713 |
| Arabic + Gulf-relevant | page_combo | 208 | — | 1.000 | 0.277 | 0.434 | 0.0% | 0.825 |
| balanced sample | LLM judge + our signals and page-model score in the prompt | 300 | — | 0.949 | 0.500 | 0.655 | 2.7% | 0.694 |
| Arabic pages | LLM judge + signals | 45 | — | 0.944 | 0.654 | 0.773 | 5.3% | 0.694 |

At a realistic 1% scam base rate the judge's 5% FPR means precision ≈ 0.08 (0.15 with our signals;
`*_1pct` results). Giving it our signals halves its FPR but it still does not rank as well as the
page model alone; JSON failures were 8–12%.
Speed: 5.7 s p50 / 8.0 s p95 per call with 8 requests in flight (0.73 s per page throughput);
one request at a time (20 pages): 3.8 s p50 / 5.9 s p95, 4.2 s per page. Confusion matrices:
`docs/img/page_confusion__llm_sample.png`. As the research predicted, the zero-shot LLM is a worse
ranker than our model and too trigger-happy to block on; it is useful as a tie-breaker / explainer on
pages the models leave in the uncertain band. Its Arabic output text was reported weak by the team; the
Arabic subset (45 pages) is too small to separate it from the English behaviour.
