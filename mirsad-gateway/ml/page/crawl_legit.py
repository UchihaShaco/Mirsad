"""Hard-negative set: LEGITIMATE pages fetched by our own engine (`scamshield.engine.fetch_page`, mobile
profile, GET only), so the page models see live home pages, login / account / pay pages, consent
walls, bot challenges and error pages exactly as the engine does.

Seeds (legitimate sites only; nothing from phishing feeds is ever fetched):
  * Tranco top sites: home page, then up to two same-site links from it (login / account / pay first);
  * official UAE domains (allowlist + `processed/uae_legit.parquet` seed and Common Crawl URLs),
    preferring its login / payment URLs.
Rows are split by registered domain: 60% live_train / 20% live_val / 20% live_test.

    nice -n 19 ionice -c 3 .venv/bin/python -m ml.page.crawl_legit --n-tranco 1300 --n-uae 900
writes ml/data/live_legit/pages.parquet
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import random
import re
import zipfile
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import pandas as pd
from selectolax.lexbor import LexborHTMLParser

from scamshield.models.page_features import split_host

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "ml" / "data" / "live_legit" / "pages.parquet"
TRANCO = ROOT / "ml" / "data" / "raw" / "tranco" / "top-1m.csv.zip"
UAE = ROOT / "ml" / "data" / "processed" / "uae_legit.parquet"
ALLOW = ROOT / "src" / "scamshield" / "intel" / "data" / "allowlist.json"
PREFERRED = re.compile(r"log-?in|sign-?in|account|my-?account|pay|checkout|billing|register|sign-?up|auth|"
                       r"تسجيل|دخول|حسابي", re.I)
MAX_HTML = 300_000


def tranco_domains(n: int) -> list[str]:
    with zipfile.ZipFile(TRANCO) as z:
        text = z.read(z.namelist()[0]).decode()
    doms = [line.split(",", 1)[1].strip() for line in io.StringIO(text) if "," in line]
    return doms[:n]


def uae_urls(n: int) -> list[str]:
    u = pd.read_parquet(UAE)
    allow = json.loads(ALLOW.read_text())["domains"]
    homes = [f"https://{d}/" for d in allow] + \
        [f"https://{d}/" for d in u["registered_domain"].dropna().unique().tolist()]
    deep = pd.concat([u[u["is_login_or_payment"]].sample(frac=1, random_state=0),
                      u[~u["is_login_or_payment"] & u["has_path"]].sample(frac=1, random_state=0)])
    # at most 4 deep URLs per registered domain, so a few big portals do not dominate
    deep = deep.groupby("registered_domain").head(4)["url"].tolist()
    out = list(dict.fromkeys(homes))[: n // 2]
    out += deep[: n - len(out)]
    return out


def internal_links(html: str, base: str, k: int) -> list[str]:
    try:
        tree = LexborHTMLParser(html[:MAX_HTML])
    except Exception:
        return []
    host = (urlsplit(base).hostname or "").lower()
    reg = split_host(host)[0]
    links, preferred = [], []
    for a in tree.css("a[href]"):
        href = (a.attributes.get("href") or "").strip()
        if not href or href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        url = urljoin(base, href).split("#")[0]
        h = (urlsplit(url).hostname or "").lower()
        if not url.startswith("http") or split_host(h)[0] != reg or url.rstrip("/") == base.rstrip("/"):
            continue
        text = (a.text(strip=True) or "") + " " + url
        (preferred if PREFERRED.search(text) else links).append(url)
    picks = list(dict.fromkeys(preferred))[:k]
    rest = [u for u in dict.fromkeys(links) if u not in picks]
    random.Random(host).shuffle(rest)
    return (picks + rest)[:k]


async def fetch_many(urls: list[tuple[str, str]], conc: int) -> list[dict]:
    from scamshield.engine import fetch_page

    sem = asyncio.Semaphore(conc)
    out: list[dict] = []

    async def one(url: str, kind: str) -> None:
        async with sem:
            try:
                s = await asyncio.wait_for(fetch_page(url), timeout=25)
            except Exception as exc:  # unreachable sites are simply skipped
                out.append({"url": url, "kind": kind, "error": f"{type(exc).__name__}"})
                return
            out.append({"url": url, "final_url": s.final_url, "status": s.status, "kind": kind,
                        "html": (s.html or "")[:MAX_HTML], "title": s.title, "error": s.error or ""})
            if len(out) % 200 == 0:
                print("fetched", len(out), flush=True)

    await asyncio.gather(*(one(u, k) for u, k in urls))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-tranco", type=int, default=1300)
    ap.add_argument("--n-uae", type=int, default=900)
    ap.add_argument("--links-per-site", type=int, default=2)
    ap.add_argument("--concurrency", type=int, default=16)
    args = ap.parse_args()
    seeds = [(f"https://{d}/", "tranco_home") for d in tranco_domains(args.n_tranco)]
    seeds += [(u, "uae") for u in uae_urls(args.n_uae)]
    rows = asyncio.run(fetch_many(seeds, args.concurrency))
    homes = [r for r in rows if r["kind"] == "tranco_home" and r.get("html")]
    follow = [(u, "tranco_internal") for r in homes
              for u in internal_links(r["html"], r["final_url"], args.links_per_site)]
    print("following", len(follow), "internal links", flush=True)
    rows += asyncio.run(fetch_many(follow, args.concurrency))
    df = pd.DataFrame(rows)
    df = df[df["html"].fillna("").str.len() > 0].copy()
    df["registered_domain"] = [split_host((urlsplit(u).hostname or "").lower())[0] for u in df["final_url"]]
    df["label"] = 0
    df["source"] = "live_legit_" + df["kind"]
    df["source_id"] = [hashlib.sha256((u + h[:2000]).encode("utf-8", "replace")).hexdigest()
                       for u, h in zip(df["final_url"], df["html"])]
    df = df.drop_duplicates("source_id")
    b = df["registered_domain"].map(lambda d: int(hashlib.md5(d.encode()).hexdigest()[:8], 16) / 2**32)
    df["split"] = ["live_test" if x < 0.2 else "live_val" if x < 0.4 else "live_train" for x in b]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    print(df.groupby(["split", "kind"]).size(), "\nerrors in kept rows:", (df["error"] != "").sum())


if __name__ == "__main__":
    main()
