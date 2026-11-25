"""Brand impersonation: look-alike domains and pages that present themselves as a brand they are not.

Domain level: typosquats, homoglyph / IDN confusables, combosquats (brand + lure word), brand in a
subdomain or path of an unrelated host, and wrong-TLD copies. Content level (when a page is given):
the page presents itself as a brand (title, logo, copyright, site name, favicon) and asks for
credentials, card data or payment on a domain the brand does not own, or advertises a customer-care
number that is not the brand's.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache

from rapidfuzz import process
from rapidfuzz.distance import DamerauLevenshtein, Indel, JaroWinkler
from selectolax.lexbor import LexborHTMLParser

from scamshield.intel import lists
from scamshield.intel import reputation as rep
from scamshield.intel.hosts import HostParts, parents, parse
from scamshield.schemas import BrandMatch, PageSnapshot

log = logging.getLogger(__name__)

# Lure words glued to brand tokens, ordinary words near brand tokens, and brand names that are also
# ordinary vocabulary (intel/data/lexicon.json).
LURE_WORDS = lists.wordset("lexicon", "brand_lure_words")
COMMON_WORDS = lists.wordset("lexicon", "common_words")
AMBIGUOUS_ALIASES = lists.wordset("lexicon", "ambiguous_aliases")

# Global (Phishpedia) brand labels shorter than this are too often ordinary words to match on.
GLOBAL_TOKEN_MIN = 7
GLOBAL_TYPO_MIN = 9

# Code-hosting platforms where brands keep their own organisation pages (microsoft.github.io).
CODE_PLATFORMS = lists.wordset("platforms", "code_platforms")

# Look-alike characters folded to the Latin letter they imitate (Cyrillic, Greek, Arabic, Latin extensions).
CONFUSABLES = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ԁ": "d", "ɡ": "g",
    "һ": "h", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b", "ѕ": "s", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ү": "y",
    "ν": "v", "ο": "o", "α": "a", "ρ": "p", "τ": "t", "ι": "i", "κ": "k", "ε": "e", "υ": "u", "χ": "x", "β": "b",
    "η": "n", "μ": "u", "ω": "w", "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŀ": "l", "ɑ": "a", "ɩ": "i",
    "ʟ": "l", "ɴ": "n", "ʀ": "r", "ꜱ": "s", "ᴅ": "d", "ᴇ": "e", "ᴋ": "k", "ᴍ": "m", "ᴏ": "o", "ᴘ": "p", "ᴛ": "t",
    "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ᴢ": "z", "ɪ": "i", "ʏ": "y", "ɢ": "g", "ʜ": "h", "ᴄ": "c", "ᴀ": "a", "ʙ": "b",
    "ا": "l", "ل": "j", "ه": "o", "ە": "o", "٥": "o", "٠": "o", "١": "l", "۱": "l", "٧": "v", "۷": "v", "٨": "a",
    "ی": "s", "ﻫ": "o", "ﺪ": "d",
}
ASCII_LOOKALIKES = (("rn", "m"), ("vv", "w"), ("cl", "d"), ("0", "o"), ("1", "l"), ("3", "e"), ("5", "s"), ("4", "a"),
                    ("7", "t"), ("8", "b"), ("9", "g"), ("6", "b"), ("2", "z"), ("!", "i"), ("l", "i"))

_ARABIC_DIACRITICS = re.compile(r"[ً-ٰٟـ]")
_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_ARABIC_LETTERS = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})


def normalise_arabic(text: str) -> str:
    return _ARABIC_DIACRITICS.sub("", text).translate(_ARABIC_LETTERS).translate(_ARABIC_DIGITS)


_AMBIGUOUS = frozenset(normalise_arabic(w) for w in AMBIGUOUS_ALIASES)


def skeleton(text: str) -> str:
    """Fold a (decoded) label to the ASCII string it visually imitates."""
    out = []
    for ch in text.lower():
        ch = CONFUSABLES.get(ch, ch)
        if not ch.isascii():
            decomposed = unicodedata.normalize("NFKD", ch)
            ch = "".join(c for c in decomposed if c.isascii()) or ch
        out.append(ch)
    folded = "".join(out)
    for src, dst in ASCII_LOOKALIKES[:3]:
        folded = folded.replace(src, dst)
    return folded


def _ascii_variants(text: str) -> set[str]:
    """Digit and letter-pair substitutions: 'paypa1' -> 'paypal', 'rnashreq' -> 'mashreq'."""
    variants = {text}
    for src, dst in ASCII_LOOKALIKES:
        variants |= {v.replace(src, dst) for v in variants if src in v}
        if len(variants) > 64:
            break
    return variants


# --- registry ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Brand:
    id: str
    name_en: str
    name_ar: str
    category: str
    domains: tuple[str, ...]
    tokens: tuple[str, ...]
    weak_tokens: tuple[str, ...]
    phones: frozenset[str]
    favicon_hashes: frozenset[str]
    arabic_names: tuple[str, ...]  # normalised, spaces removed, for Arabic IDN labels
    country: str
    keywords: tuple[str, ...]  # cheap substring pre-check before running the alias regexes
    embeddable_domains: tuple[str, ...]  # official domains distinctive enough to spot inside another host
    text_pattern: re.Pattern | None  # aliases allowed anywhere in text
    title_pattern: re.Pattern | None  # every alias of 3+ characters, for the page title
    strong_pattern: re.Pattern | None  # unambiguous aliases, for logo / site name / copyright lines
    caps_pattern: re.Pattern | None  # upper-case acronyms, matched case-sensitively


def _alias_regex(aliases: list[str], flags=re.IGNORECASE) -> re.Pattern | None:
    if not aliases:
        return None
    parts = []
    for alias in sorted(set(aliases), key=len, reverse=True):
        body = r"\s*".join(re.escape(word) for word in alias.split())
        parts.append(body)
    return re.compile(r"(?<![\w&])(?:[وبلف]|ال)?(?:" + "|".join(parts) + r")(?![\w])", flags)


@lru_cache(maxsize=1)
def brands() -> tuple[Brand, ...]:
    raw = json.loads((rep.PKG_DATA / "brands.json").read_text(encoding="utf-8"))["brands"]
    out = []
    for b in raw:
        names = [b["name_en"], *b["aliases_en"]]
        caps = [a for a in names if a.isupper() and len(a.replace(" ", "")) <= 5]
        rest = [a for a in names if a not in caps]
        arabic = [normalise_arabic(a) for a in [b["name_ar"], *b["aliases_ar"]]]
        # Lower-case aliases of 1-2 letters ('du', 'x') are words in other languages ("Tissus du monde").
        everything = [a for a in [a.lower() for a in rest] + arabic if len(a.replace(" ", "")) > 2]
        anywhere = [a for a in everything if normalise_arabic(a) not in _AMBIGUOUS]
        out.append(
            Brand(
                id=b["id"],
                name_en=b["name_en"],
                name_ar=b["name_ar"],
                category=b["category"],
                domains=tuple(b["domains"]),
                tokens=tuple(b["tokens"]),
                weak_tokens=tuple(b["weak_tokens"]),
                phones=frozenset(canonical_phone(p) for p in b["phones"]),
                favicon_hashes=frozenset(b.get("favicon_hashes", [])),
                country=b["country"],
                keywords=tuple({" ".join(normalise_arabic(a).lower().split()) for a in names + arabic if a.strip()}
                               | set(b["domains"])),
                embeddable_domains=tuple(d for d in b["domains"] if len(parse(d).label) >= 3
                                         and not rep.shared_platform(d) and not rep.is_shortener(d)),
                arabic_names=tuple(dict.fromkeys(a.replace(" ", "") for a in arabic if normalise_arabic(a) not in _AMBIGUOUS)),
                text_pattern=_alias_regex(anywhere),
                title_pattern=_alias_regex(everything),
                strong_pattern=_alias_regex(anywhere),
                caps_pattern=_alias_regex(caps, flags=0),
            )
        )
    return tuple(out)


@lru_cache(maxsize=1)
def _brand_by_id() -> dict[str, Brand]:
    return {b.id: b for b in brands()}


GLOBAL_BRANDS_FILE = "global_brands.json"


@lru_cache(maxsize=1)
def global_brands() -> tuple[Brand, ...]:
    """Well-known foreign brands (Phishpedia domain map): domain-level matching only, no page aliases.

    The list is optional and is not in the repository (it is derived from a third-party dataset): without the file
    there are no global brands, and only the curated UAE registry (brands.json) is matched."""
    path = rep.PKG_DATA / GLOBAL_BRANDS_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))["brands"]
    except FileNotFoundError:
        log.info("optional global brand list %s not present: matching the curated registry only", path.name)
        return ()
    out = []
    for name, domains in raw.items():
        # Lower-case names in the source list are small sites ('health', 'service'): their domains count as
        # owned, but their generic labels are not matched as brand tokens.
        labels = {parse(d).label.replace("-", "") for d in domains} if name != name.lower() else set()
        out.append(Brand(
            id=f"global:{name}", name_en=name, name_ar="", category="global", domains=tuple(domains),
            tokens=tuple(sorted(t for t in labels if len(t) >= GLOBAL_TOKEN_MIN)), weak_tokens=(),
            phones=frozenset(), favicon_hashes=frozenset(), text_pattern=None, title_pattern=None, strong_pattern=None,
            caps_pattern=None,
            arabic_names=(), country="global", keywords=(), embeddable_domains=(),
        ))
    return tuple(out)


def global_brands_loaded() -> bool:
    """Whether the optional global brand list is present and loaded (reported by /v1/health)."""
    return bool(global_brands())


@dataclass(frozen=True)
class _Index:
    tokens: dict[str, tuple[Brand, str]]  # token -> (brand, "strong" | "weak" | "global")
    typo_tokens: tuple[str, ...]  # tokens eligible for edit-distance matching
    long_tokens: tuple[str, ...]  # curated tokens long enough for the prefix-similarity rule
    embed_tokens: tuple[str, ...]  # curated tokens distinctive enough to spot inside a longer label
    official_labels: frozenset[str]  # labels of every known brand domain: never typosquats
    owned: frozenset[str]  # every known brand domain (curated and global)


@lru_cache(maxsize=1)
def _index() -> _Index:
    tokens: dict[str, tuple[Brand, str]] = {}
    for b in global_brands():
        for t in b.tokens:
            tokens.setdefault(t, (b, "global"))
    for b in brands():
        for t in b.weak_tokens:
            tokens[t] = (b, "weak")
        for t in b.tokens:
            tokens[t] = (b, "strong")
    every = brands() + global_brands()
    return _Index(
        tokens=tokens,
        typo_tokens=tuple(t for t, (_, kind) in tokens.items()
                          if (kind == "strong" and len(t) >= 6) or (kind == "global" and len(t) >= GLOBAL_TYPO_MIN)),
        long_tokens=tuple(t for t, (_, kind) in tokens.items() if kind == "strong" and len(t) >= 9),
        embed_tokens=tuple(t for t, (_, kind) in tokens.items() if kind == "strong" and len(t) >= 7),
        official_labels=frozenset(parse(d).label.replace("-", "") for b in every for d in b.domains),
        owned=frozenset(d for b in every for d in b.domains),
    )


def owning_brand_domain(host: str) -> str | None:
    """The known brand domain (curated or global) this host belongs to, if any."""
    owned = _index().owned
    return next((c for c in parents(host) if c in owned), None)


@lru_cache(maxsize=1)
def _favicon_index() -> dict[str, Brand]:
    return {h: b for b in brands() for h in b.favicon_hashes}


# --- domain level -----------------------------------------------------------------------------

def _only_lures(text: str) -> bool:
    """True if text is empty or made of lure words, optionally with digits ('securelogin', 'pay2').
    Digits alone do not count: 'emirates247' is a news site, not a lure."""
    if not text:
        return True
    ok = [False] * (len(text) + 1)
    ok[0] = True
    for i in range(len(text)):
        if not ok[i]:
            continue
        if text[i].isdigit():
            ok[i + 1] = True
            continue
        for j in range(i + 1, min(len(text), i + 12) + 1):
            if text[i:j] in LURE_WORDS:
                ok[j] = True
    return ok[len(text)] and not text.isdigit()


def _cores(label: str) -> list[tuple[str, bool, bool]]:
    """Candidate brand cores of a label as (core, lure words stripped around it, stripped from a run-on
    string without a hyphen boundary). Run-on cores are too ambiguous for typo matching ('upcloud')."""
    flat = label.replace("-", "").replace("_", "")
    cores: dict[str, bool] = {flat: False}
    glued: set[str] = set()
    parts = [p for p in re.split(r"[-_]+", label) if p]
    if len(parts) > 1:
        for i, part in enumerate(parts):
            others = "".join(parts[:i] + parts[i + 1:])
            if _only_lures(others):
                cores.setdefault(part, True)
        for i in range(len(parts)):
            for j in range(i + 1, len(parts) + 1):
                joined = "".join(parts[i:j])
                if (i, j) != (0, len(parts)) and _only_lures("".join(parts[:i] + parts[j:])):
                    cores.setdefault(joined, True)
    n = len(flat)
    for i in range(n):
        if i and not _only_lures(flat[:i]):
            continue
        for j in range(n, i, -1):
            if (i, j) == (0, n):
                continue
            if _only_lures(flat[j:]) and flat[i:j] not in cores:
                cores[flat[i:j]] = True
                glued.add(flat[i:j])
    return [(c, lure, c in glued) for c, lure in cores.items() if len(c) >= 2]


def _generic_compound(token: str) -> bool:
    """'aolonline', 'mysecurebank': a token that starts or ends with a common lure word, so a one-letter
    change mostly lands on some other ordinary '...online' name."""
    return any(len(w) >= 4 and (token.startswith(w) or token.endswith(w)) for w in LURE_WORDS)


def _common_prefix(a: str, b: str) -> int:
    n = 0
    for x, y in zip(a, b, strict=False):
        if x != y:
            break
        n += 1
    return n


# Words that start or end many legitimate UAE organisation names ("Emirates Steel", "Union Copper",
# "Abu Dhabi National ..."). A look-alike must differ from the brand in its distinctive remainder.
GENERIC_PREFIXES = lists.words("lexicon", "generic_prefixes")
GENERIC_SUFFIXES = lists.words("lexicon", "generic_suffixes")
# Registries that vet registrants, and two-letter TLDs used as generic names worldwide (intel/data/tlds.json).
VETTED_SUFFIXES = lists.wordset("tlds", "vetted_suffixes")
GENERIC_CCTLDS = lists.wordset("tlds", "generic_cctlds")


def _split_generic(word: str) -> tuple[str, str]:
    """('emiratesnbd') -> ('emirates', 'nbd'): generic leading words and the distinctive remainder."""
    prefix = ""
    stripped = True
    while stripped:
        stripped = False
        for g in GENERIC_PREFIXES:
            if word.startswith(g) and len(word) - len(g) >= 3:
                prefix, word, stripped = prefix + g, word[len(g):], True
                break
    for g in GENERIC_SUFFIXES:
        if word.endswith(g) and len(word) - len(g) >= 3:
            word = word[: -len(g)]
            break
    return prefix, word


def _near_miss(core: str, token: str, country: str) -> int:
    """Edit distance when `core` is a typosquat of `token`, else 0.

    Only the token's distinctive part may differ: 'emiratesnet' is not 'emiratesnbd', 'unioncopper' is not
    'unioncoop'. Short acronyms (ADNOC, ADCB, DEWA) and other tokens under six letters never match by
    edits: 'adnec' and 'adnic' are real organisations. A second edit is tolerated only for long tokens
    when the core is a truncation ('instagr') or keeps both ends of the token ('dubopera')."""
    if len(token) < 6 or abs(len(core) - len(token)) > 2:
        return 0
    prefix, distinct = _split_generic(token)
    if len(distinct) < 4:
        return 0
    if prefix and core.startswith(prefix):
        core_rest = core[len(prefix):]
        for g in GENERIC_SUFFIXES:
            if core_rest.endswith(g) and token.endswith(g):
                core_rest = core_rest[: -len(g)]
        distance = DamerauLevenshtein.distance(core_rest, distinct)
        return distance if distance == 1 and len(distinct) >= 4 else 0
    distance = DamerauLevenshtein.distance(core, token)
    if distance == 1:
        return 1
    if distance == 2 and len(token) >= 9 and (token.startswith(core) or (core[:3] == token[:3] and core[-4:] == token[-4:])):
        return 2
    return 0


def _resembles(core: str, token: str) -> bool:
    """Looser similarity for long tokens ('dubaipoliauey' ~ 'dubaipolice'), on the distinctive part only."""
    prefix, distinct = _split_generic(token)
    if prefix:
        if not core.startswith(prefix):
            return False
        core, token = core[len(prefix):], distinct
    return (len(token) >= 6 and abs(len(core) - len(token)) <= 4 and _common_prefix(core, token) >= 0.6 * len(token)
            and JaroWinkler.similarity(core, token) >= 0.88 and Indel.normalized_similarity(core, token) >= 0.7)


@dataclass
class _Hit:
    brand: Brand
    technique: str
    score: float
    matched_on: list[str]


def _exact_hit(token: str, brand: Brand, kind: str, lure: bool, glued: bool, where: str, label: str,
               parts: HostParts, tld_bonus: float, official_labels: frozenset[str]) -> _Hit | None:
    if lure and (len(token) < 3 or (glued and (kind != "strong" or len(label) - len(token) < 3))):
        return None  # 'du' + 'apps' is not du; 'adwise' is not Wise: run-on compounds need a strong token
        # and a real lure word, otherwise only a hyphenated combination counts
    if where == "domain" and not lure:
        if kind != "strong" and tld_bonus < 0.05:
            return None
        last = parts.suffix.rsplit(".", 1)[-1]
        if len(last) == 2 and last not in GENERIC_CCTLDS and tld_bonus == 0:
            return None  # the brand's business in another country (virginmobile.sa), not a copy
        technique = "wrong_tld" if token in official_labels else "typosquat"
        base = {"strong": 0.7 if brand.country == "AE" else 0.45, "weak": 0.45, "global": 0.45}[kind]
        return _Hit(brand, technique, base + tld_bonus,
                    [f"brand name '{token}' under .{parts.suffix} instead of the official domain"])
    if parts.registered_domain in CODE_PLATFORMS and not lure:
        return None  # organisation pages such as google.github.io
    if kind != "strong" and not lure:
        return None
    technique = "combosquat" if where == "domain" else "subdomain"
    base = {"domain": 0.75, "platform": 0.8, "subdomain": 0.7}[where]
    base += {"strong": 0.0, "weak": -0.1, "global": -0.05}[kind]
    return _Hit(brand, technique, base + (0.1 if lure else 0) + tld_bonus,
                [f"brand token '{token}' in {where} label '{label}'"])


def _label_hits(label: str, unicode_label: str, where: str, parts: HostParts) -> list[_Hit]:
    """Match one label (registrable label, a subdomain label, or a platform user label) to brands."""
    idx = _index()
    hits: list[_Hit] = []
    tld_bonus = 0.1 * rep.tld_risk(parts.suffix)
    skel = skeleton(unicode_label).replace("-", "")
    is_confusable = not unicode_label.isascii() and skel != unicode_label.lower().replace("-", "")
    for core, lure, glued in _cores(label):
        exact = idx.tokens.get(core)
        if exact:
            hit = _exact_hit(core, exact[0], exact[1], lure, glued, where, label, parts, tld_bonus, idx.official_labels)
            if hit:
                hits.append(hit)
            continue
        variants = [v for v in _ascii_variants(core) if v != core and len(v) >= 5 and v in idx.tokens]
        if variants:
            brand = idx.tokens[variants[0]][0]
            hits.append(_Hit(brand, "homoglyph", 0.85 + tld_bonus,
                             [f"'{core}' imitates '{variants[0]}' with look-alike characters"]))
            continue
        if glued or len(core) < 5 or core in COMMON_WORDS or core in LURE_WORDS or core in idx.official_labels:
            continue
        if where == "domain" and parts.suffix in VETTED_SUFFIXES:
            continue  # a registered .ae name that merely resembles a brand needs page evidence, not a guess
        for token, _, _ in process.extract(core, idx.typo_tokens, scorer=DamerauLevenshtein.distance,
                                           score_cutoff=2, limit=5):
            brand, kind = idx.tokens[token]
            if kind == "global" and _generic_compound(token):
                continue
            distance = _near_miss(core, token, brand.country if kind == "strong" else "global")
            if distance:
                base = 0.85 if kind == "strong" else 0.75
                hits.append(_Hit(brand, "typosquat", base - 0.1 * distance + (0.05 if lure else 0) + tld_bonus,
                                 [f"'{core}' is {distance} edit(s) from brand token '{token}'"]))
                break
        else:
            for token, _, _ in process.extract(core, idx.long_tokens, scorer=JaroWinkler.similarity,
                                               score_cutoff=0.92, limit=3):
                if _resembles(core, token):
                    hits.append(_Hit(idx.tokens[token][0], "typosquat", 0.65 + tld_bonus,
                                     [f"'{core}' closely resembles brand token '{token}'"]))
                    break
    if is_confusable:
        for core, _, _ in _cores(skel):
            hit = idx.tokens.get(core)
            if hit and len(core) >= 3:
                hits.append(_Hit(hit[0], "homoglyph", 0.92,
                                 [f"IDN '{unicode_label}' folds to '{core}' (confusable characters)"]))
    if re.search(r"[\u0600-\u06FF]", unicode_label):
        arabic_label = normalise_arabic(unicode_label).replace("-", "")
        for brand in brands():
            for name in brand.arabic_names:
                if len(name) >= 4 and name in arabic_label:
                    hits.append(_Hit(brand, "combosquat" if where == "domain" else "subdomain", 0.85 + tld_bonus,
                                     [f"Arabic brand name '{name}' in IDN label '{unicode_label}'"]))
                    break
    if len(label) >= 9:
        flat = label.replace("-", "")
        for token in idx.embed_tokens:
            brand = idx.tokens[token][0]
            rest = flat.replace(token, "", 1)
            if token in flat and token != flat and any(w in rest for w in LURE_WORDS if len(w) >= 4) \
                    and not any(h.brand is brand for h in hits):
                hits.append(_Hit(brand, "combosquat" if where == "domain" else "subdomain", 0.55 + tld_bonus,
                                 [f"brand token '{token}' embedded in '{label}'"]))
    return hits


_PATH_SPLIT = re.compile(r"[/._\-?=&+%]+")


def domain_hits(url: str) -> list[_Hit]:
    parts = parse(url)
    host = parts.host
    platform = rep.shared_platform(host)
    if not host or parts.is_ip or (not platform and (rep.official_owner(host) or owning_brand_domain(host))):
        return []
    hits: list[_Hit] = []
    uni_labels = parts.unicode_host.split(".")
    ascii_labels = host.split(".")
    if platform and host != platform:
        user_labels = ascii_labels[: len(ascii_labels) - len(platform.split("."))]
        if user_labels:
            label = user_labels[-1]
            uni = uni_labels[len(user_labels) - 1] if len(uni_labels) == len(ascii_labels) else label
            hits += _label_hits(label, uni, "platform", parts)
    elif not platform:
        suffix_len = len(parts.suffix.split(".")) if parts.suffix else 0
        uni_label = uni_labels[-suffix_len - 1] if parts.label and len(uni_labels) > suffix_len else parts.label
        hits += _label_hits(parts.label, uni_label, "domain", parts)
        sub_labels = [s for s in parts.subdomain.split(".") if s and s not in ("www", "m", "mobile", "web")]
        uni_sub = uni_labels[: len(sub_labels)]
        for i, label in enumerate(sub_labels):
            hits += [h for h in _label_hits(label, uni_sub[i] if i < len(uni_sub) else label, "subdomain", parts)
                     if h.technique != "typosquat"]
        dotted = f".{host}"
        for b in brands():
            for domain in b.embeddable_domains:
                if f".{domain}." in f".{parts.subdomain}." or f".{domain}-" in dotted:
                    hits.append(_Hit(b, "subdomain", 0.85, [f"official domain '{domain}' embedded in host '{host}'"]))
    if parts.path and (platform or rep.tld_risk(parts.suffix) > 0):
        tokens = _index().tokens
        segments = [s.lower() for s in _PATH_SPLIT.split(parts.path.split("?", 1)[0]) if s]  # query strings carry utm_source=chatgpt.com
        lures = [s for s in segments if s in LURE_WORDS]
        for seg in segments:
            hit = tokens.get(seg)
            if hit and (hit[1] == "strong" or lures):
                hits.append(_Hit(hit[0], "path", 0.6 + (0.1 if lures else 0) + (0.1 if platform else 0),
                                 [f"brand '{seg}' in the path of {'publishing platform ' + platform if platform else host}"]))
    return hits


# --- content level ----------------------------------------------------------------------------

_LURE_PATTERNS = [re.compile(p, re.IGNORECASE) for p in (
    r"\bpay (?:now|your|the|online|fine|fines|bill)", r"\b(?:traffic|toll|parking|outstanding|unpaid|overdue) (?:fines?|fees?|violations?|balance|amount|bill)",
    r"\bfines?\b.{0,40}\b(?:due|pay|settle)", r"\bsettle\b", r"\bpenalt(?:y|ies)\b", r"\bsuspend(?:ed)?\b", r"\b(?:blocked|deactivated|locked)\b",
    r"\bverify your\b", r"\bupdate your (?:details|information|data|account|card|emirates id)", r"\bconfirm your\b",
    r"\bwithin \d+ ?(?:hours|hrs|minutes)\b", r"\bavoid (?:additional|a fine|penalt|suspension|the issuance)", r"\b(?:last|final) (?:warning|notice|chance)\b",
    r"\brefund\b", r"\b(?:reward|prize|winner|congratulations|you have won)\b", r"\bclaim (?:your|now)\b",
    r"\bcustoms (?:fee|clearance|duty)", r"\b(?:delivery|shipping|redelivery) (?:fee|charge|failed|attempt)", r"\b(?:parcel|package|shipment)\b.{0,30}\b(?:on hold|held|pending|could not)",
    r"\bblack points\b", r"\bone[- ]time password\b|\botp\b", r"\bcard number\b|\bcvv\b|\bcvc\b|\bexpir(?:y|ation) date\b",
    r"\bemirates id\b", r"\b\d{2}% (?:discount|off)\b|\bdiscount of \d+%", r"\b(?:aed|dh|dhs)\.? ?\d", r"\b\d+(?:\.\d+)? ?(?:aed|dirhams?)\b",
    r"\bkyc\b", r"\brenew (?:your|now)\b",
    "ادفع", r"دفع (?:المخالف|الغرام|الرسوم|الفاتوره)", "سداد", "مخالف", "غرام", r"رسوم (?:متاخر|مستحق|التوصيل|الجمارك|الشحن)", "متاخر",
    r"تحديث (?:ال)?بيانات", "ايقاف", "موقوف", "محظور", "تعليق (?:ال)?حساب", "رمز التحقق", "كلمه المرور", "كلمه السر", r"رقم (?:ال)?بطاقه",
    r"تاريخ (?:ال)?انتهاء", "استرداد", "جائز", "مبروك", r"(?:ال)?طرد", r"(?:ال)?شحنه", r"خصم \d+", r"\d+ ?درهم", r"درهم ?\d+",
    "النقاط السوداء", "عاجل", r"خلال \d+ ?ساع", "رقم الهويه",
)]
# Pressure that a checkout page naming its courier or bank does not apply.
_URGENCY = re.compile(
    r"within \d+ ?(?:hours|hrs|minutes|days)|on hold|could not (?:be )?deliver|unable to deliver|suspend|blocked|"
    r"deactivat|overdue|unpaid|outstanding|avoid|last (?:warning|notice|chance)|final notice|immediately|today only|"
    r"will be (?:returned|cancelled|closed|suspended)|expire[sd]? (?:today|soon)|"
    r"خلال \d+ ?(?:ساع|دقيق|ايام)|موقوف|ايقاف|تعليق|محظور|لم نتمكن|متاخر|غير مدفوع|تجنب|عاجل|فورا|اخر (?:فرصه|تنبيه)",
    re.IGNORECASE,
)

# Lures that fit what a brand of each category would plausibly ask for.
_NEVER = re.compile(r"(?!)")
_CATEGORY_LURES = {
    cat: re.compile(rx, re.IGNORECASE) for cat, rx in {
        "government": r"fine|violation|penalt|black points|toll|emirates id|visa|residen|مخالف|غرام|الهويه|تاشير|اقامه",
        "toll": r"toll|fine|recharge|balance|violation|رسوم|مخالف|رصيد",
        "courier": r"parcel|package|shipment|deliver|customs|tracking|طرد|شحنه|توصيل|جمارك",
        "bank": r"card|account|otp|kyc|blocked|suspend|بطاقه|حساب|رمز التحقق",
        "payments": r"card|account|otp|wallet|blocked|بطاقه|حساب|محفظه",
        "exchange": r"transfer|remittance|card|otp|تحويل|بطاقه",
        "utility": r"bill|refund|disconnect|overpaid|meter|فاتوره|استرداد|قطع",
        "telecom": r"bill|recharge|points|reward|sim|فاتوره|نقاط|شحن رصيد",
    }.items()
}
_HELPLINE = re.compile(
    r"customer (?:care|service|support)|help ?line|hot ?line|call us|toll[- ]free|contact (?:us|number)|call (?:centre|center)"
    r"|support (?:number|team)|24 ?/ ?7|whatsapp us|خدمه العملاء|اتصل بنا|الخط الساخن|رقم الهاتف|مركز الاتصال|للتواصل|اتصل على|الرقم المجاني",
    re.IGNORECASE,
)
_COPYRIGHT = re.compile(r"(?:©|\(c\)|copyright|جميع الحقوق محفوظه|حقوق النشر)", re.IGNORECASE)
_PHONE = re.compile(r"(?<![\w.,/])(?:\+|00)?\d[\d \-().]{4,17}\d(?![\w.,/])")
_EMERGENCY = frozenset({"999", "998", "997", "996", "901", "991", "155", "101"})


def canonical_phone(raw: str) -> str:
    digits = re.sub(r"\D", "", raw.translate(_ARABIC_DIGITS))
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("971"):
        digits = "0" + digits[3:]
    if digits.startswith(("0800", "0600")):
        digits = digits[1:]
    return digits


def extract_phones(text: str, html: str = "") -> list[str]:
    found: list[str] = []
    for raw in re.findall(r"tel:([+\d\-() .%20]{3,24})", html):
        found.append(canonical_phone(raw.replace("%20", "")))
    for m in _PHONE.finditer(text.translate(_ARABIC_DIGITS)):
        raw = m.group(0).strip()
        digits = canonical_phone(raw)
        looks_phone = raw.startswith(("+", "00", "0", "800", "600")) or digits.startswith(("800", "600"))
        if looks_phone and 6 <= len(digits) <= 15 and not re.fullmatch(r"(?:19|20)\d{2}\D*\d*", raw):
            found.append(digits)
    return list(dict.fromkeys(found))


def _phone_kind(number: str) -> str:
    if re.fullmatch(r"05\d{8}", number):
        return "uae_mobile"
    if number.startswith(("800", "600")) or re.fullmatch(r"0[2-9]\d{7}", number):
        return "uae_landline"
    return "foreign"


@dataclass
class _PageView:
    title: str
    strong_text: str  # logo alt, site name, copyright line
    body: str  # normalised visible text
    html: str
    lowered: str  # everything above, lower-cased, for keyword pre-checks


def _page_view(page: PageSnapshot) -> _PageView:
    strong: list[str] = []
    html = page.html[:600_000]
    if html:
        tree = LexborHTMLParser(html)
        for node in tree.css("meta[property='og:site_name'], meta[name='application-name'], meta[name='author']"):
            strong.append(node.attributes.get("content") or "")
        for node in tree.css("img"):
            attrs = node.attributes
            marker = " ".join(str(attrs.get(k) or "") for k in ("class", "id", "src", "alt")).lower()
            if "logo" in marker or "brand" in marker:
                strong.append(str(attrs.get("alt") or attrs.get("title") or ""))
        # Where a site names itself ("Abu Dhabi Police · Traffic Fines Payment"): the headline and the logo /
        # brand block. Not the whole header: its navigation carries "WhatsApp" / "Instagram" contact links.
        for node in tree.css("h1, [class*='logo'], [class*='brand'], [id*='logo']")[:12]:
            strong.append(node.text(separator=" ", strip=True)[:200])
    body = normalise_arabic(page.text[:200_000])
    for m in _COPYRIGHT.finditer(body):
        strong.append(body[max(0, m.start() - 60): m.end() + 100])
    title, strong_text, html = normalise_arabic(page.title), normalise_arabic(" | ".join(strong)), html[:200_000]
    lowered = f"{title} {strong_text} {body[:100_000]} {html}".lower()
    return _PageView(title, strong_text, body, html, lowered)


WIDGET_CATEGORIES = frozenset(lists.load("brands").get("widget_categories", ()))


def _mentions(brand: Brand, view: _PageView) -> tuple[float, list[str]]:
    if not any(k in view.lowered for k in brand.keywords):
        return 0.0, []
    score = 0.0
    signals: list[str] = []
    places = [("title", view.title, brand.title_pattern)]
    if brand.category not in WIDGET_CATEGORIES:  # their logos sit on every site as contact / sign-in / payment badges
        places.append(("header/logo/site name/copyright", view.strong_text, brand.strong_pattern))
    for where, text, pattern in places:
        if (pattern and pattern.search(text)) or (brand.caps_pattern and brand.caps_pattern.search(text)):
            score += 3.0
            signals.append(f"brand named in {where}")
    count = 0
    if brand.text_pattern:
        count += len(brand.text_pattern.findall(view.body, 0, 100_000))
    if brand.caps_pattern:
        count += len(brand.caps_pattern.findall(view.body, 0, 100_000))
    if count:
        score += min(count, 4) * 0.75
        signals.append(f"brand named {count}x in page text")
    if any(d in view.body or d in view.html for d in brand.domains if len(d) > 5):
        score += 0.5
        signals.append("official domain referenced in page")
    return score, signals


def _sensitive(page: PageSnapshot) -> list[str]:
    asks: list[str] = []
    for form in page.forms:
        names = " ".join(form.input_names + form.input_types).lower()
        if form.asks_card or re.search(r"card|cvv|cvc|expir", names):
            asks.append("card")
        if form.asks_otp or "otp" in names:
            asks.append("otp")
        if form.asks_password or "password" in names:
            asks.append("password")
        if form.asks_national_id or re.search(r"emirates.?id|\beid\b|national.?id|passport", names):
            asks.append("national_id")
    return sorted(set(asks))


def content_hits(page: PageSnapshot, host_parts: HostParts) -> list[_Hit]:
    view = _page_view(page)
    scored = []
    favicons = _favicon_index()
    for brand in brands():
        score, signals = _mentions(brand, view)
        if page.favicon_hash and favicons.get(page.favicon_hash) is brand:
            score += 5
            signals.append("favicon identical to the official site's")
        if score > 0:
            scored.append((score, brand, signals))
    if not scored:
        return []
    scored.sort(key=lambda s: s[0], reverse=True)
    top_score, brand, signals = scored[0]
    if sum(1 for s in scored if s[0] >= 0.6 * top_score) >= 3:
        return []  # several brands on equal footing: a directory, comparison or news page
    full_text = f"{view.title} {view.body[:30_000]}"
    lures = [m.group(0) for m in (p.search(full_text) for p in _LURE_PATTERNS) if m]
    asks = _sensitive(page)
    themed = bool(_CATEGORY_LURES.get(brand.category, _NEVER).search(full_text))
    hits: list[_Hit] = []
    # Only a page that presents itself as the brand (title, site name, logo, headline, favicon) can impersonate
    # it; a business page that merely mentions WhatsApp, Google Maps or a bank is not claiming to be them.
    in_title = any(s.startswith("brand named in title") for s in signals)
    # A page whose title carries its own domain name presents itself; brands only in its logos are partners.
    label = host_parts.registered_domain.split(".")[0].replace("-", "")
    self_named = len(label) >= 5 and label in re.sub(r"[^a-z0-9]", "", view.title.lower())
    claims_identity = in_title or (not self_named and any(s.startswith(("brand named in header", "favicon")) for s in signals))
    if top_score < 3 or not claims_identity:
        # Named only in running text: still impersonation when it is the one brand on a page that takes
        # card, OTP or ID data with a lure that fits the brand ("Emirates Post ... redelivery fee").
        sole = len(scored) == 1 or scored[1][0] * 2 <= top_score
        urgent = _URGENCY.search(full_text)
        if sole and urgent and not self_named and {"card", "otp", "national_id"} & set(asks) and len(lures) >= 2:
            score = 0.55 + (0.1 if themed else 0) + (0.05 if len(lures) >= 4 else 0)
            evidence = signals + [f"form asks for {a}" for a in asks] + [f"urgency: '{urgent.group(0)}'"]
            evidence += [f"lure: '{lure}'" for lure in lures[:5]]
            hits.append(_Hit(brand, "content", score, evidence))
        return hits
    names_itself = any(s.startswith(("brand named in header", "favicon")) for s in signals)  # a title alone may be news
    if asks or (len(lures) >= 2 and names_itself):
        score = 0.45 + (0.2 if asks else 0) + (0.1 if {"card", "otp"} & set(asks) else 0)
        score += 0.1 if len(lures) >= 2 else 0
        score += 0.05 if len(lures) >= 4 else 0
        score += 0.1 if top_score >= 6 else 0
        score += 0.05 if themed else 0
        evidence = signals + [f"form asks for {a}" for a in asks] + [f"lure: '{lure}'" for lure in lures[:5]]
        hits.append(_Hit(brand, "content", min(score, 0.95), evidence))
    if in_title and _HELPLINE.search(full_text):  # a fake helpline page puts the brand in its title
        numbers = [n for n in extract_phones(page.text, view.html) if n not in _EMERGENCY]
        foreign_or_mobile = [n for n in numbers if _phone_kind(n) != "uae_landline"]
        unofficial = [n for n in numbers if n not in brand.phones]
        if unofficial and not (brand.phones & set(numbers)) and (brand.phones or foreign_or_mobile):
            score = (0.7 if brand.phones else 0.55) + (0.15 if foreign_or_mobile else 0)
            note = f"official: {', '.join(sorted(brand.phones))}" if brand.phones else "no official number on record"
            hits.append(_Hit(brand, "fake_helpline", score,
                             signals + [f"customer-care numbers not the brand's: {', '.join(unofficial[:5])} ({note})"]))
    return hits


# --- entry point ------------------------------------------------------------------------------

_CONTENT_TECHNIQUES = frozenset({"content", "fake_helpline", "favicon"})


def _combine(hits: list[_Hit]) -> _Hit | None:
    """Per brand: strongest domain-name signal and strongest page signal, joined as independent evidence."""
    by_brand: dict[str, list[_Hit]] = {}
    for hit in hits:
        by_brand.setdefault(hit.brand.id, []).append(hit)
    best: _Hit | None = None
    for group in by_brand.values():
        if any(h.technique != "typosquat" and h.technique not in _CONTENT_TECHNIQUES for h in group):
            group = [h for h in group if h.technique != "typosquat"]  # an exact brand token outranks a near miss
        group.sort(key=lambda h: h.score, reverse=True)
        domain = next((h for h in group if h.technique not in _CONTENT_TECHNIQUES), None)
        content = [h for h in group if h.technique in _CONTENT_TECHNIQUES]
        chosen = ([domain] if domain else []) + content
        miss = (1 - min(domain.score, 0.97)) if domain else 1.0
        if content:
            miss *= 1 - min(max(h.score for h in content), 0.97)
        techniques = list(dict.fromkeys(h.technique for h in chosen))
        matched = list(dict.fromkeys(m for h in chosen for m in h.matched_on))
        combined = _Hit(group[0].brand, "+".join(techniques), round(min(1 - miss, 0.99), 3), matched)
        if best is None or combined.score > best.score:
            best = combined
    return best


POPULAR_RANK = 100_000  # established sites (Tranco): domain-name similarity alone is not evidence


def match_brand(url: str, page: PageSnapshot | None = None) -> BrandMatch | None:
    """Best brand this URL (and page, when given) appears to impersonate, or None."""
    urls = [url] + ([page.final_url] if page and page.final_url and page.final_url != url else [])
    final_parts = parse(urls[-1])
    hits: list[_Hit] = []
    for candidate in urls:
        parts = parse(candidate)
        if rep.allowlist_owner(parts.host):
            continue
        found = domain_hits(candidate)
        if found and not rep.shared_platform(parts.host):
            rank = rep.popularity_rank(parts.registered_domain)
            if rank is not None and rank <= POPULAR_RANK:
                found = [h for h in found if h.technique in ("homoglyph", "subdomain")]
        hits += found
    if page is not None and (page.text or page.html or page.title) and not rep.allowlist_owner(final_parts.host):
        owner_brand = rep.official_brand_id(final_parts.host)
        platform = rep.shared_platform(final_parts.host)
        rank = None if platform else rep.popularity_rank(final_parts.registered_domain)
        if rank is None or rank > POPULAR_RANK:
            hits += [h for h in content_hits(page, final_parts) if h.brand.id != owner_brand]
    best = _combine(hits)
    if best is None:
        return None
    b = best.brand
    return BrandMatch(
        brand=b.name_en,
        brand_ar=b.name_ar,
        category=b.category,
        official_domains=list(b.domains),
        technique=best.technique,
        matched_on=best.matched_on,
        score=best.score,
    )
