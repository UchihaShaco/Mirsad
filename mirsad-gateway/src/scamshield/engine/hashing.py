"""Fuzzy page fingerprints: 64-bit SimHash over text shingles and DOM tag paths.

Two fetches of the same page should land within `config.HASH_SAME_PAGE_DISTANCE` bits of each
other even when timestamps, nonces or session ids change; unrelated pages land ~32 bits apart.
"""

from __future__ import annotations

import base64
import hashlib
import re
from collections import Counter
from collections.abc import Iterable

import mmh3
import numpy as np
from selectolax.lexbor import LexborHTMLParser

_BITS = 64
_MASK = (1 << _BITS) - 1

# Tokens that change between loads of the same page and carry no meaning for similarity.
# Page text is hostile input: every quantifier here is bounded or possessive, so each pattern is linear.
_VOLATILE = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b",
        r"\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b",
        r"\b\d{1,2}:\d{2}(?::\d{2})?\s*+(?:am|pm)?\b",
        r"(?:csrf|xsrf|nonce|token|session|sid|request[-_ ]?id|trace[-_ ]?id)[\w-]{0,40}+\W{1,3}+\S{1,200}+",
        r"[a-z0-9+/=_-]{24,}+",
        r"[\d٠-٩]++(?:[.,][\d٠-٩]++)*+",
    )
]
_WORD = re.compile(r"\w+", re.UNICODE)
_SKIP_TAGS = {"script", "style", "noscript", "template"}


_LONG_TOKEN = re.compile(r"[a-z0-9_-]{12,}+")
MAX_HASHED_CHARS = 200_000


def _drop_ids(match: re.Match) -> str:
    """Long tokens mixing letters and digits are ids, hashes or nonces; plain long words stay."""
    token = match.group(0)
    return " " if any(ch.isdigit() for ch in token) else token


def normalise_text(text: str) -> str:
    text = text[:MAX_HASHED_CHARS].lower()
    text = _LONG_TOKEN.sub(_drop_ids, text)
    for pattern in _VOLATILE:
        text = pattern.sub(" ", text)
    return text


def simhash(features: Iterable[str] | Counter) -> int:
    counts = features if isinstance(features, Counter) else Counter(features)
    if not counts:
        return 0
    hashes = np.fromiter((mmh3.hash64(f, signed=False)[0] for f in counts), dtype=np.uint64)
    weights = np.fromiter(counts.values(), dtype=np.float64)
    bits = (hashes[:, None] >> np.arange(_BITS, dtype=np.uint64)) & np.uint64(1)
    acc = weights @ (bits.astype(np.float64) * 2 - 1)
    return sum(1 << bit for bit in np.flatnonzero(acc > 0).tolist())


def _shingles(tokens: list[str], size: int) -> Counter:
    if len(tokens) < size:
        return Counter([" ".join(tokens)] if tokens else [])
    return Counter(" ".join(tokens[i : i + size]) for i in range(len(tokens) - size + 1))


def content_hash(text: str) -> str | None:
    """SimHash of word 3-gram shingles of the visible text, volatile tokens removed."""
    tokens = _WORD.findall(normalise_text(text))
    if not tokens:
        return None
    return f"{simhash(_shingles(tokens, 3)):016x}"


def tag_paths(tree: LexborHTMLParser, depth: int = 4) -> list[str]:
    """Document-order list of each element's last `depth` ancestor tags, e.g. `body>div>form>input`."""
    paths: list[str] = []
    if tree.root is None:
        return paths
    # Iterative pre-order walk: hostile pages can nest deeper than Python's recursion limit.
    pending = [(tree.root, ("html",))]
    while pending:
        node, path = pending.pop()
        paths.append(">".join(path))
        children = []
        child = node.child
        while child is not None:
            if child.is_element_node and child.tag not in _SKIP_TAGS:
                children.append((child, (*path[-(depth - 1) :], child.tag)))
            child = child.next
        pending.extend(reversed(children))
    return paths


def structure_hash(tree: LexborHTMLParser) -> str | None:
    """SimHash over shingles of consecutive tag paths, ignoring all text and attributes."""
    paths = tag_paths(tree)
    if not paths:
        return None
    return f"{simhash(_shingles(paths, 2)):016x}"


def hamming(a: str | int | None, b: str | int | None) -> int:
    """Bit distance between two hashes; 64 when either is missing."""
    if a is None or b is None:
        return _BITS
    x = int(a, 16) if isinstance(a, str) else a
    y = int(b, 16) if isinstance(b, str) else b
    return ((x ^ y) & _MASK).bit_count()


def similarity(a: str | int | None, b: str | int | None) -> float:
    return 1.0 - hamming(a, b) / _BITS


def favicon_hash(data: bytes) -> str:
    """Shodan-compatible favicon hash: signed MurmurHash3 (32-bit) of the MIME-wrapped base64."""
    return str(mmh3.hash(base64.encodebytes(data)))


def kit_hash(form_actions: list[str], input_names: list[str], script_hosts: list[str]) -> str | None:
    """Exact SHA-256 of a page's credential flow: form action paths, input names, external script hosts.

    Phishing kits keep these when redeployed on a new domain, so equal hashes link the domains.
    """
    parts = sorted(
        {f"action:{a}" for a in form_actions}
        | {f"input:{n.lower()}" for n in input_names}
        | {f"script:{h}" for h in script_hosts}
    )
    if not parts:
        return None
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()
