# Benchmark protocol

## URL-based methods

Results: `ml/results/*.json`, rendered into [`BENCHMARKS.md`](BENCHMARKS.md); the side-by-side table is
printed by `python -m ml.sota.url.summary`. Code for the recreated methods: [`ml/sota/url/`](../ml/sota/url/README.md).

### Systems and the form each is compared in

| system | form | input it receives |
|---|---|---|
| `url_stack`, `url_tfidf_lr`, `url_lgbm_feats` | ours (CPU, served) | URL without scheme or leading `www.` |
| `url_mmbert_ft` | ours (GPU); this is the URLTran recipe (fine-tuned transformer on URL strings) on a multilingual backbone | same |
| `sota_url_urlnet` | URLNet (Le et al. 2018), **recreated**: re-implemented in PyTorch from the official TF1 code, retrained on our rows | same |
| `sota_url_grambeddings` | GramBeddings (Bozkir et al. 2023), **recreated**: re-implemented in PyTorch from the official TF2 code, retrained on our rows | same |
| `sota_url_urlbert_ft` | URLBERT (Li et al. 2024), **recreated**: the authors' released URL-pre-trained encoder, fine-tuned on our rows with their phishing recipe | same |
| `sota_url_phreshphish_linear` | PhreshPhish "Linear" baseline (Dalton et al. 2025), **recreated** from the paper, URL part only | same |
| `hf_urlbert_tiny_v4`, `hf_kmack_distilbert`, `hf_ealvaradob_bert_large`, `hf_pirocheto_tfidf_svm` | public Hugging Face models **as released** (their training data, their 0.5 threshold) | the full URL, as their cards expect |
| `blocklist_*` | exact-URL / domain lookup in public feeds | URL |

**Not recreated, and why.** URLTran (Microsoft, arXiv 2106.05256): no code, no weights, patented; its method
(fine-tune a pre-trained transformer on URL strings and judge it at very low FPR) is covered by `url_mmbert_ft`
and by URLBERT, which is the same recipe on a URL-pre-trained BERT. Texception (Microsoft, 2020): no code or
weights and the same character + word CNN family as URLNet. PhreshPhish FFN / GTE and the LLM baseline: they
read the page HTML, so they belong to the page-based comparison; on the URL alone FFN is the Linear model with
binarised inputs. None of URLNet, GramBeddings or URLBERT released a trained phishing classifier, so they have
no "as released" row; the public HF models are the "what a deployer can download today" rows.

### Datasets (all frozen; no URL is ever fetched)

- `urls_test`: held-out registered domains of the merged corpus (393k URLs, 50% scam). Variants:
  `urls_test_noshort` (shortener links removed: live, the engine expands them first), `urls_test_shorteners`,
  `urls_test_nohf` (sources the public HF models were trained on removed), `urls_test_deeplegit_vs_barephish`
  (inverts the "long path = phishing" shortcut).
- `urls_fresh_test`: phishing first seen in the 48 h before the build + legitimate domains never in the corpus
  (5,394). Split into `_fullurl` and `_domainonly` because half the fresh phishing is bare hosts.
- `uae_legit`: 15,669 real UAE government / bank / business URLs, all legitimate: false positives on exactly the
  sites the judges will try. No UAE row is in any training set.
- Paper checks: the official PhreshPhish train / test split and its 975 benchmarks (base rates 0.05%-5% plus the
  24% full benchmark), and the GramBeddings dataset's own 640k / 160k split. The PhreshPhish paper publishes no
  URL-only baseline, so our URL-only Linear sits next to its URL + HTML numbers; the GramBeddings split is the
  like-for-like reproduction check (same input, same split, published accuracy): our GramBeddings
  re-implementation reaches 97.78% accuracy there against the paper's 98.27%, and our URLNet 97.63%. The PhreshPhish split is
  temporal but **not domain-disjoint**: 68% of benign and 44% of phishing test URLs share a registered domain
  with a training URL, which is why URL-only scores there are much higher than on our domain-disjoint split.

### Same rows, same input, same threshold rule

- **Training rows.** Every recreated method is trained on exactly the rows our models use: at most 100k per
  (source, label), 250k for PhreshPhish, plus the v3 legitimate-shortener rows, de-duplicated after normalisation
  (2,043,477 URLs, 50.3% scam; `ml/sota/url/data.py`). Exception: the LinearSVC is trained on a seeded 1M-row
  subsample (memory). Each file's docstring states epochs actually run, batch size and deviations from the
  authors' settings.
- **Input.** Scheme and leading `www.` are removed for every row of every split. 38% of the rows had `http://`
  imputed by our merge, so a model given the scheme learns which feed a row came from. The as-released HF models
  keep the full URL because that is what they were trained on.
- **Threshold.** Each recreated model's block threshold is the lowest score with <= 0.2% FPR on the calibration
  half of the validation split, the same rule and the same rows as ours. As-released models use their own 0.5.
  No value anywhere (threshold, epochs, n-gram vocabulary, sample size) is picked by looking at a test set:
  hyper-parameters are the authors', training length is a fixed wall-clock budget, and the shared settings
  live in `ml/sota/url/protocol.json`.
- **Metrics.** Threshold-free: ROC-AUC, PR-AUC, recall at 0.1% and 1% FPR. At the operating point: confusion
  matrix, precision / recall / FPR, and precision recomputed at a realistic 1% and 0.05% scam prevalence.
- **Latency.** Per URL, one URL at a time, model loaded, on one CPU thread (normalisation included), 300 random
  `urls_test` URLs (100 for BERT-base); GPU latency of the same single-URL call as an extra column. The machine is
  shared, so latencies are indicative.

### Where the comparison is still unequal

- Our models were designed against this data (feature choices, shortener rows, caps); the recreations take the
  authors' architectures and hyper-parameters as published, with no tuning on our validation set.
- Training budget: each recreation had a fixed 20-25 min slot on a shared GPU. URLNet ran 2.0 epochs (code
  default 5), GramBeddings 2.9 (default 3), URLBERT only 0.35 (BERT-base at ~600 URLs/s; authors: 5 epochs), so
  URLBERT is the most under-trained row; `url_mmbert_ft` ran about one pass in 25 min. Longer training may score
  higher. GPU latencies were measured while other jobs held the GPU near 100%, so they are upper bounds.
- The as-released HF models were trained on older public sets with the "legit = bare homepage" bias and with
  schemes; they meet a different distribution here, which is the point of the "as released" row, not a defect
  of the harness.
- URL-only methods cannot see shortener targets, compromised legitimate hosts or free-hosting subdomains; the
  page stage exists for those. A URL model is only one layer of the engine.
- All URL data is stored (frozen parquet files); nothing in the URL benchmark is live. Fresh phishing is
  "fresh" as of the build time (2026-11-24 20:49-21:10 +04).

## Page-based, visual and LLM-based methods

Code, setup and re-run commands: [`ml/sota/page/`](../ml/sota/page/README.md). Results:
`ml/results/sota_page_<method>__<dataset>.json` (shape of `ml/bench/metrics.py`), tables printed by
`python -m ml.sota.page.report`. Our page models' own benchmark is in [`BENCHMARKS_PAGE.md`](BENCHMARKS_PAGE.md).

**Nothing in these benchmarks connects to a live site.** Every method reads stored captures (HTML, the
stored screenshot, the URL string) from `ml/data/processed/pages.parquet`. HTML is parsed as text, never
rendered or executed. PhishIntention's live step and PhishLLM's web search are therefore switched off
(see below).

### Systems and the form each is compared in

| system | form | input it receives |
|---|---|---|
| `phishpedia` | **as released**: official code (lindsey98/Phishpedia @d030779) and released weights, 277-brand reference logos, authors' brand → domain map, official 0.87 threshold | screenshot + URL |
| `phishintention` | **official code, static mode**: official modules and weights (@69613c2), steps 1-3 (layout detector, OCR-aided Siamese, HTML heuristic + screenshot CRP classifier). Step 4, the CRP locator, drives Chrome on the live site and is disabled: a page the CRP classifier calls non-credential ends as benign, which is the pipeline's output when the locator fails. This can only lower its recall | screenshot + URL + stored HTML |
| `knowphish_kpd_text` | KnowPhish Detector (USENIX Sec '24), **re-implemented from the paper**, text branch. LLM extracts the brand from the page text → brand knowledge base → domain-brand consistency → credential-requiring-page (CRP) check. Not released, so replaced: the 20k-brand KB (ours: Phishpedia's brand → domain map + UAE/GCC seed + `brands.json`, about 5.9k names), the XLM-R CRP classifier (the local LLM answers the CRP question), the LLM (GPT-3.5 there; Qwen3.5-9B here; the paper reports LLaMA-2-7B within 1.5 points of GPT-3.5) | URL + visible page text |
| `knowphish_kpd_imgtext` | the same, with the image branch: brand from the official Phishpedia logo matcher, else from the LLM | screenshot + URL + page text |
| `phishllm_text` | PhishLLM (USENIX Sec '24), **re-implemented from the paper**: LLM recalls the brand's official domain from the page → consistency with the page domain → LLM CRP prediction. Missing: logo captioning (the served model takes no images: "At most 0 image(s)"), the search-engine brand validation and the CRP transition (both need the live web). Visible text replaces OCR text | URL + visible page text |
| `chatphishdetector_text` | ChatPhishDetector (Koide et al. 2024), **re-implemented**: the paper's 4-step prompt and JSON keys on the local LLM; GPT-4V there. Visible text replaces OCR text; no screenshot | URL + simplified HTML + page text |
| `phreshphish_llm` | PhreshPhish's LLM baseline (arXiv 2507.10854 App. C), **re-implemented**: their system prompt verbatim and their HTML simplification, on the local LLM instead of Gemini-2.5-Pro | URL + simplified HTML |
| `ours_page_combo` | **ours**, served CPU model (threshold fixed on validation) | URL + HTML |
| `ours_page_gte_ft` | **ours**, fine-tuned gte-multilingual-base (GPU) | URL + title + form summary + text |

All LLM methods use the same local model (`scamshield-llm` = Qwen3.5-9B on vLLM, thinking off, temperature
0, JSON-schema output), and page content is wrapped in delimiters and labelled as data. The reference-based
recreations output a verdict, not a score; for threshold-free metrics they get a 3-level score (1 = brand
inconsistent with the domain and a credential page, 0.5 = inconsistent brand only, 0 = otherwise).

**Not recreated, and why.** VisualPhishNet (CCS '20): whole-screenshot triplet network trained on its own
155-brand set with no released phishing-detection weights for current brands; retraining it needs a
labelled brand screenshot corpus we do not have, and the 451k-sample APWG study measured 13.5% FPR for it.
DynaPhish (USENIX Sec '23): its contribution is growing the reference list by live web search, which these
offline benchmarks exclude; its static detector is PhishIntention. PhishAgent / MemoPhishAgent / GEPAgent:
agentic multimodal pipelines built on online search and a commercial MLLM; with no image input and no web
access, what remains is ChatPhishDetector-style prompting, which is measured. The PhreshPhish GTE / Linear /
FFN baselines are trained models with no released weights; our `ours_page_gte_ft` is the same recipe
(fine-tuned GTE-family encoder on URL + HTML text), and their published numbers are shown beside ours.

### Rows

- **`llm_pp`**: 300 phishing + 300 benign pages drawn (seed 0) from the PhreshPhish rows that are in
  PhreshPhish's official test split *and* in our leak-free test split (2025-07 to 2025-12). Every LLM method
  and both our models are scored on exactly these 600 pages. `_1pct` = the same at 1% phishing prevalence,
  precision computed from the measured recall and FPR. **`llm_arabic`**: all 41 Arabic test pages.
- **`trop_shared600`** / **`llm_trop`**: 300 + 300 pages from KnowPhish's TR-OP release (OpenPhish 2022-23
  phishing + Tranco benign, with screenshots). Phishpedia, PhishIntention and every LLM method are scored on
  these same 600 pages. **`trop`**: every TR-OP page a visual method finished (n is in each file).
  This is the fair test for the visual methods: it is newer than their training data and KnowPhish's paper
  reports Phishpedia and KPD on it.
- **`phishpedia30k_indist`**: Phishpedia's own 30k benchmark (2019-20, phishing only), reported separately
  as in-distribution for Phishpedia / PhishIntention.
- **`pp_official_test`**: all 10,997 PhreshPhish official-test rows that are also in our test split
  (4,835 benign / 6,162 phishing), for the PhreshPhish base-rate protocol.

TR-OP and Phishpedia-30k rows are in **our training split**, so our models' per-row scores there would be
in-sample. For TR-OP we report instead the leave-one-source-out run of our CPU model (trained on every source
except TR-OP), from `ml/page/cache/loso.json`.

### Metrics and latency

Threshold-free: ROC-AUC, PR-AUC, recall at 0.1% and 1% FPR, where a method has a score. At each method's own
operating point: confusion matrix, precision, recall, FPR, and the same at 1% prevalence. Brand-identification
accuracy: share of flagged phishing pages whose predicted brand matches the labelled target brand. JSON /
parsing failure rate: share of pages where a required LLM answer was missing or not valid JSON on the first
attempt (such pages count as not flagged). Latency per page: visual methods one page at a time on the shared
GPU (screenshot already captured); LLM methods as the sum of their LLM calls while 12 pages run in parallel,
plus a one-page-at-a-time run on 20 pages; ours: 1 CPU thread (page_combo), GPU bf16 (page_gte_ft, from the
page benchmark).

PhreshPhish protocol (paper Sec. 5, Table 4): keep every benign page, draw phishing pages without replacement
to base rates 0.05% / 0.1% / 0.5% / 1% / 5% (586 / 296 / 59 / 29 / 5 draws) plus one 24% draw; report mean AP
and precision at 90% recall. Methods too slow for 10,997 pages (the LLM methods) get the same quantities on
the 600-page sample by re-weighting phishing pages to each base rate (expected AP; noisier because only 300
benign pages back the FPR).

### Where the comparison is still unequal

- The LLM recreations run on a 9B open model; the papers used GPT-3.5 / GPT-4(V) / Gemini-2.5-Pro.
- No image input reaches any LLM method (the served model is text-only), so PhishLLM and ChatPhishDetector
  lose their logo / screenshot evidence; visible text stands in for OCR text.
- Our brand KB (about 5.9k names, mostly Phishpedia's list) is smaller than KnowPhish's 20k-brand KB, which
  the paper shows matters most for recall.
- PhishIntention without its live CRP locator, PhishLLM without search validation: both lose recall, and
  PhishLLM may gain false positives that search validation would have removed.
- Our PhreshPhish rows are 4 of the official test shards, sampled by our data build, and PhreshPhish's
  benchmark additionally removes "easy" phishing with their model and adds benign brand pages; our
  `pp_official_test` is therefore close to, not identical to, the paper's benchmark.
- Visual latencies are measured on a GPU shared with the LLM server and other jobs; they are upper bounds.

### Same rules for every system (R30, R32)

- Same rows: in each table every system, ours included, is scored on the identical page set; a page a system
  cannot answer (our CPU model abstaining, an LLM JSON failure, an unreadable screenshot, an official-code
  exception) counts as "not flagged" for every system alike.
- Same source data: every input (HTML text, simplified HTML, screenshot, URL) is derived from the same stored
  capture; each system gets the form of it that it was designed for.
- No value is chosen on test rows. Our thresholds were fixed on the validation split before this comparison
  (`ml/artifacts/page_model_meta.json`, `ml/page/cache/hf_meta__page_gte_ft.json`). Phishpedia / PhishIntention
  use the official 0.87 Siamese threshold from their config; the LLM methods use their own boolean / A-B
  answer; the brand-KB recreations use the papers' rule (brand found, domain inconsistent, credential page).
  The PhreshPhish base rates and draw counts are the paper's (`ml/sota/page/phreshphish_table4.json`).
- Two harness changes were made after looking at the first ~100 sample outputs, both bug fixes, not tuning,
  and both disclosed here: (1) ChatPhishDetector's JSON budget was raised (its first answers were cut off
  mid-JSON: the 9B model pads long free-text fields with whitespace under constrained decoding); its earlier
  answers were discarded and the whole sample re-run. (2) The KB alias match was changed from substring to
  word-boundary prefix matching, after "UK Visas and Immigration" matched the brand "Visa".
- Brand lists, official domains and paper numbers live in data files (`ml/data/processed/brand_domains.parquet`,
  `src/scamshield/intel/data/brands.json`, `ml/sota/page/phreshphish_table4.json`); paths and the LLM endpoint
  come from environment variables (`SOTA_PAGE_WEIGHTS`, `SOTA_PAGE_REFLIST`, `SCAMSHIELD_LLM_BASE_URL`,
  `SCAMSHIELD_LLM_MODEL`).

### Results (first run, 2026-11-25)

Full tables: `python -m ml.sota.page.report`; per-file numbers in `ml/results/sota_page_*`. Latency: s/page,
one page at a time (LLM methods: one-at-a-time median over 20 pages; visual: shared GPU; `page_combo`: one CPU
thread; `page_gte_ft`: GPU bf16).

**PhreshPhish official test, 600-page balanced sample (`llm_pp`)** (2025-07 to 2025-12 pages)

| method | form | P | R | FPR | R@1%FPR | ROC-AUC | P at 1% prev. | JSON fail | s/page |
|---|---|---|---|---|---|---|---|---|---|
| KnowPhish-KPD (text) | re-implemented | 0.875 | 0.047 | 0.7% | 0.047 | 0.580 | 0.066 | 0% | 0.74 |
| PhishLLM (text) | re-implemented | 0.500 | 0.073 | 7.3% | 0.000 | 0.519 | 0.010 | 0% | 0.79 |
| ChatPhishDetector (text) | re-implemented | 0.670 | 0.723 | 35.7% | 0.000 | 0.753 | 0.020 | 13.5% | 5.38 |
| PhreshPhish LLM prompt | re-implemented (Qwen3.5-9B) | 0.751 | 0.753 | 25.0% | 0.000 | 0.759 | 0.030 | 0% | 1.78 |
| `page_combo` | ours | 1.000 | 0.330 | 0.0% | 0.403 | 0.868 | 1.000* | — | 0.017 |
| `page_gte_ft` | ours | 0.988 | 0.810 | 1.0% | 0.827 | 0.990 | 0.450 | — | 0.15 |

**KnowPhish TR-OP, 600-page balanced sample** (OpenPhish 2022-23 + Tranco; the same 600 pages for every row)

| method | form | P | R | FPR | R@1%FPR | ROC-AUC | brand-ID acc. | s/page |
|---|---|---|---|---|---|---|---|---|
| Phishpedia | as released (official code + weights) | 0.989 | 0.303 | 0.3% | 0.337 | 0.733 | 0.91 (n=91) | 0.34 (GPU) |
| PhishIntention | official code + weights, static mode (no live CRP locator) | 1.000 | 0.283 | 0.0% | 0.283 | 0.642 | 0.92 (n=85) | 0.50 (GPU) |
| KnowPhish-KPD (text) | re-implemented | 1.000 | 0.383 | 0.0% | 0.383 | 0.751 | 0.84 (n=115) | 0.74 |
| KnowPhish-KPD (Phishpedia logo + text) | re-implemented | 1.000 | 0.427 | 0.0% | 0.427 | 0.789 | 0.89 (n=128) | 1.1 |
| PhishLLM (text) | re-implemented | 0.926 | 0.627 | 5.0% | 0.000 | 0.859 | 0.60 (n=188) | 0.79 |
| ChatPhishDetector (text) | re-implemented | 0.806 | 0.900 | 21.7% | 0.027 | 0.897 | — | 5.38 |
| PhreshPhish LLM prompt | re-implemented | 0.855 | 0.963 | 16.3% | 0.000 | 0.924 | — | 1.78 |
| `page_combo`, never trained on TR-OP (leave-one-source-out, all 9,921 TR-OP pages) | ours | 0.969 | 0.839 | 2.7% | — | 0.941 | — | 0.017 |

\* 0 false positives on 300 benign pages: the 95% upper bound on FPR is 1%, so precision at 1% prevalence is
only known to be above about 0.25 for `page_combo` and about 0.3 for the zero-FP KPD rows.

**Paper-comparable checks.** On TR-OP, KnowPhish's paper reports Phishpedia at P 0.992 / R 0.402 and KPD with
its 20k-brand KB at P 0.978 / R 0.869; our harness gives Phishpedia P 0.989 / R 0.303 (600-page sample) and
the KPD recreation with our 5.9k-name KB P 1.000 / R 0.383-0.427, consistent with the paper's own finding that
KB coverage drives KPD recall (Phishpedia with the KnowPhish KB: R 0.728). On PhreshPhish's base-rate protocol
(10,997 official-test rows that are also in our test split), our fine-tuned encoder gives AP 0.46 / 0.81 /
0.98 at 0.05% / 1% / 24% against the paper's GTE 0.605 / 0.876 / 0.978, and the PhreshPhish LLM prompt on
Qwen3.5-9B gives AP 0.46 at 24% against Gemini-2.5-Pro's 0.922: the harness reproduces the paper's ordering
(fine-tuned encoder >> zero-shot LLM) and its 24% numbers, while the open 9B model is far weaker than Gemini.

**Pending.** Phishpedia and PhishIntention on the rest of TR-OP (9,321 pages) and on the Phishpedia-30k
in-distribution sample need more GPU time (about 0.34 and 0.5 s per page); both runs are resumable and
`python -m ml.sota.page.report` folds new rows in. PhishIntention's static mode reaches 0 false positives at
slightly lower recall than Phishpedia, as its paper describes; its live CRP locator, which recovers pages whose
login form sits behind a click, is the part these offline benchmarks cannot run.
