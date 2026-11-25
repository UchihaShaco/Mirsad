"""The benchmark datasets every URL system is scored on, built from ml/data/processed/ (v2, frozen,
plus the v3 add-ons)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
PROCESSED = ROOT / "ml" / "data" / "processed"

# Sources that public HF baselines were trained on (their test rows may be in those models' training
# data, which inflates the baselines there). `urls_test_nohf` drops them.
HF_TRAINED_SOURCES = ("hf_ealvaradob_urls", "hf_kmack_phishing_urls", "hf_pirocheto_phishing_url",
                      "hf_malicious_phish_kaggle_mirror", "hf_mitake_phishbenign")


def _has_path(df: pd.DataFrame) -> pd.Series:
    if "has_path" in df.columns:
        return df["has_path"].astype(bool)
    from scamshield.models.url_features import parse_url

    return pd.Series([parse_url(u).path not in ("", "/") or bool(parse_url(u).query) for u in df.url], index=df.index)


def _is_shortener(df: pd.DataFrame) -> pd.Series:
    from scamshield.models.url_features import SHORTENERS, parse_url

    def short(u: str) -> bool:
        p = parse_url(u)
        h = p.host[4:] if p.host.startswith("www.") else p.host
        return h in SHORTENERS or p.registered_domain in SHORTENERS

    return pd.Series([short(u) for u in df.url.astype(str)], index=df.index)


def standard_datasets(processed: Path = PROCESSED) -> dict[str, pd.DataFrame]:
    urls = pd.read_parquet(processed / "urls.parquet")
    test = urls[urls.split == "test"].reset_index(drop=True)
    del urls
    out = {"urls_test": test}
    out["urls_test_nohf"] = test[~test.source.isin(HF_TRAINED_SOURCES)].reset_index(drop=True)
    out["urls_test_noshort"] = test[~_is_shortener(test)].reset_index(drop=True)
    extra = processed / "urls_additions_v3.parquet"
    short_parts = [test[_is_shortener(test)]]
    if extra.exists():
        add = pd.read_parquet(extra)
        short_parts.append(add[add.split == "test"])
    out["urls_test_shorteners"] = pd.concat(short_parts, ignore_index=True)
    hp = _has_path(test)
    # the "legit = bare homepage, phishing = long path" trap, inverted: legit deep links vs phishing bare domains
    out["urls_test_deeplegit_vs_barephish"] = test[((test.label == 0) & hp) | ((test.label == 1) & ~hp)].reset_index(drop=True)
    fresh = pd.read_parquet(processed / "urls_fresh_test.parquet")
    out["urls_fresh_test"] = fresh
    out["urls_fresh_test_fullurl"] = fresh[~fresh.domain_only.astype(bool)].reset_index(drop=True)
    out["urls_fresh_test_domainonly"] = fresh[fresh.domain_only.astype(bool)].reset_index(drop=True)
    v3 = processed / "uae_legit_v3.parquet"
    uae = pd.read_parquet(v3) if v3.exists() else pd.read_parquet(processed / "uae_legit.parquet").assign(in_v2=True)
    uae["label"] = 0
    out["uae_legit"] = uae[uae.in_v2.astype(bool)].reset_index(drop=True)
    if (~uae.in_v2.astype(bool)).any():
        out["uae_legit_v3_new"] = uae[~uae.in_v2.astype(bool)].reset_index(drop=True)
    return out
