"""Per-page latency and path of `scamshield.models.page_model.score_page`, one page at a time.

Runs anywhere `scamshield` imports, including inside the engine container (stdin, no ml/ mount):

    docker compose exec -T -e SCAMSHIELD_PAGE_ENCODER_URL=http://host.docker.internal:8003 engine \
        python - --pages /tmp/pages.jsonl --out /tmp/lat.json < ml/page/served_latency.py

`--pages` is a JSON-lines file of {"url", "html"} (see `--export` to write one from pages_test and
the live legitimate snapshots). Output: per-page ms / score / path and p50 / p95 per path.
"""

from __future__ import annotations

import argparse
import json
import time


def export(out: str, n: int) -> None:
    import pyarrow.parquet as pq

    t = pq.read_table("ml/data/processed/pages.parquet", columns=["url", "html", "split"],
                      filters=[("split", "==", "test")]).to_pandas().sample(n=n, random_state=1)
    with open(out, "w") as f:
        for u, h in zip(t["url"], t["html"]):
            f.write(json.dumps({"url": u, "html": h or "", "set": "pages_test"}) + "\n")
        for line in open("ml/page/cache/live_legit_snapshots.jsonl"):
            if line.strip():
                s = json.loads(line)
                f.write(json.dumps({"url": s["final_url"], "html": s["html"], "set": "live_legit20"}) + "\n")


def run(pages: str, out: str, pause_ms: float) -> None:
    from scamshield.models import page_model
    from scamshield.schemas import PageSnapshot

    rows = [json.loads(x) for x in open(pages) if x.strip()]
    page_model.score_page(PageSnapshot(url=rows[0]["url"], final_url=rows[0]["url"], html=rows[0]["html"]))
    res = []
    for r in rows:
        p = PageSnapshot(url=r["url"], final_url=r["url"], html=r["html"])
        t = time.perf_counter()
        try:
            s, err = page_model.score_page(p), None
        except Exception as exc:  # must never happen: score_page swallows everything
            s, err = None, repr(exc)
        ms = (time.perf_counter() - t) * 1000
        res.append({"url": r["url"][:120], "set": r.get("set"), "score": s, "ms": ms,
                    "path": page_model.info()["gpu_tier"]["last_path"], "error": err})
        if pause_ms:
            time.sleep(pause_ms / 1000)
    summary: dict = {}
    for path in sorted({x["path"] for x in res if x["path"]}):
        ms = sorted(x["ms"] for x in res if x["path"] == path)
        summary[path] = {"n": len(ms), "p50": ms[len(ms) // 2], "p95": ms[min(len(ms) - 1, int(0.95 * len(ms)))]}
    allms = sorted(x["ms"] for x in res)
    summary["all"] = {"n": len(allms), "p50": allms[len(allms) // 2], "p95": allms[int(0.95 * (len(allms) - 1))]}
    summary["errors"] = sum(1 for x in res if x["error"])
    json.dump({"summary": summary, "info": page_model.info()["gpu_tier"], "rows": res}, open(out, "w"), indent=1,
              default=str)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="/tmp/pages.jsonl")
    ap.add_argument("--out", default="/tmp/served_latency.json")
    ap.add_argument("--export", type=int, default=0, help="write N pages_test pages + live snapshots to --pages")
    ap.add_argument("--pause-ms", type=float, default=0.0)
    a = ap.parse_args()
    if a.export:
        export(a.pages, a.export)
    else:
        run(a.pages, a.out, a.pause_ms)
