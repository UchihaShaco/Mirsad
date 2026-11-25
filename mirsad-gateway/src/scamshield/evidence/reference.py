"""The one case reference used everywhere: the gateway's block page, the dashboard, the PDF and the zip name."""

from __future__ import annotations


def case_reference(verdict_id: str) -> str:
    """`SS-` and the first eight hex digits of the verdict id, e.g. `SS-989EE731`."""
    return "SS-" + verdict_id.replace("-", "")[:8].upper()
