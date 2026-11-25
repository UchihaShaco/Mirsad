"""HTTP service for the fine-tuned page encoder (GPU host; the engine container calls it over HTTP).
Start it from the repository root:

    nohup nice -n 19 .venv-gpu/bin/python -m ml.serve.page_encoder_server \
        > data/page_encoder_server.log 2>&1 &

The engine builds the encoder text itself (`page_features.encoder_input`), so this service only
tokenises and runs the model; it never sees or fetches URLs on its own.

    POST /score   {"texts": ["<encoder input>", ...]}  ->  {"scores": [P(scam), ...], "model": ..., "ms": ...}
    GET  /health  ->  {"ok": true, "model": ..., "device": ..., "threshold": ...}

Requests are pooled for up to BATCH_WINDOW_MS (or MAX_BATCH texts) and run as one bf16 forward
pass. Inputs are capped at MAX_CHARS characters and MAX_TOKENS tokens, MAX_TEXTS texts per request.
Environment: SCAMSHIELD_PAGE_ENCODER_DIR (checkpoint; default: the one named in
ml/artifacts/page_served.json, i.e. the one the served combination was fitted for),
SCAMSHIELD_PAGE_ENCODER_PORT (8003).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

ROOT = Path(__file__).resolve().parents[2]
_SERVED = ROOT / "ml" / "artifacts" / "page_served.json"  # the checkpoint the served combination was fitted for
_DEFAULT_DIR = ROOT / json.loads(_SERVED.read_text())["encoder_checkpoint"] if _SERVED.exists() \
    else ROOT / "ml" / "artifacts" / "page_encoder"
MODEL_DIR = Path(os.environ.get("SCAMSHIELD_PAGE_ENCODER_DIR", _DEFAULT_DIR))
PORT = int(os.environ.get("SCAMSHIELD_PAGE_ENCODER_PORT", "8003"))
MAX_CHARS = 6000
MAX_TOKENS = 512
MAX_TEXTS = 32
MAX_BATCH = 32
BATCH_WINDOW_MS = 8.0

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cuda":
    torch.cuda.set_per_process_memory_fraction(
        min(1.0, 6.0 / (torch.cuda.get_device_properties(0).total_memory / 2**30)))  # ~6 GB is plenty
TOK = AutoTokenizer.from_pretrained(MODEL_DIR)
MODEL = AutoModelForSequenceClassification.from_pretrained(
    MODEL_DIR, dtype=torch.bfloat16 if DEVICE == "cuda" else torch.float32).to(DEVICE).eval()
META = json.loads((MODEL_DIR / "scamshield_meta.json").read_text()) if (MODEL_DIR / "scamshield_meta.json").exists() \
    else {}

app = FastAPI(title="ScamShield page encoder")
_queue: asyncio.Queue | None = None


class ScoreRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_TEXTS)


@torch.inference_mode()
def _forward(texts: list[str]) -> list[float]:
    enc = TOK([t[:MAX_CHARS] for t in texts], truncation=True, max_length=MAX_TOKENS, padding=True,
              return_tensors="pt").to(DEVICE)
    logits = MODEL(**enc).logits.float()
    return torch.softmax(logits, -1)[:, 1].cpu().tolist()


async def _batcher() -> None:
    assert _queue is not None
    loop = asyncio.get_running_loop()
    while True:
        items = [await _queue.get()]
        deadline = loop.time() + BATCH_WINDOW_MS / 1000
        while sum(len(i[0]) for i in items) < MAX_BATCH:
            left = deadline - loop.time()
            if left <= 0:
                break
            try:
                items.append(await asyncio.wait_for(_queue.get(), left))
            except asyncio.TimeoutError:
                break
        texts = [t for i in items for t in i[0]]
        try:
            scores = await asyncio.to_thread(_forward, texts)
        except Exception as exc:  # report to every waiting request
            for _, fut in items:
                if not fut.done():
                    fut.set_exception(exc)
            continue
        k = 0
        for ts, fut in items:
            if not fut.done():
                fut.set_result(scores[k : k + len(ts)])
            k += len(ts)


@app.on_event("startup")
async def _start() -> None:
    global _queue
    _queue = asyncio.Queue()
    asyncio.get_running_loop().create_task(_batcher())
    _forward(["warm-up"])


@app.post("/score")
async def score(req: ScoreRequest) -> dict:
    assert _queue is not None
    t = time.perf_counter()
    fut = asyncio.get_running_loop().create_future()
    await _queue.put((req.texts, fut))
    try:
        scores = await asyncio.wait_for(fut, 10)
    except asyncio.TimeoutError:
        raise HTTPException(503, "encoder busy")
    return {"scores": scores, "model": META.get("name", MODEL_DIR.name), "ms": (time.perf_counter() - t) * 1000}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": META.get("name", MODEL_DIR.name), "dir": str(MODEL_DIR), "device": DEVICE,
            "threshold": META.get("threshold"), "val_pr_auc": META.get("val_pr_auc"), "max_tokens": MAX_TOKENS}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
