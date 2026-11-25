"""Build the feature cache for the page models.

Rows come from:
  * `ml/data/processed/pages.parquet` (the team's page set; its `split` column is kept as is),
  * extra PhreshPhish rows read straight from the local shards (`ml/data/raw_pages/phreshphish/data`,
    read-only) to give the models more training data and a larger, benign-heavy fresh test set:
      - `extra_train`: collected strictly before the processed test period starts, and whose
        registered domain is not in the processed val / test splits;
      - `fresh_test`: collected on or after that date and whose registered domain never appears in
        any training row;
  * `ml/data/raw_pages/ealvaradob_phishing_dataset/webs.json` (HTML without URLs, an older
    public set) as a second source for cross-source / leave-one-source-out tests.

Every row is turned into features with `scamshield.models.page_features.extract`, the same
function the live engine calls. HTML is processed in chunks of 400 rows on 8 worker processes.

    .venv/bin/python -m ml.page.corpus            # writes ml/page/cache/features.parquet
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from multiprocessing import Pool
from pathlib import Path

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from scamshield.models.page_features import STRUCT_NAMES, extract, split_host

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "ml" / "data" / "processed" / "pages.parquet"
SHARDS = ROOT / "ml" / "data" / "raw_pages" / "phreshphish" / "data"
GULF = ROOT / "ml" / "data" / "raw_pages" / "phreshphish" / "gulf_extract"  # every Arabic + Gulf-brand row
EALVARADOB = ROOT / "ml" / "data" / "raw_pages" / "ealvaradob_phishing_dataset" / "webs.json"
CACHE = ROOT / "ml" / "page" / "cache"
WORKERS = 8
CHUNK = 400
DOC_CHARS = 8000


def _feat(args: tuple[str, str]) -> tuple[str, np.ndarray, str, int, str, list[str]]:
    url, html = args
    f = extract(url, html or "")
    return f.doc[:DOC_CHARS], f.struct, f.lang, f.n_text_chars, f.title[:300], f.brands


def _featurize(pool: Pool, meta: pd.DataFrame, htmls: list[str]) -> pd.DataFrame:
    out = list(pool.imap(_feat, zip(meta["url"].tolist(), htmls), chunksize=8))
    meta = meta.copy()
    meta["doc"] = [o[0] for o in out]
    meta["struct"] = [o[1].tolist() for o in out]
    meta["lang_ours"] = [o[2] for o in out]
    meta["n_text_chars"] = [o[3] for o in out]
    meta["page_title"] = [o[4] for o in out]
    meta["brands_claimed"] = [",".join(o[5]) for o in out]
    meta["html_chars"] = [len(h or "") for h in htmls]
    return meta


def _regdom(url: str) -> str:
    try:
        from urllib.parse import urlsplit

        return split_host((urlsplit(url).hostname or "").lower())[0]
    except ValueError:
        return ""


def build(max_extra_per_shard: int | None, ealvaradob_n: int, train_frac: float, test_frac: float,
          with_extra: bool) -> None:
    CACHE.mkdir(parents=True, exist_ok=True)
    parts: list[pd.DataFrame] = []
    with Pool(WORKERS) as pool:
        # 1. processed set
        pfile = pq.ParquetFile(PROCESSED)
        cols = ["url", "label", "source", "brand", "lang", "html", "first_seen", "registered_domain", "split",
                "source_id", "gulf_relevant", "has_arabic"]
        for batch in pfile.iter_batches(batch_size=CHUNK, columns=cols):
            df = batch.to_pandas()
            htmls = df.pop("html").tolist()
            df["set"] = "processed"
            parts.append(_featurize(pool, df, htmls))
            print("processed", sum(len(p) for p in parts), flush=True)
        proc = pd.concat(parts, ignore_index=True)
        test_start = proc.loc[proc["split"] == "test", "first_seen"].min()
        held_domains = set(proc.loc[proc["split"].isin(["val", "test"]), "registered_domain"])
        train_domains = set(proc.loc[proc["split"] == "train", "registered_domain"])
        seen_ids = set(proc["source_id"])
        print("processed test starts", test_start, flush=True)

        if not with_extra:
            proc["label"] = proc["label"].astype("int8")
            proc.to_parquet(CACHE / "features.parquet", index=False)
            (CACHE / "struct_names.json").write_text(json.dumps(list(STRUCT_NAMES)))
            print(proc.groupby(["source", "split", "label"]).size())
            return
        # 2. extra PhreshPhish rows from local shards
        extra: list[pd.DataFrame] = []
        for shard in sorted(GULF.glob("*.parquet")) + sorted(SHARDS.glob("*.parquet")):
            try:
                pf = pq.ParquetFile(shard)
            except Exception as exc:  # a shard still being downloaded
                print("skip", shard.name, exc, flush=True)
                continue
            n_shard = 0
            for batch in pf.iter_batches(batch_size=CHUNK, columns=["sha256", "url", "label", "target", "date",
                                                                     "lang", "html"]):
                df = batch.to_pandas()
                df = df[~df["sha256"].isin(seen_ids)]
                seen_ids.update(df["sha256"])
                df["registered_domain"] = [_regdom(u) for u in df["url"]]
                df["first_seen"] = pd.to_datetime(df["date"])
                is_new = df["first_seen"] >= test_start
                # deterministic subsample keyed on the sample hash
                u = df["sha256"].str[:8].map(lambda h: int(h, 16) / 2**32)
                frac_tr, frac_te = (1.0, 1.0) if shard.parent == GULF else (train_frac, test_frac)
                keep_train = ~is_new & ~df["registered_domain"].isin(held_domains) & (u < frac_tr)
                keep_test = is_new & (u < frac_te)
                df["split"] = np.where(is_new, "fresh_test", "extra_train")
                df = df[keep_train | keep_test]
                if max_extra_per_shard:
                    df = df.iloc[: max(0, max_extra_per_shard - n_shard)]
                    if df.empty:
                        break
                if df.empty:
                    continue
                n_shard += len(df)
                htmls = df.pop("html").tolist()
                meta = pd.DataFrame({
                    "url": df["url"].values,
                    "label": (df["label"] == "phish").astype("int8").values,
                    "source": "phreshphish",
                    "brand": np.where(df["label"] == "phish", df["target"], None),
                    "lang": df["lang"].values,
                    "first_seen": df["first_seen"].values,
                    "registered_domain": df["registered_domain"].values,
                    "split": df["split"].values,
                    "source_id": df["sha256"].values,
                    "gulf_relevant": False,
                    "has_arabic": False,
                    "set": "phresh_local",
                })
                extra.append(_featurize(pool, meta, htmls))
            print(shard.parent.name, shard.name, n_shard, flush=True)
        ext = pd.concat(extra, ignore_index=True).drop_duplicates("source_id")
        # fresh test rows must be domain-disjoint from every training row
        all_train_domains = train_domains | set(ext.loc[ext["split"] == "extra_train", "registered_domain"])
        ext = ext[(ext["split"] == "extra_train") | ~ext["registered_domain"].isin(all_train_domains)]

        # 3. ealvaradob HTML set (no URLs, older collection)
        ea = json.loads(EALVARADOB.read_text())
        ea = pd.DataFrame(ea)
        ea = ea[ea["text"].str.lstrip().str[:1] == "<"]
        ea = pd.concat([g.sample(n=min(len(g), ealvaradob_n // 2), random_state=0) for _, g in ea.groupby("label")])
        htmls = ea["text"].tolist()
        meta = pd.DataFrame({
            "url": "",
            "label": ea["label"].astype("int8").values,
            "source": "ealvaradob",
            "brand": None,
            "lang": None,
            "first_seen": pd.NaT,
            "registered_domain": "",
            "split": "ealvaradob",
            "source_id": [hashlib.sha256(h.encode("utf-8", "replace")).hexdigest() for h in htmls],
            "gulf_relevant": False,
            "has_arabic": False,
            "set": "ealvaradob",
        })
        eas = [_featurize(pool, meta.iloc[i : i + CHUNK], htmls[i : i + CHUNK]) for i in range(0, len(meta), CHUNK)]
    allf = pd.concat([proc, ext, *eas], ignore_index=True)
    allf["label"] = allf["label"].astype("int8")
    allf.to_parquet(CACHE / "features.parquet", index=False)
    (CACHE / "struct_names.json").write_text(json.dumps(list(STRUCT_NAMES)))
    print(allf.groupby(["set", "split", "label"]).size())


def build_live() -> None:
    """Featurise ml/data/live_legit/pages.parquet into cache/features_live.parquet."""
    live = pd.read_parquet(ROOT / "ml" / "data" / "live_legit" / "pages.parquet")
    meta = pd.DataFrame({
        "url": live["final_url"].values, "label": live["label"].astype("int8").values, "source": live["source"].values,
        "brand": None, "lang": None, "first_seen": pd.NaT, "registered_domain": live["registered_domain"].values,
        "split": live["split"].values, "source_id": live["source_id"].values, "gulf_relevant": False,
        "has_arabic": False, "set": "live_legit"})
    with Pool(WORKERS) as pool:
        out = _featurize(pool, meta, live["html"].tolist())
    out.to_parquet(CACHE / "features_live.parquet", index=False)
    print(out.groupby(["split", "source"]).size())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-extra-per-shard", type=int, default=None)
    ap.add_argument("--ealvaradob-n", type=int, default=4000)
    ap.add_argument("--train-frac", type=float, default=0.35, help="share of older shard rows kept for training")
    ap.add_argument("--test-frac", type=float, default=0.6, help="share of newer shard rows kept for fresh_test")
    ap.add_argument("--with-extra", action="store_true",
                    help="also add local-shard PhreshPhish rows and ealvaradob (needed only while the processed set "
                         "was small; the final processed set already contains them)")
    ap.add_argument("--live", action="store_true", help="only featurise the live legitimate set")
    a = ap.parse_args()
    if a.live:
        build_live()
        raise SystemExit
    build(a.max_extra_per_shard, a.ealvaradob_n, a.train_frac, a.test_frac, a.with_extra)
