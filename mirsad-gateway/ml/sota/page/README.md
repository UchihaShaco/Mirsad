# Page-based, visual and LLM-based SOTA methods

Every method here is scored on stored captures (HTML, screenshot, URL string) from
`ml/data/processed/pages.parquet`. Nothing connects to a live site; HTML is parsed as text only.
Protocol and caveats: [`docs/BENCHMARK_PROTOCOL.md`](../../../docs/BENCHMARK_PROTOCOL.md#page-based-visual-and-llm-based-methods).

| file | what |
|---|---|
| `common.py` | fixed row samples, HTML streaming, brand knowledge base, domain-brand consistency rule |
| `visual_ref.py` | Phishpedia / PhishIntention: official code and weights on the stored screenshots |
| `llm_methods.py` | KnowPhish-KPD, PhishLLM, ChatPhishDetector and the PhreshPhish LLM baseline on the local LLM |
| `ours.py` | our page models on the same rows |
| `phreshphish_table4.json` | the PhreshPhish paper's published baseline numbers and base-rate protocol (cited) |
| `report.py` | metrics in the shared `ml/bench/metrics.py` shape → `ml/results/sota_page_*__<dataset>.json` |
| `cache/` | the fixed samples (`sample__*.parquet`), raw per-row outputs, `report.json` |

## Setup of the visual stack (once, about 10 minutes)

The authors ship a pixi/conda environment and a CUDA Detectron2 build. We reuse the project's
`.venv-gpu` torch (2.11 + cu128) and add torchvision plus a Detectron2 build with CPU-only custom
ops (Faster R-CNN inference uses torchvision's ROIAlign / NMS, so it still runs on the GPU). The
system nvcc (13.x) does not match torch's CUDA 12.8, which is why the custom CUDA ops are skipped.

```bash
cd ml/sota/page && mkdir -p vendor && cd vendor          # vendor/ is git-ignored
git clone --depth 1 https://github.com/lindsey98/Phishpedia.git       # tested at d030779
git clone --depth 1 https://github.com/lindsey98/PhishIntention.git   # tested at 69613c2
git clone --depth 1 https://github.com/facebookresearch/detectron2.git  # tested at 247691a
python3.12 -m venv env
../../../../.venv-gpu/bin/python -c "import site; print(site.getsitepackages()[0])" \
    > env/lib/python3.12/site-packages/zz_gpu_venv.pth          # reuse the GPU venv's torch
env/bin/pip install --no-deps torchvision==0.26.0 --index-url https://download.pytorch.org/whl/cu128
env/bin/pip install pillow gdown fvcore iopath pycocotools opencv-python-headless tldextract unidecode \
    omegaconf hydra-core cloudpickle termcolor yacs tabulate matplotlib lxml editdistance
(cd detectron2 && CUDA_VISIBLE_DEVICES= FORCE_CUDA=0 ../env/bin/pip install --no-build-isolation --no-deps -e .)
```

Weights (Google Drive ids from the authors' `setup.sh`) go to `$SOTA_PAGE_WEIGHTS` (default
`ml/sota/page/vendor/weights`, git-ignored) and the logo reference list to `$SOTA_PAGE_REFLIST`
(default `ml/sota/page/vendor/reflist_expand_targetlist`). Point the weights variable at a big disk if needed;
keep the reference list on a fast local disk (about 3,700 small files are read at start-up).

```bash
W=${SOTA_PAGE_WEIGHTS:-ml/sota/page/vendor/weights}; G=ml/sota/page/vendor/env/bin/gdown
mkdir -p $W/phishpedia $W/phishintention
$G 1tE2Mu5WC8uqCxei3XqAd7AWaP5JTmVWH -O $W/phishpedia/rcnn_bet365.pth
$G 1Q6lqjpl4exW7q_dPbComcj0udBMDl8CW -O $W/phishpedia/faster_rcnn.yaml
$G 1H0Q_DbdKPLFcZee8I14K62qV7TTy7xvS -O $W/phishpedia/resnetv2_rgb_new.pth.tar
$G 1HWjE5Fv-c3nCDzLCBc7I3vClP1IeuP_I -O $W/phishintention/layout_detector.pth
$G 1igEMRz0vFBonxAILeYMRWTyd7A9sRirO -O $W/phishintention/crp_classifier.pth.tar
$G 1_O5SALqaJqvWoZDrdIVpsZyCnmSkzQcm -O $W/phishintention/crp_locator.pth
$G 15pfVWnZR-at46gqxd50cWhrXemP8oaxp -O $W/phishintention/ocr_pretrained.pth.tar
$G 1BxJf5lAcNEnnC0In55flWZ89xwlYkzPk -O $W/phishintention/ocr_siamese.pth.tar
unzip -q ml/data/raw_pages/phishpedia/expand_targetlist.zip -d ml/sota/page/vendor/reflist_tmp \
    && mv ml/sota/page/vendor/reflist_tmp/expand_targetlist ml/sota/page/vendor/reflist_expand_targetlist
```

The checkpoints are pickles. They are loaded by torch 2.11's `torch.load`, whose default is
`weights_only=True` (restricted unpickler, tensors and plain containers only), in a separate
process. The brand → domain `domain_map.pkl` is read with a restricted unpickler and re-written
before the official code sees it. The official `tldextract` call is pointed at the bundled public
suffix snapshot so it never downloads anything.

## Re-run

```bash
# 1. visual methods (GPU, one job at a time; resumable; the 600 shared TR-OP rows come first)
nice -n 19 ionice -c 3 ml/sota/page/vendor/env/bin/python -I ml/sota/page/visual_ref.py \
    --method phishpedia --out ml/sota/page/cache/visual__phishpedia.parquet [--limit 600]
nice -n 19 ionice -c 3 ml/sota/page/vendor/env/bin/python -I ml/sota/page/visual_ref.py \
    --method phishintention --out ml/sota/page/cache/visual__phishintention.parquet [--limit 600]
# 2. LLM-based methods (any OpenAI-compatible server; resumable)
export SCAMSHIELD_LLM_BASE_URL=http://localhost:8001/v1 SCAMSHIELD_LLM_MODEL=scamshield-llm
for s in llm_pp llm_arabic llm_trop; do nice -n 19 .venv/bin/python -m ml.sota.page.llm_methods --sample $s; done
nice -n 19 .venv/bin/python -m ml.sota.page.llm_methods --sample llm_pp --c1 20   # one-page-at-a-time latency
# 3. our models on the same rows, then the report
OMP_NUM_THREADS=1 nice -n 19 .venv/bin/python -m ml.sota.page.ours
.venv/bin/python -m ml.sota.page.report
```
