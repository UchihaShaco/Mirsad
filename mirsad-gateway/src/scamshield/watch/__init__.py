"""Public entry points, resolved lazily so a missing component never breaks the others."""

from importlib import import_module

_EXPORTS = {
    "link_campaign": "campaigns",
    "list_campaigns": "campaigns",
}


def __getattr__(name: str):
    if name in _EXPORTS:
        return getattr(import_module(f"{__name__}.{_EXPORTS[name]}"), name)
    raise AttributeError(name)
