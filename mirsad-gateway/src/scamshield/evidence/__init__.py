"""Public entry points, resolved lazily so a missing component never breaks the others."""

from importlib import import_module

_EXPORTS = {
    "build_pack": "pack",
}


def __getattr__(name: str):
    if name in _EXPORTS:
        return getattr(import_module(f"{__name__}.{_EXPORTS[name]}"), name)
    raise AttributeError(name)
