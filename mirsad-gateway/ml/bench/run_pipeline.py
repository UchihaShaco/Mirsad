"""Score the whole engine on a labelled URL file, in the shared result shape.

Two modes:
  --inprocess   (recommended) builds its own Engine in this process with its own SQLite DB, so the
                shared container's cache and verdict history are not used and not polluted.
  default       POSTs CSV chunks to an engine's /v1/batch (`--engine`, default config.ENGINE_URL).

    # engine on its own (public blocklists off), few hundred of each label, concurrency 8
    .venv/bin/python -m ml.bench.run_pipeline ml/data/processed/urls_fresh_test.parquet --inprocess \\
        --no-blocklists --per-label 300 --depth page --i-understand-fetching
    # same with reputation pre-fill (blocklists on) for the separate row
    .venv/bin/python -m ml.bench.run_pipeline ml/data/processed/urls_fresh_test.parquet --inprocess \\
        --per-label 300 --depth page --i-understand-fetching

`risk_score / 100` is the score. Two results per run: flagged = warn or block, and flagged = block.
Model name: pipeline_<depth>_<engine-alone | with-reputation>@<warn|block>. In-process runs also record
how many pages were retrievable (fetched with HTTP status < 400 and some HTML) and the recall on
those, because many feed URLs are already dead. Unanswered rows count as "not flagged".

Depth `url` never loads the URL. Depth `page` / `deep` makes the engine fetch every URL in the file;
the benchmark files contain live malicious URLs, so that needs --i-understand-fetching and should run
only where the engine's fetcher is sandboxed.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def post_batch(client, base: str, urls: list[str], depth: str, concurrency: int) -> list[dict]:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["url"])
    w.writerows([u] for u in urls)
    r = client.post(f"{base}/v1/batch", params={"depth": depth, "concurrency": concurrency},
                    content=buf.getvalue().encode(), headers={"content-type": "text/csv"})
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text)))


def via_http(urls: list[str], a) -> list[dict]:
    import httpx

    by_url: dict[str, dict] = {}
    t0 = time.time()
    with httpx.Client(timeout=a.timeout) as client:
        client.get(f"{a.engine}/v1/health").raise_for_status()
        for i in range(0, len(urls), a.chunk):
            for row in post_batch(client, a.engine, urls[i : i + a.chunk], a.depth, a.concurrency):
                by_url[row["url"]] = row
            print(f"{min(i + a.chunk, len(urls))}/{len(urls)} scored ({time.time() - t0:.0f}s)", flush=True)
    out = []
    for u in urls:
        r = by_url.get(u.strip(), {})
        out.append({"risk": float(r["risk_score"]) if r.get("risk_score") not in (None, "") else None,
                    "elapsed_ms": float(r["elapsed_ms"]) if r.get("elapsed_ms") not in (None, "") else None,
                    "retrievable": None})
    return out


async def in_process(urls: list[str], a) -> list[dict]:
    from scamshield.engine.pipeline import Engine

    engine = await Engine(review_enabled=False).start()
    await engine.warm_up()
    gate = asyncio.Semaphore(a.concurrency)
    done = 0

    async def one(url: str) -> dict:
        nonlocal done
        async with gate:
            t0 = time.perf_counter()
            try:
                v = await asyncio.wait_for(engine.investigate(url, a.depth, background=False), a.timeout)
                page = v.page
                retrievable = bool(page and not page.error and page.status is not None and page.status < 400 and page.html)
                row = {"risk": v.risk_score, "decision": v.decision.value, "retrievable": retrievable,
                       "elapsed_ms": (time.perf_counter() - t0) * 1000, "timings_ms": v.timings_ms}
            except Exception as exc:
                row = {"risk": None, "retrievable": False, "elapsed_ms": (time.perf_counter() - t0) * 1000,
                       "error": f"{type(exc).__name__}: {exc}"[:200]}
            done += 1
            if done % 50 == 0:
                print(f"{done}/{len(urls)} scored", flush=True)
            return row

    try:
        return await asyncio.gather(*(one(u) for u in urls))
    finally:
        await engine.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("datasets", nargs="+", help="parquet/csv files with url,label (optionally path:split); rows are pooled")
    ap.add_argument("--name", help="dataset name in the result (default: stem of the first file)")
    ap.add_argument("--inprocess", action="store_true")
    ap.add_argument("--no-blocklists", action="store_true", help="engine alone: public blocklists off (SCAMSHIELD_BLOCKLISTS=0)")
    ap.add_argument("--engine", default=None, help="engine URL for HTTP mode (default config.ENGINE_URL)")
    ap.add_argument("--depth", default="url", choices=["reputation", "url", "page", "deep"])
    ap.add_argument("--half", choices=["odd", "even", "all"], default="odd",
                    help="md5(url) % 2 half to use: odd = reserved for reporting (default), even = used for tuning rules")
    ap.add_argument("--only-label", type=int, choices=[0, 1], help="keep only rows with this label (0 = legitimate)")
    ap.add_argument("--per-label", type=int, help="random sample of this many rows per label")
    ap.add_argument("--chunk", type=int, default=200, help="URLs per /v1/batch request (HTTP mode)")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--timeout", type=float, default=900.0, help="seconds per batch request / per URL in-process")
    ap.add_argument("--i-understand-fetching", action="store_true")
    a = ap.parse_args()
    if a.depth in ("page", "deep") and not a.i_understand_fetching:
        sys.exit("depth page/deep fetches every URL in the file (live malicious URLs); pass --i-understand-fetching")
    # settings are read at import time, so set them before importing scamshield
    if a.no_blocklists:
        os.environ["SCAMSHIELD_BLOCKLISTS"] = "0"
    if a.inprocess:
        os.environ.setdefault("SCAMSHIELD_DB", str(ROOT / "data" / f"bench_engine_{int(time.time())}.db"))

    import pandas as pd

    from ml.bench.metrics import compute_metrics
    from ml.bench.runner import load_dataset, write_result
    from scamshield import config

    frames = [load_dataset(d)[1] for d in a.datasets]
    df = pd.concat([f[["url", "label"]] for f in frames], ignore_index=True)
    name = a.name or load_dataset(a.datasets[0])[0]
    if a.half != "all":
        import hashlib

        parity = 1 if a.half == "odd" else 0
        df = df[[int(hashlib.md5(u.encode()).hexdigest(), 16) % 2 == parity for u in df.url.astype(str)]].reset_index(drop=True)
    if a.only_label is not None:
        df = df[df.label == a.only_label].reset_index(drop=True)
    if a.per_label:
        df = pd.concat([g.sample(min(len(g), a.per_label), random_state=0) for _, g in df.groupby("label")],
                       ignore_index=True)
    urls = df.url.astype(str).tolist()
    a.engine = a.engine or config.ENGINE_URL
    rows = asyncio.run(in_process(urls, a)) if a.inprocess else via_http(urls, a)

    risk = np.array([r["risk"] / 100 if r.get("risk") is not None else np.nan for r in rows])
    lat = [r["elapsed_ms"] for r in rows if r.get("elapsed_ms") is not None]
    y = df.label.to_numpy()
    mode = "engine-alone" if a.no_blocklists else "with-reputation"
    note = (f"full engine, depth={a.depth}, {'in-process' if a.inprocess else 'POST /v1/batch'}, concurrency {a.concurrency}, "
            f"public blocklists {'OFF' if a.no_blocklists else 'ON (reputation pre-fill)'}; latency = per-URL wall time"
            + (f"; {a.half}-md5 half of the rows" if a.half != "all" else "")
            + (f"; {a.per_label} rows per label" if a.per_label else ""))
    retr = np.array([bool(r.get("retrievable")) for r in rows])
    for label, thr in (("warn", config.WARN_THRESHOLD / 100), ("block", config.BLOCK_THRESHOLD / 100)):
        res = compute_metrics(y, risk, thr, model=f"pipeline_{a.depth}_{mode}@{label}", dataset=name, latencies_ms=lat)
        res["no_answer"] = int(np.isnan(risk).sum())
        res["note"] = note
        if a.inprocess:
            flagged = np.nan_to_num(risk, nan=-1) >= thr
            res["retrievable_scam"] = int((retr & (y == 1)).sum())
            res["retrievable_legit"] = int((retr & (y == 0)).sum())
            res["recall_on_retrievable"] = (float((flagged & retr & (y == 1)).sum() / max(1, (retr & (y == 1)).sum()))
                                            if (retr & (y == 1)).any() else None)
        write_result(res)
        print(json.dumps({k: res.get(k) for k in ("model", "dataset", "n", "precision", "recall", "fpr", "no_answer",
                                                     "retrievable_scam", "recall_on_retrievable", "latency_ms_p50")}))
        if a.inprocess:  # the same run split into pages that could be fetched and pages that could not
            for part, mask in (("retrievable", retr), ("unreachable", ~retr)):
                if not mask.any():
                    continue
                sub = compute_metrics(y[mask], risk[mask], thr, model=res["model"], dataset=f"{name}_{part}",
                                      latencies_ms=[r["elapsed_ms"] for r, m in zip(rows, mask)
                                                    if m and r.get("elapsed_ms") is not None])
                sub["no_answer"] = int(np.isnan(risk[mask]).sum())
                sub["note"] = note + f"; only the {part} pages of this run"
                write_result(sub)


if __name__ == "__main__":
    main()
