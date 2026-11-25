"""Existing / public URL classifiers, wrapped as scorers for ml.bench.runner.

Every scorer is callable url -> P(scam) and has score_batch(urls). Bulk scoring uses up to 8 threads;
single-URL calls (used for the latency numbers) run on one thread.
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np

THREADS = int(os.environ.get("BENCH_THREADS", "8"))


class HFUrlClassifier:
    """A Hugging Face sequence-classification model run on CPU with torch."""

    def __init__(self, repo: str, scam_labels: list[int] | None = None, benign_label: int | None = None,
                 max_length: int = 128, batch_size: int = 64, strip_scheme: bool = False):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.torch = torch
        self.repo = repo
        self.tok = AutoTokenizer.from_pretrained(repo)
        self.model = AutoModelForSequenceClassification.from_pretrained(repo).eval()
        self.scam_labels = scam_labels
        self.benign_label = benign_label
        self.max_length = max_length
        self.batch_size = batch_size
        self.strip_scheme = strip_scheme
        self.device = "cpu"

    def to(self, device: str) -> "HFUrlClassifier":
        self.device = device
        self.model.to(device)
        return self

    def _prep(self, urls):
        if self.strip_scheme:
            urls = [u.split("://", 1)[-1] for u in urls]
        return list(urls)

    def _probs(self, urls) -> np.ndarray:
        enc = self.tok(self._prep(urls), return_tensors="pt", truncation=True, padding=True,
                       max_length=self.max_length).to(self.device)
        with self.torch.inference_mode():
            p = self.torch.softmax(self.model(**enc).logits.float(), dim=-1).cpu().numpy()
        if self.benign_label is not None:
            return 1.0 - p[:, self.benign_label]
        return p[:, self.scam_labels].sum(axis=1)

    def score_batch(self, urls) -> np.ndarray:
        self.torch.set_num_threads(THREADS)
        urls = list(urls)
        order = np.argsort([len(u) for u in urls])  # length-sorted batches pad less
        out = np.empty(len(urls))
        for i in range(0, len(urls), self.batch_size):
            idx = order[i : i + self.batch_size]
            out[idx] = self._probs([urls[j] for j in idx])
        return out

    def __call__(self, url: str) -> float:
        self.torch.set_num_threads(1)
        return float(self._probs([url])[0])


class PirochetoOnnx:
    """pirocheto/phishing-url-detection: TF-IDF + linear SVM exported to ONNX.

    Its StringNormalizer defaults to the en_US.UTF-8 locale, which this machine lacks; we set the
    node's `locale` attribute to C.UTF-8, which leaves lower-casing of ASCII URLs unchanged."""

    def __init__(self):
        import onnx
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download

        m = onnx.load(hf_hub_download("pirocheto/phishing-url-detection", "model.onnx"))
        for n in m.graph.node:
            if n.op_type == "StringNormalizer" and not any(a.name == "locale" for a in n.attribute):
                n.attribute.append(onnx.helper.make_attribute("locale", "C.UTF-8"))
        so1 = ort.SessionOptions()
        so1.intra_op_num_threads = 1
        so8 = ort.SessionOptions()
        so8.intra_op_num_threads = THREADS
        for so in (so1, so8):  # the string ops grow the arena without bound on long runs
            so.enable_cpu_mem_arena = False
        blob = m.SerializeToString()
        self.single = ort.InferenceSession(blob, so1, providers=["CPUExecutionProvider"])
        self.bulk = ort.InferenceSession(blob, so8, providers=["CPUExecutionProvider"])

    def score_batch(self, urls) -> np.ndarray:
        urls = list(urls)
        out = []
        for i in range(0, len(urls), 512):
            out.append(self.bulk.run(None, {"inputs": np.array(urls[i : i + 512], dtype=str)})[1][:, 1])
        return np.concatenate(out) if out else np.zeros(0)

    def __call__(self, url: str) -> float:
        return float(self.single.run(None, {"inputs": np.array([url], dtype=str)})[1][0, 1])


class ConstantScorer:
    """Majority-class reference: always predicts the training set's majority class."""

    def __init__(self, value: float):
        self.value = float(value)

    def score_batch(self, urls) -> np.ndarray:
        return np.full(len(urls), self.value)

    def __call__(self, url: str) -> float:
        return self.value


RAW = Path(__file__).resolve().parents[2] / "ml" / "data" / "raw"
# feed name -> (kind, files). "host" feeds list domains (matched on host and parent domains); "url"
# feeds list full URLs (matched on the exact normalised URL, as a URL blocklist is used). Feed names
# are prefixes of the `source` values in urls.parquet, so a row's own feed can be left out.
BLOCKLIST_FEEDS = {
    "cert_pl": ("host", ["cert_pl/domains.txt"]),
    "jarelllama_scam": ("host", ["jarelllama_scam/scams.txt"]),
    "malware_filter": ("host", ["malware_filter/phishing-filter-hosts.txt"]),
    "phishing_army": ("host", ["phishing_army/phishing_army_blocklist_extended.txt"]),
    "phishing_database": ("host", ["phishing_database/phishing-domains-ACTIVE.txt"]),
    "phishing_database_links": ("url", ["phishing_database/phishing-links-ACTIVE.txt"]),
    "urlhaus": ("url", ["malware_filter/urlhaus-filter-online.txt", "urlhaus/csv_online.txt"]),
    "openphish": ("url", ["openphish/feed.txt", "openphish_github/feed.txt"]),
    "phishunt": ("url", ["phishunt/feed.txt"]),
    "phishtank": ("url", ["phishtank/online-valid.csv.gz"]),
    "urlabuse": ("url", ["urlabuse/phishing_url.txt"]),
}


def _bare(host: str) -> str:
    return host[4:] if host.startswith("www.") else host


def _lines(p: Path):
    import csv
    import gzip

    opener = gzip.open if p.suffix == ".gz" else open
    with opener(p, "rt", encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith(("#", "!", "phish_id", "id,")):
                continue
            if line.startswith(("0.0.0.0", "127.0.0.1")):
                yield line.split()[-1]
            elif "," in line and "://" in line:  # CSV row: the first field that is a URL
                yield next((f for f in next(csv.reader([line])) if "://" in f), "")
            else:
                yield line.split()[0]


class BlocklistScorer:
    """Blocklist lookup only: 1 if the URL is on a public feed pulled today (domain feeds match the
    host or a parent domain; URL feeds match the exact normalised URL), else 0.

    Most benchmark phishing rows came from these same feeds, so score_rows(cross_feed) ignores the
    feed a row was taken from; that measures what the *other* blocklists already know."""

    def __init__(self, entries: dict[str, int], feed_bits: dict[str, int]):
        self.entries = entries  # host or normalised URL -> bitmask of feeds
        self.feed_bits = feed_bits

    @classmethod
    def from_raw(cls) -> "BlocklistScorer":
        from scamshield.models.url_features import normalize_for_text, parse_url

        entries: dict[str, int] = {}
        bits = {name: 1 << i for i, name in enumerate(BLOCKLIST_FEEDS)}
        for name, (kind, files) in BLOCKLIST_FEEDS.items():
            for rel in files:
                if not (RAW / rel).exists():
                    continue
                for tok in _lines(RAW / rel):
                    if not tok:
                        continue
                    key = _bare(parse_url(tok).host) if kind == "host" else normalize_for_text(tok)
                    if key and "." in key and key not in ("0.0.0.0", "localhost"):
                        entries[key] = entries.get(key, 0) | bits[name]
        return cls(entries, bits)

    def _mask(self, url: str) -> int:
        from scamshield.models.url_features import normalize_for_text, parse_url

        m = self.entries.get(normalize_for_text(url), 0)
        parts = _bare(parse_url(url).host).split(".")
        for i in range(len(parts) - 1):
            m |= self.entries.get(".".join(parts[i:]), 0)
        return m

    def __call__(self, url: str) -> float:
        return float(self._mask(url) != 0)

    def score_batch(self, urls) -> np.ndarray:
        return np.array([self(u) for u in urls])

    def score_rows(self, urls, sources) -> np.ndarray:
        """Cross-feed lookup: ignore the feed(s) the row itself came from."""
        out = []
        for u, src in zip(urls, sources):
            own = 0
            for n, b in self.feed_bits.items():
                if str(src).startswith(n):
                    own |= b
            out.append(float(self._mask(u) & ~own != 0))
        return np.array(out)


class IntelReputationScorer:
    """The intel component's local reputation lookup (scamshield.intel.reputation), if installed."""

    def __init__(self):
        from scamshield.intel import reputation

        self.reputation = reputation

    def __call__(self, url: str) -> float:
        from scamshield.models.url_features import parse_url

        allow, _owner, block, _src = self.reputation(parse_url(url).host)
        return 1.0 if block and not allow else 0.0

    def score_batch(self, urls) -> np.ndarray:
        return np.array([self(u) for u in urls])


# name -> (factory, rows to sample per dataset or None for all, note)
HF_BASELINES = {
    "hf_urlbert_tiny_v4": (lambda: HFUrlClassifier("CrabInHoney/urlbert-tiny-v4-phishing-classifier", scam_labels=[1], max_length=64),
                           20000, "CrabInHoney/urlbert-tiny-v4-phishing-classifier, 3.7M params, trained on ealvaradob/phishing-dataset"),
    "hf_pirocheto_tfidf_svm": (PirochetoOnnx, 50000,
                               "pirocheto/phishing-url-detection ONNX (TF-IDF + linear SVM), trained on pirocheto/phishing-url"),
    "hf_kmack_distilbert": (lambda: HFUrlClassifier("kmack/malicious-url-detection", scam_labels=[1], batch_size=64),
                            20000, "kmack/malicious-url-detection, DistilBERT 66M, trained on kmack/Phishing_urls"),
    "hf_ealvaradob_bert_large": (lambda: HFUrlClassifier("ealvaradob/bert-finetuned-phishing", scam_labels=[1], batch_size=32),
                                 6000, "ealvaradob/bert-finetuned-phishing, BERT-large 335M, trained on ealvaradob/phishing-dataset"),
    "hf_horizon_scam_text": (lambda: HFUrlClassifier("Horizon-Labs/phishing-scam-detector-base", scam_labels=[2], batch_size=32),
                             2000, "Horizon-Labs/phishing-scam-detector-base, mmBERT 307M message-text model (fraud/spam/legit) "
                                   "applied to the URL string; P(scam)=P(fraud). Off-domain reference"),
}

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
