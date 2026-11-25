from pathlib import Path

import pytest

from scamshield.watch import brands, match, settings

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def watch_env(tmp_path, monkeypatch):
    """Isolated watch.db and cache, and a fixed brand registry, for every test."""
    monkeypatch.setattr(settings, "WATCH_DB", tmp_path / "watch.db")
    monkeypatch.setattr(settings, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(brands, "REGISTRY_PATH", FIXTURES / "brands.json")
    brands.load_brands.cache_clear()
    match._index.cache_clear()
    yield
    brands.load_brands.cache_clear()
    match._index.cache_clear()
