"""Shared pieces for the SOTA page comparison: fixed row samples, HTML loading, the brand knowledge base
and the domain-brand consistency rule used by every reference-based method.

HTML is only ever parsed as text (selectolax); nothing is rendered, executed or fetched.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import tldextract
from selectolax.lexbor import LexborHTMLParser

ROOT = Path(__file__).resolve().parents[3]
PAGES = ROOT / "ml" / "data" / "processed" / "pages.parquet"
BRAND_DOMAINS = ROOT / "ml" / "data" / "processed" / "brand_domains.parquet"
BRANDS_JSON = ROOT / "src" / "scamshield" / "intel" / "data" / "brands.json"
CACHE = Path(__file__).resolve().parent / "cache"
RESULTS = ROOT / "ml" / "results"
META = ["source_id", "url", "label", "source", "brand", "lang", "registered_domain", "split", "source_split",
        "has_screenshot", "screenshot_path"]
# offline: the bundled public-suffix snapshot only, never a download
TLD = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)

# Row sets. Every system in a comparison is scored on exactly these rows.
#   pp_test      PhreshPhish rows in PhreshPhish's official test split AND in our (leak-free) test split
#   trop         KnowPhish TR-OP (OpenPhish 2022-23 phish + Tranco benign, with screenshots)
#   phishpedia30k  Phishpedia's own 30k phishing benchmark (sample), in-distribution for Phishpedia
SAMPLE_PER_CLASS = 300


def meta() -> pd.DataFrame:
    return pq.read_table(PAGES, columns=META).to_pandas()


def row_set(df: pd.DataFrame, name: str) -> pd.DataFrame:
    if name == "pp_test":
        return df[(df.source == "phreshphish") & (df.source_split == "test") & (df.split == "test")]
    if name == "trop":
        return df[df.source == "knowphish_tr_op"]
    if name == "phishpedia30k":
        return df[df.source == "phishpedia_phish30k"]
    if name == "arabic_test":
        return df[(df.split == "test") & (df.lang == "ar")]
    raise KeyError(name)


def balanced_sample(rows: pd.DataFrame, per_class: int = SAMPLE_PER_CLASS, seed: int = 0) -> pd.DataFrame:
    parts = [g.sample(n=min(per_class, len(g)), random_state=seed) for _, g in rows.groupby("label")]
    return pd.concat(parts).sort_values("source_id").reset_index(drop=True)


def llm_sample(name: str) -> pd.DataFrame:
    """The fixed sample every LLM-based method (and our models, for the side-by-side) is scored on.
    llm_pp: 300 + 300 from pp_test; llm_trop: 300 + 300 from TR-OP; llm_arabic: every Arabic test page."""
    path = CACHE / f"sample__{name}.parquet"
    if path.exists():
        return pd.read_parquet(path)
    df = meta()
    s = {"llm_pp": lambda: balanced_sample(row_set(df, "pp_test")),
         "llm_trop": lambda: balanced_sample(row_set(df, "trop")),
         "llm_arabic": lambda: row_set(df, "arabic_test")}[name]()
    CACHE.mkdir(exist_ok=True)
    s = s.reset_index(drop=True)
    s.to_parquet(path)
    return s


def load_html(ids: set[str]) -> dict[str, str]:
    """HTML for these source_ids, streamed one row group at a time (the html column is large)."""
    out: dict[str, str] = {}
    f = pq.ParquetFile(PAGES)
    for i in range(f.num_row_groups):
        t = f.read_row_group(i, columns=["source_id", "html"])
        sid = t.column("source_id").to_pylist()
        hit = [j for j, s in enumerate(sid) if s in ids]
        if hit:
            html = t.column("html").take(hit).to_pylist()
            out.update({sid[j]: h or "" for j, h in zip(hit, html)})
        del t
    return out


# --------------------------------------------------------------------------------------- page text


def visible_text(html: str, limit: int = 4000) -> tuple[str, str]:
    """(title, visible text) - our stand-in for the OCR text the screenshot-based papers use."""
    t = LexborHTMLParser((html or "")[:300_000])
    title = t.css_first("title")
    title = title.text(strip=True)[:200] if title else ""
    t.strip_tags(["script", "style", "noscript", "template", "svg", "head"])
    body = t.body.text(separator=" ", strip=True) if t.body is not None else ""
    return title, " ".join(body.split())[:limit]


_KEEP = {"p", "a", "img", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li"}
_LINK = re.compile(r"^(https?:)?//(www\.)?", re.I)


def simplified_html(html: str, max_chars: int = 12_000) -> str:
    """PhreshPhish's LLM-baseline preprocessing (arXiv 2507.10854, App. C): drop comments, <style>,
    <script>; keep p, a, img, h1-h6, ul, ol, li; drop tags with no text; strip http(s):// and www. from
    links and images; trim from the centre to the budget. Form inputs are kept too (as in the
    ChatPhishDetector input) because a credential form is otherwise invisible to the model."""
    t = LexborHTMLParser((html or "")[:300_000])
    t.strip_tags(["script", "style", "noscript", "template", "svg"])
    parts: list[str] = []
    for node in t.root.traverse(include_text=False) if t.root is not None else []:
        tag = node.tag
        if tag in _KEEP:
            txt = " ".join((node.text(deep=False, strip=True) or "").split())
            if tag == "a":
                href = _LINK.sub("", node.attributes.get("href") or "")[:120]
                if txt or href:
                    parts.append(f'<a href="{href}">{txt}</a>')
            elif tag == "img":
                src = _LINK.sub("", node.attributes.get("src") or "")[:120]
                alt = (node.attributes.get("alt") or "")[:80]
                if src or alt:
                    parts.append(f'<img src="{src}" alt="{alt}">')
            elif txt:
                parts.append(f"<{tag}>{txt}</{tag}>")
        elif tag in ("form", "input", "button"):
            a = node.attributes
            keep = {k: (a.get(k) or "")[:80] for k in ("action", "type", "name", "placeholder") if a.get(k)}
            if tag == "form":
                keep["action"] = _LINK.sub("", keep.get("action", ""))
            txt = " ".join((node.text(deep=False, strip=True) or "").split())[:80] if tag == "button" else ""
            parts.append(f"<{tag} " + " ".join(f'{k}="{v}"' for k, v in keep.items()) + f">{txt}")
    s = "\n".join(parts)
    if len(s) > max_chars:
        half = max_chars // 2
        s = s[:half] + "\n...\n" + s[-half:]
    return s


# --------------------------------------------------------------------------------------- brand KB


def norm_brand(s: str) -> str:
    return re.sub(r"[^0-9a-z؀-ۿ]+", "", (s or "").lower())


def regdom(host_or_url: str) -> str:
    e = TLD(host_or_url or "")
    return f"{e.domain}.{e.suffix}".lower() if e.domain and e.suffix else (e.domain or "").lower()


@lru_cache(maxsize=1)
def brand_kb() -> dict[str, set[str]]:
    """Normalised brand name / alias -> official registered domains. Sources: Phishpedia's released
    brand -> domain map (277 protected brands' list as expanded by the authors, about 5.3k entries),
    the hand-curated UAE/GCC seed, and our UAE registry (src/scamshield/intel/data/brands.json).
    This replaces KnowPhish's 20k-brand knowledge base, which is not released."""
    kb: dict[str, set[str]] = {}

    def add(name: str, doms) -> None:
        k = norm_brand(name)
        if len(k) >= 2:
            kb.setdefault(k, set()).update(regdom(d) for d in doms if d)

    bd = pd.read_parquet(BRAND_DOMAINS)
    for brand, g in bd.groupby("brand"):
        add(brand, g["domain"])
        for ar in g["arabic_name"].dropna().unique():
            add(ar, g["domain"])
    for b in json.loads(BRANDS_JSON.read_text())["brands"]:
        names = [b.get("name_en"), b.get("name_ar"), b.get("id"), *b.get("aliases_en", []), *b.get("aliases_ar", [])]
        for n in names:
            if n:
                add(n, b.get("domains", []))
    return kb


def kb_lookup(brand: str | None) -> tuple[str | None, set[str]]:
    """Alias matching against the KB: the whole normalised name, then shorter word prefixes of it
    ("Microsoft Office 365" -> "microsoftoffice365", "microsoftoffice", "microsoft"), then a KB name that
    contains the brand (>= 6 chars, e.g. "kleinanzeigen" -> "ebaykleinanzeigen"). Word boundaries stop
    "UK Visas and Immigration" from matching "visa". Returns (matched key, official registered domains)."""
    words = [w for w in (norm_brand(t) for t in re.split(r"[\s\-_/|:,.]+", brand or "")) if w]
    if not words or "".join(words) in {"none", "null", "unknown", "na"}:
        return None, set()
    kb = brand_kb()
    for n in range(len(words), 0, -1):
        k = "".join(words[:n])
        if len(k) >= 3 and k in kb:
            return k, kb[k]
    full = "".join(words)
    if len(full) >= 6:
        cands = [key for key in kb if full in key]
        if cands:
            best = min(cands, key=len)
            return best, kb[best]
    return None, set()


def domain_consistent(page_regdom: str, official: set[str]) -> bool:
    """Phishpedia / KnowPhish consistency rule: the page's registered domain is one of the brand's, or
    only the public suffix differs (regional site, e.g. amazon.de vs amazon.com)."""
    if not page_regdom:
        return False
    if page_regdom in official:
        return True
    label = page_regdom.split(".")[0]
    return any(d.split(".")[0] == label for d in official)


def lang_bucket(lang) -> str:
    if lang == "ar":
        return "ar"
    if lang == "en":
        return "en"
    return "other" if isinstance(lang, str) and lang else "unknown"


def stage_score(brand_inconsistent: bool, crp: bool) -> float:
    """3-level score for the binary reference-based pipelines (for threshold-free metrics only):
    1 = brand inconsistent with domain AND credential page (the method's phishing verdict),
    0.5 = brand inconsistent but no credential request, 0 = no brand / consistent domain."""
    return 1.0 if (brand_inconsistent and crp) else (0.5 if brand_inconsistent else 0.0)

