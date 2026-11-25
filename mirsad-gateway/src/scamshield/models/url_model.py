"""URL-only scam model: P(scam) from the URL string, no network.

Artifact: `config.MODEL_DIR / "url_model.joblib"`, written by `ml/url/train.py`. It holds only numpy
arrays, a LightGBM model string and plain metadata, so it loads with any recent numpy / lightgbm /
scikit-learn. The model is a stack:

  1. character 1-5-gram TF-IDF (hashed) of the normalised URL -> logistic regression logit
  2. LightGBM over the engineered lexical / host features plus that logit
  3. isotonic calibration of the LightGBM output

When `url_encoder.int8.onnx`, `url_encoder.tokenizer.json`, `url_encoder.vocab_map.npy` and
`url_ensemble.json` (written by `ml/url/export_onnx.py`) are also present, the served score is the
calibrated ensemble of the stack and a fine-tuned URL transformer (mmBERT-small, int8 ONNX on CPU,
one thread). If any of them is missing or fails to load, the stack alone is served.
"""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from scamshield.models.url_features import FEATURE_NAMES, normalize_for_text, url_features_matrix

ARTIFACT_NAME = "url_model.joblib"
ENSEMBLE_META = "url_ensemble.json"

_lock = threading.Lock()
_scorer: "UrlScorer | EnsembleScorer | None" = None
_load_error: str | None = None


class UrlScorer:
    """Scores URLs with the arrays stored in an artifact dict (see ml/url/train.py)."""

    def __init__(self, art: dict):
        import lightgbm as lgb
        from sklearn.feature_extraction.text import HashingVectorizer

        if tuple(art["feature_names"]) != FEATURE_NAMES:
            raise ValueError("artifact was trained with a different feature set")
        self.meta = art["meta"]
        self.hasher = HashingVectorizer(**art["hasher"])
        self.idf = np.asarray(art["idf"], dtype=np.float32)
        self.coef = np.asarray(art["lr_coef"], dtype=np.float32) if art.get("lr_coef") is not None else None
        self.intercept = float(art["lr_intercept"])
        self.booster = lgb.Booster(model_str=art["lgbm"]) if art.get("lgbm") else None
        self.cal_x = np.asarray(art["calib_x"], dtype=float) if art.get("calib_x") is not None else None
        self.cal_y = np.asarray(art["calib_y"], dtype=float) if art.get("calib_y") is not None else None
        self.threshold = float(art["threshold"])

    def text_logit(self, urls: list[str]) -> np.ndarray:
        X = self.hasher.transform([normalize_for_text(u) for u in urls]).astype(np.float32)
        X.data = (1.0 + np.log(X.data)) * self.idf[X.indices]  # sublinear tf * idf
        norms = np.sqrt(np.asarray(X.multiply(X).sum(axis=1)).ravel())
        norms[norms == 0] = 1.0
        return np.asarray(X @ self.coef).ravel() / norms + self.intercept

    def raw_scores(self, urls: list[str]) -> np.ndarray:
        """Uncalibrated output: LightGBM probability (stack / features-only) or the text model's sigmoid."""
        if self.booster is None:
            return 1.0 / (1.0 + np.exp(-self.text_logit(urls)))
        F = url_features_matrix(urls)
        if self.coef is not None:  # stack: engineered features + text logit
            F = np.column_stack([F, self.text_logit(urls).astype(np.float32)])
        return self.booster.predict(F, num_threads=1)

    def calibrate(self, raw: np.ndarray) -> np.ndarray:
        if self.cal_x is None:
            return raw
        return np.interp(raw, self.cal_x, self.cal_y)

    def score_batch(self, urls: list[str]) -> np.ndarray:
        out = np.empty(len(urls))
        for i in range(0, len(urls), 20000):
            chunk = list(urls[i : i + 20000])
            out[i : i + len(chunk)] = self.calibrate(self.raw_scores(chunk))
        return out

    def __call__(self, url: str) -> float:
        return float(self.score_batch([url])[0])


class EnsembleScorer:
    """Calibrated logit average of the stack and the int8 ONNX URL transformer (see ml/url/export_onnx.py)."""

    def __init__(self, stack: UrlScorer, model_dir: Path, meta: dict, threads: int = 1):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(str(model_dir / "url_encoder.int8.onnx"), so, providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(str(model_dir / "url_encoder.tokenizer.json"))
        self.tok.enable_truncation(int(meta["max_len"]))
        self.tok.enable_padding(pad_id=0, pad_token="<pad>")
        self.vocab_map = np.load(model_dir / "url_encoder.vocab_map.npy")
        self.stack = stack
        self.w = float(meta["stack_weight"])
        self.cal_x = np.asarray(meta["calib_x"], dtype=float) if meta.get("calib_x") else None
        self.cal_y = np.asarray(meta["calib_y"], dtype=float) if meta.get("calib_y") else None
        self.threshold = float(meta["threshold"])
        self.meta = {**stack.meta, "model": "url_ensemble (url_stack + url_mmbert_ft int8)",
                     "ensemble": {k: v for k, v in meta.items() if k not in ("calib_x", "calib_y")}}

    def encoder_probs(self, urls: list[str], batch: int = 256) -> np.ndarray:
        out = np.empty(len(urls))
        order = np.argsort([len(u) for u in urls])
        for i in range(0, len(urls), batch):
            idx = order[i : i + batch]
            enc = self.tok.encode_batch([normalize_for_text(urls[j]) for j in idx])
            ids = self.vocab_map[np.array([e.ids for e in enc])].astype(np.int64)
            mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
            logits = self.sess.run(None, {"input_ids": ids, "attention_mask": mask})[0]
            z = logits - logits.max(axis=1, keepdims=True)
            p = np.exp(z)
            out[idx] = p[:, 1] / p.sum(axis=1)
        return out

    @staticmethod
    def _logit(p: np.ndarray) -> np.ndarray:
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return np.log(p / (1 - p))

    @classmethod
    def combine_static(cls, w: float, stack_raw: np.ndarray, enc_p: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-(w * cls._logit(stack_raw) + (1 - w) * cls._logit(enc_p))))

    def combine(self, stack_raw: np.ndarray, enc_p: np.ndarray) -> np.ndarray:
        return self.combine_static(self.w, stack_raw, enc_p)

    def score_batch(self, urls: list[str]) -> np.ndarray:
        urls = list(urls)
        raw = self.combine(self.stack.raw_scores(urls), self.encoder_probs(urls))
        return np.interp(raw, self.cal_x, self.cal_y) if self.cal_x is not None else raw

    def __call__(self, url: str) -> float:
        return float(self.score_batch([url])[0])


def _load(model_dir: Path, threads: int = 1) -> "UrlScorer | EnsembleScorer":
    import json

    import joblib

    stack = UrlScorer(joblib.load(model_dir / ARTIFACT_NAME))
    meta_path = model_dir / ENSEMBLE_META
    if meta_path.exists():
        try:
            return EnsembleScorer(stack, model_dir, json.loads(meta_path.read_text()), threads=threads)
        except Exception:  # missing onnxruntime / tokenizers or a partial artifact: serve the stack alone
            return stack
    return stack


def _get() -> "UrlScorer | EnsembleScorer | None":
    global _scorer, _load_error
    if _scorer is not None or _load_error is not None:
        return _scorer
    with _lock:
        if _scorer is None and _load_error is None:
            try:
                from scamshield import config

                path = Path(config.MODEL_DIR) / ARTIFACT_NAME
                if not path.exists():
                    _load_error = f"missing {path}"
                else:
                    _scorer = _load(Path(config.MODEL_DIR))
            except Exception as exc:  # a broken artifact must not break the engine
                _load_error = f"{type(exc).__name__}: {exc}"
    return _scorer


def score_url(url: str) -> float | None:
    """Calibrated P(scam) for one URL, or None when no model is installed or the URL is unusable."""
    s = _get()
    if s is None or not url or not isinstance(url, str):
        return None
    try:
        return s(url)
    except Exception:
        return None


def info() -> dict:
    s = _get()
    if s is None:
        return {"available": False, "error": _load_error}
    return {"available": True, "threshold": s.threshold, **s.meta}
