"""Generate candidate look-alike domains for a brand domain, for sweeping which ones are live.

Covers omission, insertion (repeat and keyboard-adjacent), transposition, replacement (keyboard and
visual), homoglyphs (ASCII and IDN, emitted as punycode), hyphenation, brand + lure keyword combos and
TLD swaps. Ordered roughly by how often each technique shows up in real phishing, so a `limit`
keeps the most likely candidates.
"""

from __future__ import annotations

from scamshield.intel import lists
from scamshield.intel.hosts import parse, to_ascii
from scamshield.intel.reputation import official_owner

KEYBOARD = {
    "q": "wa", "w": "qes", "e": "wrd", "r": "etf", "t": "ryg", "y": "tuh", "u": "yij", "i": "uok", "o": "ipl", "p": "ol",
    "a": "qsz", "s": "adwx", "d": "sfex", "f": "dgrc", "g": "fhtv", "h": "gjyb", "j": "hkun", "k": "jlim", "l": "kop",
    "z": "asx", "x": "zsdc", "c": "xdfv", "v": "cfgb", "b": "vghn", "n": "bhjm", "m": "njk",
    "1": "2q", "2": "13w", "3": "24e", "4": "35r", "5": "46t", "6": "57y", "7": "68u", "8": "79i", "9": "80o", "0": "9p",
}
ASCII_GLYPHS = {"o": ["0"], "l": ["1", "i"], "i": ["1", "l"], "e": ["3"], "a": ["4"], "s": ["5"], "b": ["8"], "g": ["9", "q"],
                "m": ["rn"], "w": ["vv"], "d": ["cl"], "u": ["v"], "n": ["m"]}
IDN_GLYPHS = {"a": ["а", "ɑ"], "e": ["е"], "o": ["о", "ο"], "p": ["р"], "c": ["с"], "y": ["у"], "x": ["х"], "i": ["і"],
              "j": ["ј"], "s": ["ѕ"], "d": ["ԁ"], "h": ["һ"], "l": ["ӏ"], "k": ["κ"], "n": ["ո"], "u": ["υ"]}
KEYWORDS = list(lists.words("lexicon", "lookalike_keywords"))
TLDS = list(lists.words("tlds", "lookalike_tlds"))


def _omission(label: str):
    return (label[:i] + label[i + 1:] for i in range(len(label)))


def _repetition(label: str):
    return (label[:i] + c + label[i:] for i, c in enumerate(label))


def _transposition(label: str):
    return (label[:i] + label[i + 1] + label[i] + label[i + 2:] for i in range(len(label) - 1) if label[i] != label[i + 1])


def _replacement(label: str):
    for i, c in enumerate(label):
        for r in KEYBOARD.get(c, ""):
            yield label[:i] + r + label[i + 1:]


def _insertion(label: str):
    for i, c in enumerate(label):
        for r in KEYBOARD.get(c, ""):
            yield label[:i] + r + label[i:]
            yield label[:i + 1] + r + label[i + 1:]


def _ascii_homoglyph(label: str):
    for i, c in enumerate(label):
        for r in ASCII_GLYPHS.get(c, []):
            yield label[:i] + r + label[i + 1:]


def _idn_homoglyph(label: str):
    for i, c in enumerate(label):
        for r in IDN_GLYPHS.get(c, []):
            yield label[:i] + r + label[i + 1:]


def _hyphenation(label: str):
    return (label[:i] + "-" + label[i:] for i in range(1, len(label)))


def _keywords(label: str):
    for k in KEYWORDS:
        yield f"{label}-{k}"
        yield f"{k}-{label}"
        yield f"{label}{k}"
        yield f"{k}{label}"


def _valid(label: str) -> bool:
    return 0 < len(label) <= 63 and not label.startswith("-") and not label.endswith("-") and "--" not in label[2:4]


# Zones only government entities can register in: a look-alike there cannot be bought, so sweep the open TLDs.
RESTRICTED_SUFFIXES = {"gov.ae", "mil.ae", "ac.ae", "sch.ae"}


def _candidates(labels, tlds):
    for lab in labels:
        if _valid(lab):
            for tld in tlds:
                yield to_ascii(f"{lab}.{tld}")


def generate_lookalikes(domain: str, limit: int = 500) -> list[str]:
    """Candidate look-alike registrable domains for `domain` (e.g. "adcb.com"), most likely first.
    Techniques are interleaved so a small `limit` still covers each of them. IDN candidates are
    returned in punycode. Official domains of any registered brand are never included."""
    parts = parse(domain)
    label, suffix = parts.label, parts.suffix
    if not label or not suffix:
        return []
    home = "ae" if suffix in RESTRICTED_SUFFIXES else suffix
    primary = list(dict.fromkeys([home, "com", "ae", "top", "icu"]))
    stages = [
        _candidates([label], [t for t in TLDS if t != suffix]),
        _candidates(_keywords(label), primary),
        _candidates(_omission(label), primary),
        _candidates(_ascii_homoglyph(label), primary),
        _candidates(_transposition(label), primary),
        _candidates(_repetition(label), [home, "com"]),
        _candidates(_hyphenation(label), [home, "com"]),
        _candidates(_idn_homoglyph(label), [home, "com"]),
        _candidates(_replacement(label), [home, "com"]),
        _candidates(_insertion(label), [home]),
    ]
    seen = {parts.registered_domain}
    ordered: list[str] = []
    while stages and len(ordered) < limit:
        for stage in list(stages):
            for _ in range(4):
                candidate = next(stage, None)
                if candidate is None:
                    stages.remove(stage)
                    break
                if candidate not in seen:
                    seen.add(candidate)
                    if official_owner(candidate) is None:
                        ordered.append(candidate)
    return ordered[:limit]
