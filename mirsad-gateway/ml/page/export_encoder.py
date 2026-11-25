"""Measure the fine-tuned page encoder's (ml/artifacts/page_encoder) per-page latency, one page at a
time, on one CPU thread and on the GPU, and its scores on the live legitimate-site snapshots
(ml/page/cache/live_legit_snapshots.jsonl). `--onnx` also exports ONNX. Run from .venv-gpu:

    PYTHONPATH=src:. .venv-gpu/bin/python -m ml.page.export_encoder
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from ml.page.train_gpu import OUT
from scamshield.models.page_features import encoder_input
from scamshield.models.page_features import extract_snapshot
from scamshield.schemas import PageSnapshot

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "ml" / "page" / "cache"
ONNX = OUT / "model.onnx"
MAXLEN = 512


def main() -> None:
    tok = AutoTokenizer.from_pretrained(OUT)
    model = AutoModelForSequenceClassification.from_pretrained(OUT, dtype=torch.float32).eval()
    meta = json.loads((OUT / "scamshield_meta.json").read_text())
    feats = pd.read_parquet(CACHE / "features.parquet", columns=["url", "page_title", "doc", "struct", "split"])
    sample = feats[feats["split"] == "test"].sample(n=50, random_state=0)
    texts = [encoder_input(u, t or "", d, np.asarray(s, dtype=np.float32))
             for u, t, d, s in zip(sample["url"], sample["page_title"], sample["doc"], sample["struct"])]

    out: dict = {}
    if "--onnx" in sys.argv:  # the ONNX export works, but onnxruntime crashed (SIGSEGV) loading it here
        enc = tok(texts[:1], truncation=True, max_length=MAXLEN, return_tensors="pt")
        torch.onnx.export(model, (enc["input_ids"], enc["attention_mask"]), str(ONNX),
                          input_names=["input_ids", "attention_mask"], output_names=["logits"],
                          dynamic_axes={"input_ids": {0: "b", 1: "t"}, "attention_mask": {0: "b", 1: "t"}},
                          opset_version=17, dynamo=False)
        out["onnx_path"], out["onnx_mb"] = str(ONNX), ONNX.stat().st_size / 1e6
    # one CPU thread, one page at a time (PyTorch fp32)
    torch.set_num_threads(1)
    lat_cpu = []
    with torch.inference_mode():
        for txt in texts[:10]:
            t = time.perf_counter()
            model(**tok([txt], truncation=True, max_length=MAXLEN, return_tensors="pt"))
            lat_cpu.append((time.perf_counter() - t) * 1000)
    out["cpu_1thread_torch_fp32_ms"] = {"p50": float(np.percentile(lat_cpu, 50)),
                                        "p95": float(np.percentile(lat_cpu, 95))}
    model_gpu = model.cuda()
    lat = []
    with torch.inference_mode():
        for txt in texts:
            torch.cuda.synchronize()
            t = time.perf_counter()
            e = tok([txt], truncation=True, max_length=MAXLEN, return_tensors="pt").to("cuda")
            with torch.autocast("cuda", dtype=torch.bfloat16):
                model_gpu(**e)
            torch.cuda.synchronize()
            lat.append((time.perf_counter() - t) * 1000)
    out["gpu_torch_bf16_ms"] = {"p50": float(np.percentile(lat[5:], 50)), "p95": float(np.percentile(lat[5:], 95))}

    live = []
    snaps = [PageSnapshot.model_validate_json(x) for x in (CACHE / "live_legit_snapshots.jsonl").read_text().splitlines()
             if x.strip()]
    with torch.inference_mode():
        for s in snaps:
            f = extract_snapshot(s)
            if f is None:
                continue
            e = tok([encoder_input(s.final_url, f.title, f.doc, f.struct)], truncation=True, max_length=MAXLEN,
                    return_tensors="pt").to("cuda")
            p = float(torch.softmax(model_gpu(**e).logits.float(), -1)[0, 1])
            live.append({"url": s.final_url, "score": round(p, 3)})
    out["threshold"] = meta["threshold"]
    out["live_legit"] = live
    (CACHE / "encoder_serving.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
