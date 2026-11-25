# Published URL-only phishing detectors, recreated and scored on our rows

Every method here is trained on **the same training rows as our URL models** and scored on **the same test
rows**, and writes `ml/results/sota_url_<method>__<dataset>.json` in the shared `compute_metrics` shape, so
`python -m ml.bench.report` lists it next to ours. The protocol is in
[`docs/BENCHMARK_PROTOCOL.md`](../../../docs/BENCHMARK_PROTOCOL.md) ("URL-based methods").

| method | paper | form | code here |
|---|---|---|---|
| URLNet | Le et al. 2018, arXiv 1802.03162 | re-implemented in PyTorch from the official TF1 code (no weights released) | `urlnet.py` |
| GramBeddings | Bozkir et al., Computers & Security 2023 | re-implemented in PyTorch from the official TF2 code (no weights released) | `grambeddings.py` |
| URLBERT | Li et al. 2024, arXiv 2402.11495 | authors' released pre-trained encoder, fine-tuned with their phishing recipe (no fine-tuned classifier released) | `urlbert.py` |
| PhreshPhish Linear (URL only) | Dalton et al. 2025, arXiv 2507.10854 | re-implemented from the paper (char 2-4-grams + hand-crafted URL features, LinearSVC) | `phreshphish_linear.py` |

Every file's docstring lists the architecture, the hyper-parameters taken from the authors' code or paper, and
every deviation. URLTran (Microsoft, arXiv 2106.05256) has no public code or weights; its recipe (fine-tune a
pre-trained transformer on URL strings) is what our `url_mmbert_ft` and the URLBERT row implement.

## Re-run

All commands from the repo root, with the CUDA virtualenv. Large intermediate files (frozen rows, encoded
inputs, trained weights) go to `$SCAMSHIELD_SOTA_WORK`, default `data/sota/url/` (git-ignored); point the
variable at a bigger disk if needed. Shared settings (sampling caps, the 0.2%-validation-FPR threshold rule,
latency sample sizes, GPU memory cap, the published numbers we compare against) are in `protocol.json`. GPU
jobs refuse to start when the shared GPU has less free memory than their cap; run one at a time.

```bash
P="nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m"
$P ml.sota.url.data                                  # freeze train / val / test rows (~1 min, CPU)
$P ml.sota.url.phreshphish_fetch                     # PhreshPhish url/label/sha256 + 975 benchmark lists, no HTML
$P ml.sota.url.urlnet                                # GPU, ~30 min
$P ml.sota.url.grambeddings --prep && $P ml.sota.url.grambeddings   # CPU prep ~5 min, then GPU ~30 min
$P ml.sota.url.urlbert                               # GPU, ~35 min; needs the weights below
$P ml.sota.url.urlnet --paper-check                  # GPU, ~10 min: GramBeddings dataset split
$P ml.sota.url.grambeddings --prep --paper-check && $P ml.sota.url.grambeddings --paper-check
$P ml.sota.url.phreshphish_linear --setting paper    # CPU, the paper-comparable check
$P ml.sota.url.phreshphish_linear --setting ours     # CPU
$P ml.sota.url.summary                               # comparison table + paper check
```

Official code is cloned for reading into `ml/sota/url/vendor/` (git-ignored) and never executed:

```bash
cd ml/sota/url/vendor
git clone --depth 1 https://github.com/Antimalweb/URLNet
git clone --depth 1 https://github.com/fcdalgic/GramBeddings
git clone --depth 1 https://github.com/Davidup1/URLBERT
mkdir urlbert_weights && cd urlbert_weights && gdown --folder https://drive.google.com/drive/folders/16pNq7C1gYKR9inVD-P8yPBGS37nitE-D
```
