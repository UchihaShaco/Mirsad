"""Public entry points, resolved lazily so a missing component never breaks the others."""

from importlib import import_module

_EXPORTS = {
    "assess_domain": "domain",
    "match_brand": "brands",
    "global_brands_loaded": "brands",
    "reputation": "reputation",
    "generate_lookalikes": "lookalike",
}


def __getattr__(name: str):
    if name in _EXPORTS:
        return getattr(import_module(f"{__name__}.{_EXPORTS[name]}"), name)
    raise AttributeError(name)
