"""Assemble a small bootstrap page set from local PhreshPhish shards (read-only) for developing the
feature code and training loop before `ml/data/processed/pages.parquet` exists.

Output: ml/data/bootstrap_pages/pages.parquet with the same columns as the processed set
(url, label, source, brand, lang, html, title, registered_domain, split).

    .venv/bin/python ml/page/build_bootstrap.py --per-shard 2500
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import tldextract

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "ml" / "data" / "raw_pages" / "phreshphish" / "data"
OUT = ROOT / "ml" / "data" / "bootstrap_pages" / "pages.parquet"
MAX_HTML = 400_000

_extract = tldextract.TLDExtract(suffix_list_urls=())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-shard", type=int, default=2500)
    ap.add_argument("--shards", nargs="*", default=["train-005.parquet", "test-020.parquet"])
    args = ap.parse_args()
    frames = []
    for name in args.shards:
        pf = pq.ParquetFile(RAW / name)
        for batch in pf.iter_batches(batch_size=500, columns=["url", "label", "target", "date", "lang", "html"]):
            df = batch.to_pandas()
            df["html"] = df["html"].str.slice(0, MAX_HTML)
            frames.append(df.sample(frac=min(1.0, args.per_shard / pf.metadata.num_rows), random_state=0))
    df = pd.concat(frames, ignore_index=True)
    df["label"] = (df["label"] == "phish").astype(int)
    df["source"] = "phreshphish"
    df["brand"] = df["target"].where(df["label"] == 1, "")
    df["title"] = ""
    df["registered_domain"] = [_extract(u).top_domain_under_public_suffix or "" for u in df["url"]]
    # newest 20% of dates -> test, then domain-grouped 15% of the rest -> val
    cut = df["date"].quantile(0.8)
    df["split"] = "train"
    df.loc[df["date"] >= cut, "split"] = "test"
    test_domains = set(df.loc[df["split"] == "test", "registered_domain"])
    df.loc[(df["split"] == "train") & df["registered_domain"].isin(test_domains), "split"] = "drop"
    df = df[df["split"] != "drop"].copy()
    tr = df["split"] == "train"
    val_domains = pd.Series(df.loc[tr, "registered_domain"].unique()).sample(frac=0.15, random_state=0)
    df.loc[tr & df["registered_domain"].isin(set(val_domains)), "split"] = "val"
    df = df[["url", "label", "source", "brand", "lang", "html", "title", "registered_domain", "split", "date"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    print(df.groupby(["split", "label"]).size())


if __name__ == "__main__":
    main()
