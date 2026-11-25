"""HTTP routes for captured evidence, plus the benchmark assets the dashboard shows (timing study and
confusion-matrix images). The engine app includes this router next to its own routes."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from .. import config
from .worker import EvidenceWorker

router = APIRouter()

MEDIA = {".pdf": "application/pdf", ".png": "image/png", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
         ".json": "application/json", ".pem": "application/x-pem-file", ".jpg": "image/jpeg"}
VIEW_FILES = {"live": "screenshot.png", "engine": "screenshot_engine.png"}
HOSTILE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"


def _worker(request: Request) -> EvidenceWorker:
    worker = getattr(request.app.state, "evidence", None)
    if worker is None:
        raise HTTPException(503, "evidence worker is not running")
    return worker


def _summary(worker: EvidenceWorker, case_ref: str) -> dict[str, Any]:
    folder = worker.folder(case_ref)
    try:
        return json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        raise HTTPException(404, {"state": "missing", "reason": f"evidence files for {case_ref} are missing"})


def _case(worker: EvidenceWorker, verdict_id: str) -> dict[str, Any]:
    case = worker.case_for(verdict_id)
    if case is None:
        status = worker.status(verdict_id)
        reason = {"queued": "evidence capture is queued", "building": "evidence is being captured now",
                  "failed": f"evidence capture failed: {status.get('error')}"}.get(status["state"], "no evidence captured for this verdict")
        raise HTTPException(404, {"state": status["state"], "reason": reason})
    return case


@router.get("/v1/evidence")
async def evidence_cases(request: Request, q: str = "", limit: int = Query(200, ge=1, le=2000)) -> list[dict[str, Any]]:
    return _worker(request).listing(q, limit)


@router.get("/v1/verdicts/{verdict_id}/evidence/summary")
async def evidence_summary(verdict_id: str, request: Request) -> dict[str, Any]:
    worker = _worker(request)
    case = _case(worker, verdict_id)
    base = f"/v1/evidence/{case['case_ref']}/files"
    return {**_summary(worker, case["case_ref"]), "state": "ready", "verdict_ids": case["verdict_ids"],
            "links": {"zip": f"/v1/verdicts/{verdict_id}/evidence", "files": base,
                      "thumbnail": f"/v1/evidence/{case['case_ref']}/thumbnail" if case.get("thumbnail") else None}}


@router.get("/v1/verdicts/{verdict_id}/screenshot")
async def evidence_screenshot(verdict_id: str, request: Request, view: Literal["live", "engine"] = "live") -> FileResponse:
    worker = _worker(request)
    case = _case(worker, verdict_id)
    path = worker.folder(case["case_ref"]) / VIEW_FILES[view]
    if not path.is_file():
        shot = _summary(worker, case["case_ref"])["screenshots"][view]
        raise HTTPException(404, {"state": "unavailable", "reason": shot.get("error") or "screenshot not captured"})
    return FileResponse(path, media_type="image/png")


@router.get("/v1/evidence/{case_ref}/thumbnail")
async def evidence_thumbnail(case_ref: str, request: Request) -> FileResponse:
    worker = _worker(request)
    if worker.folder(case_ref) is None:
        raise HTTPException(404, "unknown case")
    path = worker.root / f"{case_ref}.thumb.jpg"
    if not path.is_file():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/v1/evidence/{case_ref}/files/{name}")
async def evidence_file(case_ref: str, name: str, request: Request) -> FileResponse:
    worker = _worker(request)
    folder = worker.folder(case_ref)
    if folder is None:
        raise HTTPException(404, "unknown case")
    listed = {f["name"] for f in json.loads((folder / "manifest.json").read_text(encoding="utf-8"))["files"]} | {"manifest.json"}
    if name not in listed:  # only files the manifest lists; never an arbitrary path
        raise HTTPException(404, "no such file in this case")
    path = folder / name
    suffix = Path(name).suffix
    disposition = "inline" if suffix in (".pdf", ".png", ".txt", ".json") else "attachment"
    # Captured pages (capture.html, rendered_dom.html) are the scam site's own markup: never let it run in the
    # dashboard's origin, even if a browser ignores the attachment disposition.
    headers = {} if suffix in (".pdf", ".png") else {"Content-Security-Policy": HOSTILE_CSP}
    return FileResponse(path, media_type=MEDIA.get(suffix, "application/octet-stream"), headers=headers,
                        filename=f"{case_ref}-{name}", content_disposition_type=disposition)


BENCH_IMAGES = ["cm__url_stack__urls_fresh_test.png", "cm__hf_urlbert_tiny_v4__urls_fresh_test.png", "cm__url_stack__uae_legit.png",
                "cm__hf_urlbert_tiny_v4__uae_legit.png", "page_confusion__pages_test.png", "page_speed.png"]
IMAGE_NAME = re.compile(r"^[A-Za-z0-9_.-]+\.png$")


@router.get("/v1/benchmarks/extra")
async def benchmark_extra() -> dict[str, Any]:
    """The page-speed study (ours by phase vs a real browser vs public models) and the curated images."""
    speed = None
    path = config.ROOT / "ml" / "results" / "page_speed" / "page_speed.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        summary = data.get("summary", {})
        browser = summary.get("browser", {})
        speed = {
            "phases": {k: v.get("p50_ms") for k, v in summary.get("engine_pass1", {}).get("phases", {}).items() if isinstance(v, dict)},
            "browser_load_p50": (browser.get("load") or {}).get("p50_ms"),
            "browser_networkidle_p50": (browser.get("networkidle") or {}).get("p50_ms"),
            "llm_p50": (data.get("llm") or {}).get("p50_ms"),
            "models": [{"model": m.get("model"), "dataset": m.get("dataset"), "p50_ms": m.get("p50_ms")} for m in data.get("models", [])],
            "published": data.get("published", []),
            "hardware": (data.get("hardware") or {}).get("cpu"),
            "pages": data.get("pages"),
        }
    except (OSError, ValueError, AttributeError):
        speed = None
    images = [name for name in BENCH_IMAGES if (config.ROOT / "docs" / "img" / name).is_file()]
    return {"page_speed": speed, "images": images}


@router.get("/v1/benchmarks/images/{name}")
async def benchmark_image(name: str) -> FileResponse:
    path = config.ROOT / "docs" / "img" / name
    if not IMAGE_NAME.match(name) or not path.is_file():
        raise HTTPException(404, "no such image")
    return FileResponse(path, media_type="image/png")
