"""Serving wrapper for the page-content model.

    score_page(page)       -> P(scam) in [0, 1], or None (no artifact / no usable HTML)
    top_features(page, k)  -> [(reason, signed contribution)], strongest push towards "scam" first
    info()                 -> name, version, metrics, artifact path, which path produced scores

CPU model: `<MODEL_DIR>/page_model.joblib` (written by `ml/page/train.py`), a TF-IDF word + character
n-gram logistic regression over the page text and a LightGBM model over the structural features plus
that text model's margin, Platt-calibrated. Pure CPU, single-threaded, no network.

GPU tier (optional): when SCAMSHIELD_PAGE_ENCODER_URL is set (e.g. http://host.docker.internal:8003),
`score_page` also asks the fine-tuned page encoder service (`ml/serve/page_encoder_server.py`) and
returns the logistic combination fitted on validation (`<MODEL_DIR>/page_served.json`, written by
`ml/page/fit_served.py`). The call has a hard timeout (ENCODER_TIMEOUT_S) and a circuit breaker:
after a failure no call is made for BREAKER_OPEN_S seconds. Whenever the service is unset, slow or
down, the CPU score is returned exactly as without it. `top_features` always explains the CPU model.
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from scamshield import config
from scamshield.models.page_features import (FEATURE_LABELS, STRUCT_NAMES, PageFeatures, encoder_input,
                                             extract_snapshot)

ARTIFACT_NAME = "page_model.joblib"
SERVED_NAME = "page_served.json"
ENCODER_TIMEOUT_S = float(os.environ.get("SCAMSHIELD_PAGE_ENCODER_TIMEOUT", "1.2"))
BREAKER_OPEN_S = 30.0
# Abstain (return None) on pages with too little content to judge (see `abstain_flags`). Such pages
# (parked pages, example.com, JS-only shells) look like many small phishing pages in the training
# data, so a score would mostly reflect that bias.
MIN_TEXT_CHARS = 300

_lock = threading.Lock()
_bundle: dict | None = None
_load_error: str | None = None
_loaded_from: Path | None = None


def _artifact_path() -> Path:
    return Path(config.MODEL_DIR) / ARTIFACT_NAME


def _load() -> dict | None:
    global _bundle, _load_error, _loaded_from
    if _bundle is not None:
        return _bundle
    with _lock:
        if _bundle is not None:
            return _bundle
        path = _artifact_path()
        if not path.exists():
            _load_error = f"artifact not found: {path}"
            return None
        try:
            import joblib

            b = joblib.load(path)
            b["lgbm"].params["num_threads"] = 1
            _bundle, _loaded_from, _load_error = b, path, None
        except Exception as exc:  # corrupt / incompatible artifact: report, do not crash the engine
            _load_error = f"{type(exc).__name__}: {exc}"
            return None
    return _bundle


# ---------------------------------------------------------------------------------------------
# Scoring core, shared with training / evaluation code


def text_matrix(bundle: dict, docs: list[str]):
    from scipy.sparse import hstack

    w = bundle["word_vec"].transform(docs)
    c = bundle["char_vec"].transform([d[: bundle["char_chars"]] for d in docs])
    return hstack([w, c], format="csr")


def text_margin(bundle: dict, docs: list[str]) -> np.ndarray:
    return bundle["text_lr"].decision_function(text_matrix(bundle, docs))


def combo_input(struct: np.ndarray, margin: np.ndarray) -> np.ndarray:
    return np.column_stack([np.atleast_2d(struct), np.asarray(margin).reshape(-1, 1)]).astype(np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def calibrated(bundle: dict, raw: np.ndarray) -> np.ndarray:
    a, b = bundle["calib"]
    return _sigmoid(a * np.asarray(raw) + b)


def struct_matrix(bundle: dict, feats: list[PageFeatures]) -> np.ndarray:
    """Structural features in the column order the artifact was trained with (an artifact trained on an
    older feature list keeps working: missing columns are zero, extra ones are dropped)."""
    S = np.vstack([f.struct for f in feats])
    names = bundle["struct_names"]
    if list(names) == list(STRUCT_NAMES):
        return S
    pos = {n: i for i, n in enumerate(STRUCT_NAMES)}
    out = np.zeros((len(feats), len(names)), dtype=np.float32)
    for j, n in enumerate(names):
        if n in pos:
            out[:, j] = S[:, pos[n]]
    return out


_IDX = {n: i for i, n in enumerate(STRUCT_NAMES)}


_ACTIVE = ("js_scramble_score", "js_redirect", "meta_refresh", "iframe_external", "js_telegram_api",
           "js_cloak_score", "js_doc_write")


def abstain_flags(S: np.ndarray, n_text_chars: np.ndarray) -> np.ndarray:
    """True for pages with too little content to judge: under MIN_TEXT_CHARS of visible text, no form or
    input field, and no active-content signal (scrambled script, JS / meta redirect, external iframe,
    Telegram exfiltration, cloaking gate, document.write) - pages with those are still scored."""
    S = np.atleast_2d(S)
    has_form = (S[:, _IDX["n_inputs"]] > 0) | (S[:, _IDX["n_forms"]] > 0) | (S[:, _IDX["n_selects"]] > 0)
    active = np.zeros(len(S), dtype=bool)
    for n in _ACTIVE:
        active |= S[:, _IDX[n]] > 0
    return (np.asarray(n_text_chars) < MIN_TEXT_CHARS) & ~has_form & ~active


def should_abstain(feats: PageFeatures) -> bool:
    return bool(abstain_flags(feats.struct, np.array([feats.n_text_chars]))[0])


def score_features(bundle: dict, feats: list[PageFeatures], num_threads: int = 1) -> np.ndarray:
    margin = text_margin(bundle, [f.doc for f in feats])
    x = combo_input(struct_matrix(bundle, feats), margin)
    raw = bundle["lgbm"].predict(x, raw_score=True, num_threads=num_threads)
    return calibrated(bundle, raw)


# ---------------------------------------------------------------------------------------------
# Public API


# ---------------------------------------------------------------------------------------------
# GPU encoder tier


_served: dict | None = None
_served_checked = False
_client = None
_breaker_until = 0.0
_paths = {"combined": 0, "cpu": 0, "cpu_fallback": 0, "abstain": 0}
_last_path: str | None = None
_last_error: str | None = None


def _served_params() -> dict | None:
    global _served, _served_checked
    if not _served_checked:
        with _lock:
            path = Path(config.MODEL_DIR) / SERVED_NAME
            try:
                _served = json.loads(path.read_text()) if path.exists() else None
            except (OSError, ValueError):
                _served = None
            _served_checked = True
    return _served


def _encoder_url() -> str:
    return os.environ.get("SCAMSHIELD_PAGE_ENCODER_URL", "").rstrip("/")


def encoder_score(text: str) -> float | None:
    """P(scam) from the encoder service, or None (unset, breaker open, timeout, any error)."""
    global _client, _breaker_until, _last_error
    url = _encoder_url()
    if not url or time.monotonic() < _breaker_until:
        return None
    try:
        import httpx

        if _client is None:
            with _lock:
                if _client is None:
                    _client = httpx.Client(timeout=ENCODER_TIMEOUT_S, trust_env=False)
        r = _client.post(f"{url}/score", json={"texts": [text]})
        r.raise_for_status()
        return float(r.json()["scores"][0])
    except Exception as exc:  # slow / down / bad answer: open the breaker and use the CPU model
        _last_error = f"{type(exc).__name__}: {exc}"[:200]
        _breaker_until = time.monotonic() + BREAKER_OPEN_S
        return None


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def combine(params: dict, p_cpu: float, p_enc: float, abstain: bool) -> float:
    """Served combination: logistic regression over [CPU logit (0 when the CPU model abstains),
    encoder logit, abstain flag], fitted on validation by ml/page/fit_served.py."""
    z = (params["w_cpu"] * (0.0 if abstain else _logit(p_cpu)) + params["w_enc"] * _logit(p_enc)
         + params["w_abstain"] * float(abstain) + params["b"])
    return 1.0 / (1.0 + math.exp(-z))


def _record(path: str) -> None:
    global _last_path
    _last_path = path
    _paths[path] += 1


def score_page(page) -> float | None:
    """P(scam) for a fetched page, or None when no model is installed, the page has no usable HTML, or it
    has too little content to judge and no encoder answer is available (see `should_abstain`)."""
    bundle = _load()
    if bundle is None:
        return None
    try:
        feats = extract_snapshot(page)
        if feats is None:
            return None
        abstain = should_abstain(feats)
        p_cpu = float(score_features(bundle, [feats])[0])
        params = _served_params()
        fell_back = False
        if params is not None and _encoder_url():
            p_enc = encoder_score(encoder_input(page.final_url or page.url, feats.title, feats.doc, feats.struct))
            if p_enc is not None:
                _record("combined")
                return combine(params, p_cpu, p_enc, abstain)
            _record("cpu_fallback")
            fell_back = True
        if abstain:
            if not fell_back:
                _record("abstain")
            return None
        if not fell_back:
            _record("cpu")
        return p_cpu
    except Exception:
        return None


def _text_reasons(bundle: dict, doc: str, k: int) -> list[tuple[str, float]]:
    """Strongest n-grams of this page in the text model, as (label, coef * tf-idf)."""
    x = text_matrix(bundle, [doc]).tocoo()
    coef = bundle["text_lr"].coef_[0]
    contrib = x.data * coef[x.col]
    names = bundle["text_feature_names"]
    order = np.argsort(-contrib)[:k]
    return [(f"text: “{names[x.col[i]].strip()}”", float(contrib[i])) for i in order if contrib[i] > 0]


def top_features(page, k: int = 5) -> list[tuple[str, float]]:
    """Features that pushed this page's score most, as (human-readable reason, contribution in log-odds).

    Positive values push towards scam. The text model's contribution is broken down into the page
    n-grams that carry it, so the pipeline can quote words from the page.
    """
    bundle = _load()
    if bundle is None:
        return []
    try:
        feats = extract_snapshot(page)
        if feats is None:
            return []
        margin = text_margin(bundle, [feats.doc])
        x = combo_input(struct_matrix(bundle, [feats]), margin)
        contrib = bundle["lgbm"].predict(x, pred_contrib=True, num_threads=1)[0][:-1] * bundle["calib"][0]
        names = list(bundle["struct_names"]) + ["text_model"]
        out: list[tuple[str, float]] = []
        for i in np.argsort(-np.abs(contrib)):
            c = float(contrib[i])
            if abs(c) < 1e-3 or len(out) >= k:
                continue
            name = names[i]
            if name == "text_model":
                words = _text_reasons(bundle, feats.doc, 3) if c > 0 else []
                label = "page wording" + (": " + ", ".join(w[0][6:] for w in words) if words else "")
                out.append((label, c))
                continue
            v = float(x[0, i])
            if v == 0:  # an absent signal is not a reason anyone can read
                continue
            label = FEATURE_LABELS.get(name)
            out.append((label if label else f"{name.replace('_', ' ')} = {v:g}", c))
        out.sort(key=lambda t: -t[1])
        return out[:k]
    except Exception:
        return []


def info() -> dict[str, Any]:
    bundle = _load()
    params = _served_params()
    tier = {
        "encoder_url": _encoder_url() or None,
        "served_combination": params,
        "breaker_open": time.monotonic() < _breaker_until,
        "last_path": _last_path,  # combined | cpu | cpu_fallback | abstain
        "paths": dict(_paths),
        "last_encoder_error": _last_error,
    }
    if bundle is None:
        return {"name": "page_model", "available": False, "error": _load_error, "path": str(_artifact_path()),
                "gpu_tier": tier}
    return {
        "name": bundle.get("name", "page_model"),
        "available": True,
        "version": bundle.get("version"),
        "trained_at": bundle.get("trained_at"),
        "threshold": bundle.get("threshold"),
        "threshold_rule": bundle.get("threshold_rule"),
        "abstains_below_text_chars": MIN_TEXT_CHARS,
        "n_struct_features": len(bundle["struct_names"]),
        "n_text_features": len(bundle["text_feature_names"]),
        "metrics": bundle.get("metrics", {}),
        "path": str(_loaded_from),
        "gpu_tier": tier,
    }


__all__ = ["score_page", "top_features", "info", "score_features", "should_abstain", "abstain_flags", "struct_matrix",
           "text_margin", "combo_input", "calibrated", "combine", "encoder_score"]
