"""Hostname filtering: UAE brand keywords, look-alikes of official domains and high-risk lure patterns."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

import idna
import tldextract
from rapidfuzz.distance import DamerauLevenshtein

from scamshield.intel import lists
from scamshield.watch.brands import Brand, is_official, load_brands

_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)

INTENT = lists.wordset("lexicon", "watch_intent_words")
TRANSLIT = lists.wordset("lexicon", "watch_translit_words")
GEO = lists.wordset("lexicon", "watch_geo_words")
_GOV_LURE = lists.wordset("lexicon", "watch_gov_lure_words") | TRANSLIT
_VOCAB = INTENT | TRANSLIT | GEO | frozenset("new the www official real web".split())
_GENERIC = _VOCAB | {"government", "emirates"}  # official labels too generic to act as keywords on their own

_ARABIC_LURES = lists.words("lexicon", "watch_arabic_lures")

_HOMOGLYPHS = {"0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s"}
_MULTI = (("rn", "m"), ("vv", "w"), ("cl", "d"), ("nn", "m"))
# Confusable Cyrillic / Greek / Latin-extended letters seen in IDN homograph attacks.
_CONFUSABLES = str.maketrans("аеорсухіјѕԁɡһӏνοαтмкпвнℓı", "aeopcyxijsdghlvoatmknbhli")

RISKY_TLDS = lists.wordset("tlds", "watch_risky_tlds")

_SPLIT = re.compile(r"[.\-_0-9]+")


@dataclass
class Match:
    host: str
    registered_domain: str
    brand: str
    technique: str  # keyword | combosquat | typosquat | homoglyph | tld-swap | lure-pattern | idn
    score: float
    matched_on: list[str] = field(default_factory=list)


def split_host(host: str) -> tuple[str, str, str]:
    """(subdomain, domain label, suffix) for a hostname, using the bundled public-suffix list."""
    ext = _extract(host)
    return ext.subdomain, ext.domain, ext.suffix


def registered_domain(host: str) -> str:
    sub, dom, suf = split_host(host)
    return f"{dom}.{suf}" if suf else dom


def skeleton(label: str) -> str:
    """Collapse common visual substitutions so `uaepa55` and `uaepass` compare equal."""
    s = label.lower().translate(_CONFUSABLES)
    for a, b in _MULTI:
        s = s.replace(a, b)
    s = "".join(_HOMOGLYPHS.get(c, c) for c in s)
    return s.replace("-", "")


def _decode(label: str) -> str:
    if label.startswith("xn--"):
        try:
            return idna.decode(label)
        except idna.IDNAError:
            try:
                return label.encode("ascii").decode("idna")
            except UnicodeError:
                return label
    return label


@dataclass(frozen=True)
class _Keyword:
    word: str
    brand: Brand
    boundary: bool  # must stand as its own token (short or generic words)
    needs_lure: bool  # weak token: only with an intent / lure word
    needs_geo: bool  # global brand: only with a UAE geo word


@lru_cache(maxsize=1)
def _index() -> tuple[list[_Keyword], list[tuple[str, Brand]]]:
    """Brand keywords, and official domain labels of UAE brands for look-alike comparison."""
    kws: dict[str, _Keyword] = {}
    labels: dict[str, Brand] = {}
    for b in load_brands():
        uae = b.country == "AE"
        weak = set(b.weak_keywords)
        for d in b.official_domains:
            label = split_host(d)[1] or d.split(".")[0]
            if len(label) >= 4 and uae and label not in weak and label not in _GENERIC:
                labels.setdefault(label, b)
            if len(label) >= 4 and label not in _GENERIC and not (b.keywords or b.weak_keywords):
                kws.setdefault(label, _Keyword(label, b, len(label) <= 5, False, not uae))
        for k in b.keywords:
            compact = k.replace("-", "")
            if len(compact) >= 3:
                kws.setdefault(compact, _Keyword(compact, b, len(compact) <= 5 or compact in _GENERIC, False, not uae))
        for k in b.weak_keywords:
            compact = k.replace("-", "")
            if len(compact) >= 2:
                kws.setdefault(compact, _Keyword(compact, b, True, True, not uae))
    return list(kws.values()), list(labels.items())


def _token_hit(kw: str, tokens: list[str]) -> bool:
    for t in tokens:
        if t != kw and t in _VOCAB:  # "parkin" inside the plain word "parking"
            continue
        if t == kw:
            return True
        if t.startswith(kw) and t[len(kw):] in _VOCAB:
            return True
        if t.endswith(kw) and t[: -len(kw)] in _VOCAB:
            return True
    return False


_SUBSTRING_WORDS = tuple(w for w in INTENT | _GOV_LURE | {"dubai", "abudhabi", "sharjah"} if len(w) >= 5)


def _starts_token(kw: str, tokens: list[str]) -> bool:
    """`kw` starts a token, or follows a short or vocabulary prefix (my-, e-, secure-, login…)."""
    for t in tokens:
        i = t.find(kw)
        while i >= 0:
            if i <= 2 or t[:i] in _VOCAB:
                return True
            i = t.find(kw, i + 1)
    return False


def _lure_tokens(tokens: list[str], compact: str) -> tuple[set[str], set[str], set[str]]:
    intent = {t for t in tokens if t in INTENT and len(t) > 1}
    geo = {t for t in tokens if t in GEO}
    lure = {t for t in tokens if t in _GOV_LURE}
    for w in _SUBSTRING_WORDS:
        if w in compact and w not in tokens:
            (geo if w in GEO else lure if w in _GOV_LURE else intent).add(w)
    return intent, geo, lure


def match_host(host: str) -> Match | None:
    """Score `host` as a possible impersonation of a UAE brand. None if nothing matches or it is official."""
    host = host.lower().strip(".").removeprefix("*.")
    if not host or is_official(host):
        return None
    sub, dom, suf = split_host(host)
    if not dom:
        return None
    rd = f"{dom}.{suf}" if suf else dom
    labels = [_decode(x) for x in (sub.split(".") if sub else []) + [dom]]
    tokens = [t for x in labels for t in _SPLIT.split(x) if t]
    compact = "".join(x.replace("-", "") for x in labels)
    dom_compact = _decode(dom).replace("-", "")
    intent, geo, lure = _lure_tokens(tokens, compact)
    keywords, official_labels = _index()
    best: Match | None = None

    def offer(m: Match) -> None:
        nonlocal best
        m.score = round(m.score, 2)
        if best is None or m.score > best.score:
            best = m

    for k in keywords:
        if k.word not in compact:
            # Truncated long brand names (dubaipoli-auey.top for dubaipolice) count as a weaker hit.
            stem = k.word[:-2]
            if not (k.boundary or k.needs_geo) and len(k.word) >= 10 and stem not in _GENERIC and stem in dom_compact:
                offer(Match(host, rd, k.brand.name, "combosquat", 0.6 + (0.1 if (intent or lure) else 0.0),
                            [f"stem:{stem}"]))
            continue
        if not (_token_hit(k.word, tokens) if k.boundary else _starts_token(k.word, tokens)):
            continue
        if (k.needs_lure and not (intent or lure)) or (k.needs_geo and not geo):
            continue
        score = 0.6 if k.word in dom_compact else 0.55
        technique = "keyword" if dom_compact == k.word else "combosquat"
        score += 0.2 if (intent or lure) else 0.0
        score += 0.1 if geo else 0.0
        if k.needs_lure:
            score -= 0.1
        offer(Match(host, rd, k.brand.name, technique, min(score, 0.95),
                    [f"keyword:{k.word}"] + [f"intent:{t}" for t in sorted(intent | lure)] + [f"geo:{t}" for t in sorted(geo)]))

    sk = skeleton(_decode(dom))
    for label, brand in official_labels:
        if sk == label and dom != label:
            offer(Match(host, rd, brand.name, "homoglyph", 0.9, [f"skeleton:{label}"]))
        elif dom == label and suf not in ("ae", "gov.ae"):
            offer(Match(host, rd, brand.name, "tld-swap", 0.7, [f"label:{label}", f"suffix:{suf}"]))
        elif len(label) >= 5 and abs(len(sk) - len(label)) <= 2:
            dist = DamerauLevenshtein.distance(sk, label, score_cutoff=2)
            # Short names collide with ordinary words, so they must keep their first two and last letters.
            short_ok = len(label) >= 7 or (sk[:2] == label[:2] and sk[-1] == label[-1])
            if (dist == 1 and short_ok) or (dist == 2 and len(label) >= 10):
                offer(Match(host, rd, brand.name, "typosquat", 0.85 if dist == 1 else 0.7, [f"edit:{label}:{dist}"]))

    if best is None and not geo and any(t in ("gov", "govt") or (t[:3] == "gov" and t[3:] in _VOCAB) for t in tokens) and lure:
        geo = {"gov"}
    if best is None and geo and lure and (len(lure | intent) >= 2 or lure & set(tokens)):
        offer(Match(host, rd, "UAE government services", "lure-pattern", 0.5 + 0.1 * min(len(lure | intent), 3),
                    [f"geo:{t}" for t in sorted(geo)] + [f"lure:{t}" for t in sorted(lure | intent)]))

    if best is None and any(not x.isascii() for x in labels):
        text = "".join(labels)
        hits = [w for w in _ARABIC_LURES if w in text]
        names = [b.name for b in load_brands() if b.name_ar and b.name_ar.replace(" ", "") in text.replace(" ", "")]
        if names or len(hits) >= 2:
            offer(Match(host, rd, names[0] if names else "UAE government services", "idn", 0.7 if names else 0.55,
                        [f"arabic:{w}" for w in hits]))
    if best is not None and suf.rsplit(".", 1)[-1] in RISKY_TLDS:
        best.score = round(min(best.score + 0.1, 0.99), 2)
        best.matched_on.append(f"tld:{suf}")
    return best
