"""Row-level benchmark detail stays out of the committed results.

Results under ml/results/ are committed and carry counts and metrics only. Per-URL lists (false positives, top
scores, per-page rows) name real websites, so the writers put the full result under the git-ignored
data/results_full/ (same relative path) and commit a copy without them. `split` does both.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
RESULTS_DIR = ROOT / "ml" / "results"
FULL_DIR = ROOT / "data" / "results_full"
# Keys whose list values hold one row per URL or page; removed wherever they occur in a result.
ROW_KEYS = ("false_positives", "top_scores", "pass1", "pass2", "browser")
NOTE_KEY = "row_level_detail"


def full_path(committed: Path) -> Path:
    """Where the full version of a committed result lives (git-ignored)."""
    return FULL_DIR / committed.resolve().relative_to(RESULTS_DIR)


def strip(result: Any) -> Any:
    """A copy without per-URL lists; every count and metric stays. Dict-valued keys of the same name (summaries) stay."""
    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            out = {k: walk(v) for k, v in node.items() if not (k in ROW_KEYS and isinstance(v, list))}
            removed = [k for k, v in node.items() if k in ROW_KEYS and isinstance(v, list)]
            if removed:
                out[NOTE_KEY] = {k: len(node[k]) for k in removed}
            return out
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node
    return walk(copy.deepcopy(result))


def split(result: dict, committed: Path) -> Path:
    """Write the full result under data/results_full/ and the stripped one at `committed`; returns `committed`."""
    full = full_path(committed)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    committed.parent.mkdir(parents=True, exist_ok=True)
    committed.write_text(json.dumps(strip(result), indent=2, ensure_ascii=False))
    return committed


def load_full(committed: Path) -> dict:
    """The full result if this machine has it, else the committed (stripped) one, else {}."""
    for path in (full_path(committed), committed):
        if path.exists():
            return json.loads(path.read_text())
    return {}
