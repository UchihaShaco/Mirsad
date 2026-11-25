"""Combined description of whichever models are installed."""

from __future__ import annotations


def model_info() -> dict:
    info: dict = {}
    for name in ("url_model", "page_model"):
        try:
            module = __import__(f"scamshield.models.{name}", fromlist=["info"])
            info[name] = module.info()
        except Exception as exc:  # a model that is not trained yet is not an error
            info[name] = {"available": False, "error": str(exc)}
    return info
