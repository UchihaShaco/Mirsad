"""Each test gets a fresh server module with its own SQLite file and its own environment.

The server reads its settings once at import, so a fixture sets the environment and reloads it.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ADMIN = "test-admin-token"
DEVICE = "test-device-token"


@pytest.fixture
def make_client(tmp_path, monkeypatch):
    opened = []

    def _make(admin: str = "", device: str = "", region: str = "", contact_name: str = "") -> TestClient:
        monkeypatch.setenv("SCAMSHIELD_DB", str(tmp_path / f"db{len(opened)}.sqlite"))
        monkeypatch.setenv("SCAMSHIELD_ADMIN_TOKEN", admin)
        monkeypatch.setenv("SCAMSHIELD_DEVICE_TOKEN", device)
        monkeypatch.setenv("SCAMSHIELD_DEFAULT_REGION", region)
        if contact_name:
            monkeypatch.setenv("SCAMSHIELD_CONTACT_NAME", contact_name)
        else:
            monkeypatch.delenv("SCAMSHIELD_CONTACT_NAME", raising=False)
        import app.main as server
        server = importlib.reload(server)
        client = TestClient(server.app)
        client.__enter__()
        opened.append((client, server))
        return client

    yield _make
    for client, server in opened:
        client.__exit__(None, None, None)
        server.db.close()


@pytest.fixture
def client(make_client) -> TestClient:
    """Open demo mode: no admin token."""
    return make_client()
