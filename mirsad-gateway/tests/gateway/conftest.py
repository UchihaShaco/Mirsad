"""Fixtures that run the real gateway addon in mitmdump against the mock engine and local test sites."""

from __future__ import annotations

import datetime
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
import uvicorn
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

sys.path.insert(0, str(Path(__file__).parent))
import mock_engine  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
MITMDUMP = str(Path(sys.executable).with_name("mitmdump")) if Path(sys.executable).with_name("mitmdump").exists() \
    else shutil.which("mitmdump")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_port(port: int, timeout: float = 15.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"port {port} never opened")


class SiteHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        body = f"<html><body>real site {self.headers.get('Host')}{self.path}</body></html>".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


def self_signed(tmp: Path) -> tuple[Path, Path, bytes]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "scamshield test site")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=7))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("*.test")]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = tmp / "site.crt", tmp / "site.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return cert_path, key_path, cert.public_bytes(serialization.Encoding.DER)


@pytest.fixture(scope="session")
def sites(tmp_path_factory):
    """A plain HTTP and an HTTPS test site; every *.test host lands on them."""
    tmp = tmp_path_factory.mktemp("sites")
    cert_path, key_path, der = self_signed(tmp)
    http_server = ThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    https_server = ThreadingHTTPServer(("127.0.0.1", 0), SiteHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    https_server.socket = context.wrap_socket(https_server.socket, server_side=True)
    for server in (http_server, https_server):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {"http_port": http_server.server_address[1], "https_port": https_server.server_address[1], "cert_der": der}
    http_server.shutdown()
    https_server.shutdown()


@pytest.fixture(scope="session")
def engine():
    """The scripted mock engine on a free port."""
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(mock_engine.create_app(), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    wait_for_port(port)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(5)


class Gateway:
    def __init__(self, proc: subprocess.Popen, port: int, confdir: Path, log_path: Path, dns_port: int) -> None:
        self.proc, self.port, self.confdir, self.log_path, self.dns_port = proc, port, confdir, log_path, dns_port
        self.proxy = f"http://127.0.0.1:{port}"

    def log(self) -> str:
        return self.log_path.read_text(errors="replace")

    def client(self, **kwargs) -> httpx.Client:
        return httpx.Client(proxy=self.proxy, verify=kwargs.pop("verify", False), trust_env=False, timeout=20, **kwargs)


@pytest.fixture(scope="session")
def start_gateway(sites, tmp_path_factory):
    """Start mitmdump with the real addon (plus the test-site shim) in explicit-proxy and DNS modes."""
    started: list[Gateway] = []

    def start(engine_url: str, **env: str) -> Gateway:
        port, dns_port = free_port(), free_port()
        tmp = tmp_path_factory.mktemp("gateway")
        log_path = tmp / "mitmdump.log"
        environment = {
            **os.environ,
            "PYTHONUNBUFFERED": "1",
            "SCAMSHIELD_ENGINE_URL": engine_url,
            "SCAMSHIELD_HOLD_S": "3",
            "SCAMSHIELD_PASSTHROUGH": "pinned-app.test",
            "SHIM_HTTP_PORT": str(sites["http_port"]),
            "SHIM_HTTPS_PORT": str(sites["https_port"]),
            **env,
        }
        cmd = [MITMDUMP, "--mode", f"regular@127.0.0.1:{port}", "--mode", f"dns@127.0.0.1:{dns_port}",
               "--set", f"confdir={tmp}", "--set", "connection_strategy=lazy", "--set", "flow_detail=0",
               "--set", "ssl_insecure=true",
               "-s", str(ROOT / "gateway" / "addon.py"), "-s", str(HERE / "site_shim.py")]
        proc = subprocess.Popen(cmd, env=environment, stdout=log_path.open("w"), stderr=subprocess.STDOUT)
        gateway = Gateway(proc, port, tmp, log_path, dns_port)
        started.append(gateway)
        deadline = time.monotonic() + 15
        while '"event": "gateway.ready"' not in gateway.log():
            if proc.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(f"gateway failed to start:\n{gateway.log()}")
            time.sleep(0.1)
        return gateway

    yield start
    for gateway in started:
        gateway.proc.terminate()
        try:
            gateway.proc.wait(10)
        except subprocess.TimeoutExpired:
            gateway.proc.kill()


@pytest.fixture(scope="session")
def gateway(start_gateway, engine):
    gw = start_gateway(engine)
    deadline = time.monotonic() + 10
    while httpx.get(f"{engine}/mock/subscribers").json()["count"] == 0 and time.monotonic() < deadline:
        time.sleep(0.1)
    return gw
