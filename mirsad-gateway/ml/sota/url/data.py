"""Freeze the rows every recreated URL method is trained and scored on (run once, ~5 min, < 6 GB RAM).

Training rows are exactly the sample our own URL models use (`ml.url.train` defaults, recorded in
protocol.json: at most 100k rows per (source, label), 250k for PhreshPhish, plus the v3 legitimate-shortener
rows, de-duplicated after normalisation), so "ours" and every recreation see the same URLs.
Files go to $SCAMSHIELD_SOTA_WORK (default: data/sota/url/ in the repo, git-ignored). Every model input is
`normalize_for_text(url)`: scheme and leading `www.` removed for every row, because 38% of the rows had
`http://` imputed by us and the scheme would otherwise tell a model which feed a row came from.

Evaluation sets are the same slices as `ml.bench.datasets.standard_datasets()`, rebuilt from only the
columns we need so the job stays inside its memory budget.

    nice -n 19 ionice -c 3 env PYTHONPATH=src:. .venv-gpu/bin/python -m ml.sota.url.data
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pandas as pd

from ml.bench.datasets import HF_TRAINED_SOURCES, PROCESSED, _has_path, _is_shortener
from ml.url.train import cap_per_source, domain_halves, load_training_frame, log
from scamshield.models.url_features import normalize_for_text

ROOT = Path(__file__).resolve().parents[3]
PROTOCOL = json.loads((Path(__file__).with_name("protocol.json")).read_text())
# Large intermediate files; defaults to the git-ignored data/ directory of the repo.
WORK = Path(os.environ.get("SCAMSHIELD_SOTA_WORK", ROOT / "data" / "sota" / "url"))
EVAL_DIR = WORK / "eval"
COLS = ["url", "label", "source", "registered_domain", "split", "domain_only", "has_path"]


def _norm(df: pd.DataFrame) -> pd.DataFrame:
    df = df.reset_index(drop=True)
    df["norm"] = [normalize_for_text(u) for u in df.url.astype(str)]
    return df


def eval_sets() -> dict[str, pd.DataFrame]:
    test = pd.read_parquet(PROCESSED / "urls.parquet", columns=COLS, filters=[("split", "==", "test")])
    test = test.reset_index(drop=True)
    short = _is_shortener(test)
    out = {"urls_test": test,
           "urls_test_nohf": test[~test.source.isin(HF_TRAINED_SOURCES)],
           "urls_test_noshort": test[~short]}
    add = pd.read_parquet(PROCESSED / "urls_additions_v3.parquet", columns=COLS)
    out["urls_test_shorteners"] = pd.concat([test[short], add[add.split == "test"]], ignore_index=True)
    hp = _has_path(test)
    out["urls_test_deeplegit_vs_barephish"] = test[((test.label == 0) & hp) | ((test.label == 1) & ~hp)]
    fresh = pd.read_parquet(PROCESSED / "urls_fresh_test.parquet", columns=COLS)
    out["urls_fresh_test"] = fresh
    out["urls_fresh_test_fullurl"] = fresh[~fresh.domain_only.astype(bool)]
    out["urls_fresh_test_domainonly"] = fresh[fresh.domain_only.astype(bool)]
    uae = pd.read_parquet(PROCESSED / "uae_legit_v3.parquet", columns=["url", "in_v2"]).assign(label=0)
    out["uae_legit"] = uae[uae.in_v2.astype(bool)]
    out["uae_legit_v3_new"] = uae[~uae.in_v2.astype(bool)]
    return {k: _norm(v[["url", "label"]]) for k, v in out.items()}


def main() -> None:
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    for name, d in eval_sets().items():
        d.to_parquet(EVAL_DIR / f"{name}.parquet")
        log(f"{name}: {len(d):,} rows, {int(d.label.sum()):,} scam")

    df = load_training_frame(PROCESSED / "urls.parquet")
    p = PROTOCOL
    tr = cap_per_source(df[df.split == "train"], p["train_cap_per_source_label"], p["train_cap_overrides"], p["sample_seed"])
    va = cap_per_source(df[df.split == "val"], p["val_cap_per_source_label"], p["val_cap_overrides"], p["sample_seed"])
    del df
    tr = _norm(tr).drop_duplicates("norm")
    tr[["norm", "label"]].reset_index(drop=True).to_parquet(WORK / "train.parquet")
    va = _norm(va)
    va["calibration"] = ~domain_halves(va.registered_domain)  # same threshold half as ours
    va[["url", "norm", "label", "calibration"]].to_parquet(WORK / "val.parquet")
    meta = {"train_rows": len(tr), "train_pos": float(tr.label.mean()), "val_rows": len(va)}
    (WORK / "data_meta.json").write_text(json.dumps(meta, indent=2))
    log(json.dumps(meta))


if __name__ == "__main__":
    main()
