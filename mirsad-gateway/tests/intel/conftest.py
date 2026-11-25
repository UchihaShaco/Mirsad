"""Intel tests run on the curated registry only: no downloaded feeds, no shared cache, no network."""

import pytest

from scamshield.intel import domain, reputation


@pytest.fixture(autouse=True)
def isolated_intel(tmp_path, monkeypatch):
    monkeypatch.setattr(reputation, "_store", reputation._FeedStore(tmp_path / "absent-feeds.db"))
    monkeypatch.setattr(domain, "_cache", domain._Cache(tmp_path / "intel_cache.db"))
    yield
