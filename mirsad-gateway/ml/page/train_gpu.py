"""GPU fine-tuning of a multilingual encoder as the page classifier.  NOT RUN YET - needs the GPU.

Model: `Alibaba-NLP/gte-multilingual-base` (305M params, Apache-2.0, 70+ languages incl. Arabic,
8k context; custom architecture, so `trust_remote_code=True`). This mirrors the strongest
published PhreshPhish baseline (fine-tuned GTE on URL + HTML) and adds Arabic coverage.

Input per page (built from the same `page_features.extract` output the CPU models use, so the
serving path needs nothing new):

    <url> [SEP] <title> [SEP] form: <what the forms ask for>, action <host|external|php> ;
    signals: <brand mismatches, cloaking, scrambling> [SEP] <visible text ...>

Data: the feature cache written by `ml/page/corpus.py` (same train / val / test roles as
`ml/page/train.py`, domain-disjoint, newest pages in test). Writes
`ml/artifacts/page_encoder/` (HF format) and test scores for `ml/page/evaluate.py`
(`ml/page/cache/hf_scores__page_gte_ft.parquet`), which writes `ml/results/page_gte_ft__<dataset>.json`.

One command (from the repo root, after the team lead frees the GPU):

    CUDA_VISIBLE_DEVICES=0 .venv/bin/python -m ml.page.train_gpu --epochs 2

Requires a CUDA build of torch in the venv (the venv currently has torch CPU; install
`torch` from the CUDA index first, e.g. `uv pip install --python .venv/bin/python torch
--index-url https://download.pytorch.org/whl/cu128`).

Expected cost (estimates, ~60k training pages, 512 tokens, bf16, batch 32):
  * memory ~14-18 GB of GPU RAM (gradient checkpointing off); fits any 24 GB+ card,
  * ~6-8 min per epoch on an H100 / ~15-20 min on an A100-40G / ~35 min on an RTX 4090,
  * total with 2 epochs + evaluation: ~15-45 min.
Inference afterwards: ~5-8 ms per page on GPU, ~150-250 ms on one CPU core (too slow for the
live CPU path; use it on the GPU host or as a feature in the async deep layer).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

from ml.bench.metrics import compute_metrics, threshold_for_fpr
from ml.page.train import assign_roles, load_cache
from scamshield.models.page_features import encoder_input

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml" / "artifacts" / "page_encoder"
MODEL_ID = "Alibaba-NLP/gte-multilingual-base"
def build_frame(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["text"] = [encoder_input(u, t or "", d, np.asarray(s, dtype=np.float32))
                  for u, t, d, s in zip(df["url"], df["page_title"], df["doc"], df["struct"])]
    return df[["text", "label", "split", "source_id"]]


ARABIC_TEXT = ROOT / "ml" / "data" / "processed" / "arabic_scam_text.parquet"
# real (not machine-translated) Arabic text kinds; page text is excluded so no test page leaks in
AUX_KINDS = {"call_transcript": None, "email_bilingual_ar_side": None, "sms_smishing_survey": None,
             "sms_spam_saudi_real": None, "tweet_spam": 3000, "sms_phishing_gulf_templated": 2000}


def arabic_aux() -> pd.DataFrame:
    """Auxiliary Arabic scam / legit messages so the encoder sees Arabic lure wording (training only)."""
    a = pd.read_parquet(ARABIC_TEXT)
    a["k"] = a["kind"].str.split(":").str[0]
    parts = []
    for k, cap in AUX_KINDS.items():
        g = a[a["k"] == k]
        parts.append(g.sample(n=min(len(g), cap), random_state=0) if cap else g)
    a = pd.concat(parts)
    return pd.DataFrame({"text": [f" [SEP]  [SEP] form asks: nothing; signals: none [SEP] {t}" for t in a["text"]],
                         "label": a["label"].astype(int).values, "split": "aux_arabic",
                         "source_id": "aux"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=MODEL_ID)
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--max-train", type=int, default=0, help="subsample training rows (0 = all)")
    ap.add_argument("--no-arabic-aux", action="store_true", help="do not add the auxiliary Arabic messages")
    ap.add_argument("--gpu-mem-gb", type=float, default=40.0, help="cap on this process's GPU memory")
    ap.add_argument("--out", type=Path, default=None, help="where the best checkpoint is written / read")
    ap.add_argument("--name", default="page_gte_ft", help="model name in the score / result files")
    ap.add_argument("--patience", type=int, default=2, help="half-epoch evaluations without improvement")
    ap.add_argument("--predict-only", action="store_true", help="score val / test sets with --out, no training")
    ap.add_argument("--live-repeat", type=int, default=4,
                    help="repeat the engine-fetched live legitimate training pages (hard negatives) this many times")
    args = ap.parse_args()

    import torch
    from torch.utils.data import DataLoader
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

    assert torch.cuda.is_available(), "this script is for the GPU host"
    total = torch.cuda.get_device_properties(0).total_memory / 2**30
    torch.cuda.set_per_process_memory_fraction(min(1.0, args.gpu_mem_gb / total))
    torch.manual_seed(0)
    df = load_cache()
    role = assign_roles(df)
    data = build_frame(df)
    tr, va = data[role == "train"], data[role == "val"]
    if args.max_train and len(tr) > args.max_train:
        tr = tr.sample(n=args.max_train, random_state=0)
    if not args.no_arabic_aux:
        tr = pd.concat([tr, arabic_aux()], ignore_index=True)
    live = tr[tr["split"] == "live_train"]
    if len(live) and args.live_repeat > 1:
        tr = pd.concat([tr] + [live] * (args.live_repeat - 1), ignore_index=True)
    print(f"train {len(tr)} rows ({len(live)} live legitimate x{args.live_repeat}), val {len(va)}", flush=True)
    from ml.page.evaluate import synthetic_frame

    tests = {"pages_test": data[df["split"] == "test"], "synthetic_uae": build_frame(synthetic_frame()),
             "live_legit_test": data[df["split"] == "live_test"]}
    out_dir = args.out or OUT

    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    # fp32 master weights (the checkpoint is stored in fp16), bf16 autocast for speed
    model = AutoModelForSequenceClassification.from_pretrained(
        out_dir if args.predict_only else args.model, num_labels=2, trust_remote_code=True,
        ignore_mismatched_sizes=True, dtype=torch.float32).cuda()

    def collate(batch):
        enc = tok([b[0] for b in batch], truncation=True, max_length=args.max_len, padding=True, return_tensors="pt")
        enc["labels"] = torch.tensor([b[1] for b in batch])
        return enc

    def loader(frame, shuffle):
        return DataLoader(list(zip(frame["text"], frame["label"].astype(int))), batch_size=args.batch,
                          shuffle=shuffle, collate_fn=collate, num_workers=2)

    @torch.inference_mode()
    def predict(frame) -> np.ndarray:
        model.eval()
        out = []
        for b in loader(frame, False):
            b.pop("labels")
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = model(**{k: v.cuda() for k, v in b.items()}).logits.float()
            out.append(torch.softmax(logits, -1)[:, 1].cpu().numpy())
        model.train()
        return np.concatenate(out)

    dl = loader(tr, True)
    steps = int(math.ceil(len(dl) * args.epochs))
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    pos_w = float((tr["label"] == 0).sum() / max(1, (tr["label"] == 1).sum()))
    loss_fn = torch.nn.CrossEntropyLoss(weight=torch.tensor([1.0, pos_w], device="cuda"))
    model.train()
    step, t0, best_ap, stale = 0, time.time(), -1.0, 0
    from sklearn.metrics import average_precision_score

    if args.predict_only:
        steps = 0
    while step < steps and stale < args.patience:
        for b in dl:
            labels = b.pop("labels").cuda()
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = model(**{k: v.cuda() for k, v in b.items()}).logits.float()
            loss = loss_fn(logits, labels)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            step += 1
            if step % 100 == 0:
                print(f"step {step}/{steps} loss {loss.item():.4f} {time.time() - t0:.0f}s", flush=True)
            if step % max(1, len(dl) // 2) == 0 or step == steps:
                ap_ = average_precision_score(va["label"], predict(va))
                print(f"step {step} val PR-AUC {ap_:.4f}", flush=True)
                if ap_ > best_ap:
                    best_ap, stale = ap_, 0
                    out_dir.mkdir(parents=True, exist_ok=True)
                    model.save_pretrained(out_dir)
                    tok.save_pretrained(out_dir)
                else:
                    stale += 1
                    if stale >= args.patience:
                        print("early stop", flush=True)
                        break
            if step >= steps:
                break

    model = AutoModelForSequenceClassification.from_pretrained(out_dir, trust_remote_code=True,
                                                               dtype=torch.float32).cuda()
    p_va = predict(va)
    from sklearn.metrics import average_precision_score as _ap

    best_ap = best_ap if best_ap >= 0 else float(_ap(va["label"], p_va))
    # validation legitimate pages include the engine-fetched live ones
    thr = threshold_for_fpr(va["label"].to_numpy(), p_va, 0.005)
    # per-page latency on the GPU, one page at a time
    lat = []
    sample = tests["pages_test"]["text"].sample(n=200, random_state=0).tolist()
    for txt in sample:
        torch.cuda.synchronize()
        t = time.perf_counter()
        predict(pd.DataFrame({"text": [txt], "label": [0]}))
        torch.cuda.synchronize()
        lat.append((time.perf_counter() - t) * 1000)
    scores = []
    for name, frame in tests.items():
        p = predict(frame)
        scores.append(pd.DataFrame({"source_id": frame["source_id"].values, "score": p}))
        m = compute_metrics(frame["label"], p, thr, model=args.name, dataset=name, latencies_ms=lat)
        print(name, {k: m[k] for k in ("precision", "recall", "f1", "fpr", "roc_auc", "pr_auc")}, flush=True)
    # scores + meta in the format ml/page/evaluate.py merges (slices, 1% base rate, confusion plots)
    cache = ROOT / "ml" / "page" / "cache"
    pd.concat(scores).to_parquet(cache / f"hf_scores__{args.name}.parquet", index=False)
    pd.DataFrame({"source_id": va["source_id"].values, "label": va["label"].values, "score": p_va}).to_parquet(
        cache / f"val_scores__{args.name}.parquet", index=False)  # for fitting the served combination
    (cache / f"hf_meta__{args.name}.json").write_text(json.dumps({
        "model_id": f"{args.model} fine-tuned", "input": "url+title+form summary+text", "threshold": thr,
        "max_tokens": args.max_len, "latencies_ms": lat, "latency_note": "GPU (bf16), batch 1, 200 pages",
        "val_pr_auc": best_ap, "checkpoint": str(out_dir)}, indent=2))
    (out_dir / "scamshield_meta.json").write_text(json.dumps({"base": args.model, "threshold": thr,
                                                          "val_pr_auc": best_ap, "max_len": args.max_len}))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
