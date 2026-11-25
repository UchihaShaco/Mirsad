import pytest

from tests.fixtures.server import Sites, start


@pytest.fixture(scope="session")
def fixture_servers() -> Sites:
    started, servers = start()
    yield started
    for server in servers:
        server.shutdown()


@pytest.fixture
def sites(fixture_servers: Sites, monkeypatch) -> Sites:
    """Both fixture listeners on free ports; private targets are allowed only inside the test."""
    monkeypatch.setenv("SCAMSHIELD_ALLOW_PRIVATE", "1")
    return fixture_servers
