"""Reference lists kept as data in `intel/data/*.json`: hosting platforms, shorteners, TLDs, lure words,
third-party services. One file per concept; code loads what it needs by key."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent / "data"


@lru_cache(maxsize=None)
def load(name: str) -> dict[str, Any]:
    return json.loads((DATA_DIR / f"{name}.json").read_text(encoding="utf-8"))


def words(name: str, key: str) -> tuple[str, ...]:
    """An ordered list, as a tuple."""
    return tuple(load(name)[key])


def wordset(name: str, key: str) -> frozenset[str]:
    return frozenset(load(name)[key])


def mapping(name: str, key: str) -> dict[str, Any]:
    return dict(load(name)[key])
