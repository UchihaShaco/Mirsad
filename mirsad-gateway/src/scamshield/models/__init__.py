"""Public entry points, resolved lazily so a missing component never breaks the others."""

from importlib import import_module

_EXPORTS = {
    "score_url": "url_model",
    "score_page": "page_model",
    "model_info": "info",
}


def __getattr__(name: str):
    if name in _EXPORTS:
        return getattr(import_module(f"{__name__}.{_EXPORTS[name]}"), name)
    raise AttributeError(name)
