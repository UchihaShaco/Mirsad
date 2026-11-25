"""Scores of our two page models on the comparison rows, so they sit beside the SOTA methods.

  page_combo   served CPU model (src/scamshield/models/page_model.py, encoder service off), scored here
               one page at a time on one thread, end to end (HTML parse + features + model).
  page_gte_ft  our fine-tuned gte-multilingual-base; per-row test scores come from the page benchmark's
               cache (ml/page/cache/hf_scores__page_gte_ft.parquet), which covers every test-split row.

Rows: PhreshPhish official-test rows that are also in our test split (pp_test) plus every Arabic test
page. Screenshot rows (TR-OP, Phishpedia 30k) are in our TRAIN split, so per-row scores there would be
in-sample; for TR-OP the report uses the leave-one-source-out result instead (ml/page/cache/loso.json).

    OMP_NUM_THREADS=1 nice -n 19 .venv/bin/python -m ml.sota.page.ours
"""

from __future__ import annotations

import os
import time

os.environ.pop("SCAMSHIELD_PAGE_ENCODER_URL", None)
os.environ.setdefault("OMP_NUM_THREADS", "1")

import pandas as pd

from ml.sota.page.common import CACHE, ROOT, load_html, meta, row_set
from scamshield.models import page_model
from scamshield.schemas import PageSnapshot


def main() -> None:
    df = meta()
    rows = pd.concat([row_set(df, "pp_test"), row_set(df, "arabic_test")]).drop_duplicates("source_id")
    html = load_html(set(rows["source_id"]))
    page_model.score_page(PageSnapshot(url="https://example.com/", final_url="https://example.com/", html="<p>x</p>"))
    out = []
    for sid, url in zip(rows["source_id"], rows["url"]):
        t0 = time.perf_counter()
        s = page_model.score_page(PageSnapshot(url=url or "", final_url=url or "", html=html.get(sid, "")))
        out.append({"source_id": sid, "page_combo": float("nan") if s is None else s,
                    "page_combo_ms": (time.perf_counter() - t0) * 1000})
    res = pd.DataFrame(out)
    gte = pd.read_parquet(ROOT / "ml" / "page" / "cache" / "hf_scores__page_gte_ft.parquet")
    res = res.merge(gte.rename(columns={"score": "page_gte_ft"}), on="source_id", how="left")
    res.to_parquet(CACHE / "ours__pp_test.parquet")
    print(res.describe())


if __name__ == "__main__":
    main()
