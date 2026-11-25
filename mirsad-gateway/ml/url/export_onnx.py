"""Export the fine-tuned URL transformer for CPU serving and calibrate the stack + transformer ensemble.

Steps (CPU only):
  1. prune the 256k-token embedding to the token ids that occur in the training URLs (others map to
     <unk> through a lookup table), which cuts the model from ~140M to ~60M parameters;
  2. export to ONNX and quantise the weights to int8 (dynamic quantisation);
  3. check the int8 model against the bf16/fp32 original on validation URLs;
  4. score the validation calibration half (stack raw + transformer), fit the isotonic calibration of
     the ensemble and set its threshold at the stack's validation FPR. The int8 model runs at only
     ~40 URLs/s in bulk on a busy CPU, so the transformer's validation scores come from the original
     weights on the GPU when one is available (step 3 shows int8 tracks them); the served int8
     pipeline itself is what ml/url/evaluate.py measures on the test sets.

Writes ml/artifacts/url_encoder.int8.onnx, url_encoder.tokenizer.json, url_encoder.vocab_map.npy and
url_ensemble.json, which scamshield.models.url_model picks up (it falls back to the stack alone when
any of them is missing).

    PYTHONPATH=src:. nice -n 19 .venv-gpu/bin/python -m ml.url.export_onnx
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import joblib
import numpy as np

from ml.bench.metrics import compute_metrics, threshold_for_fpr
from ml.url.train import cap_per_source, domain_halves, fit_isotonic, load_training_frame, log
from ml.url.train_gpu import OUT_DIR
from scamshield.models.url_features import normalize_for_text
from scamshield.models.url_model import ENSEMBLE_META, EnsembleScorer, UrlScorer

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "ml" / "artifacts"
W = 0.65  # stack weight chosen on validation by ml/url/ensemble.py


def main() -> None:
    import argparse

    import torch
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    ap = argparse.ArgumentParser()
    ap.add_argument("--calibrate-only", action="store_true", help="reuse the exported int8 model, redo step 4 only")
    a = ap.parse_args()
    torch.set_num_threads(8)
    meta = json.loads((OUT_DIR / "threshold.json").read_text())
    tok = AutoTokenizer.from_pretrained(OUT_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(OUT_DIR, attn_implementation="eager",
                                                               torch_dtype=torch.float32).eval()

    df = load_training_frame(ROOT / "ml" / "data" / "processed" / "urls.parquet")
    tr = cap_per_source(df[df.split == "train"], 100_000, {"phreshphish": 250_000})
    va = cap_per_source(df[df.split == "val"], 25_000, {"phreshphish": 100_000})
    del df
    va = va[~domain_halves(va.registered_domain)].reset_index(drop=True)

    stack = UrlScorer(joblib.load(ART / "url_stack.joblib"))
    ens_meta = {"stack_weight": W, "max_len": meta["max_len"], "base": meta["base"], "threshold": 0.5,
                "calib_x": None, "calib_y": None}
    if a.calibrate_only:
        kept = np.unique(np.load(ART / "url_encoder.vocab_map.npy"))
    else:
        # 1. vocabulary pruning
        seen = np.zeros(model.config.vocab_size, dtype=bool)
        texts = [normalize_for_text(u) for u in tr.url]
        for i in range(0, len(texts), 50_000):
            for ids in tok(texts[i : i + 50_000], truncation=True, max_length=meta["max_len"])["input_ids"]:
                seen[ids] = True
        for t in (tok.pad_token_id, tok.cls_token_id, tok.sep_token_id, tok.unk_token_id):
            if t is not None:
                seen[t] = True
        kept = np.flatnonzero(seen)
        unk_new = int(np.searchsorted(kept, tok.unk_token_id))
        vocab_map = np.full(model.config.vocab_size, unk_new, dtype=np.int32)
        vocab_map[kept] = np.arange(len(kept), dtype=np.int32)
        emb = model.model.embeddings.tok_embeddings
        new = torch.nn.Embedding(len(kept), emb.embedding_dim)
        new.weight.data = emb.weight.data[torch.from_numpy(kept)].clone()
        model.model.embeddings.tok_embeddings = new
        model.config.vocab_size = len(kept)
        log(f"vocabulary pruned to {len(kept):,} of {len(seen):,} tokens")

        # 2. ONNX export + int8 quantisation
        fp32 = ART / "url_encoder.fp32.onnx"
        ex = tok(["example.com/login"], return_tensors="pt")
        ids = torch.from_numpy(vocab_map[ex["input_ids"].numpy()].astype(np.int64))
        torch.onnx.export(model, (ids, ex["attention_mask"]), str(fp32), input_names=["input_ids", "attention_mask"],
                          output_names=["logits"], dynamic_axes={"input_ids": {0: "b", 1: "t"}, "attention_mask": {0: "b", 1: "t"},
                                                                 "logits": {0: "b"}}, opset_version=17, dynamo=False)
        int8 = ART / "url_encoder.int8.onnx"
        quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)
        fp32.unlink()
        for f in fp32.parent.glob("url_encoder.fp32.onnx*"):
            f.unlink()
        tok.backend_tokenizer.save(str(ART / "url_encoder.tokenizer.json"))
        np.save(ART / "url_encoder.vocab_map.npy", vocab_map)
        log(f"int8 model {int8.stat().st_size / 1e6:.1f} MB")

    # 3. int8 vs original on validation URLs
    ens = EnsembleScorer(stack, ART, ens_meta, threads=8)
    check = va.sample(3000, random_state=0).url.tolist()
    with torch.inference_mode():
        enc = tok([normalize_for_text(u) for u in check], truncation=True, max_length=meta["max_len"], padding=True,
                  return_tensors="pt")
        orig = torch.softmax(AutoModelForSequenceClassification.from_pretrained(OUT_DIR).eval()(**enc).logits, -1)[:, 1].numpy()
    q = ens.encoder_probs(check)
    corr = float(np.corrcoef(orig, q)[0, 1])
    log(f"int8 vs original: corr {corr:.4f}, mean |diff| {np.abs(orig - q).mean():.4f}")

    # 4. calibration + threshold at the stack's validation FPR
    y = va.label.to_numpy()
    t0 = time.time()
    raw_stack = stack.raw_scores(va.url.tolist())
    if torch.cuda.is_available():
        from ml.url.train_gpu import EncoderScorer

        dev = torch.device("cuda", 0)
        gpu = EncoderScorer(AutoModelForSequenceClassification.from_pretrained(OUT_DIR).to(dev).eval(), tok, dev, meta["max_len"])
        p_enc = gpu.score_batch(va.url.tolist())
    else:
        p_enc = EnsembleScorer(stack, ART, ens_meta, threads=8).encoder_probs(va.url.tolist())
    log(f"scored {len(va):,} validation URLs in {time.time() - t0:.0f}s")
    raw = EnsembleScorer.combine_static(W, raw_stack, p_enc)
    cx, cy = fit_isotonic(raw, y)
    p = np.interp(raw, cx, cy)
    stack_fpr = compute_metrics(y, stack.score_batch(va.url.tolist()), stack.threshold)["fpr"]
    thr = threshold_for_fpr(y, p, stack_fpr)
    m = compute_metrics(y, p, thr)
    ens_meta.update(threshold=thr, calib_x=cx.tolist(), calib_y=cy.tolist(), val_fpr_target=stack_fpr,
                    val_metrics={k: m[k] for k in ("precision", "recall", "fpr", "roc_auc", "recall_at_fpr_0.1pct",
                                                    "recall_at_fpr_1pct")},
                    thresholds_by_val_fpr={f"{f:g}": threshold_for_fpr(y, p, f) for f in (0.001, 0.002, 0.005, 0.01, 0.05)},
                    vocab_kept=int(len(kept)), int8_vs_original_corr=corr,
                    calibration_scores="original weights on GPU" if torch.cuda.is_available() else "int8 on CPU")
    (ART / ENSEMBLE_META).write_text(json.dumps(ens_meta, indent=1))
    log(f"ensemble threshold {thr:.4f}: val recall {m['recall']:.4f} at FPR {m['fpr']:.4%} (stack alone {stack_fpr:.4%})")


if __name__ == "__main__":
    main()
