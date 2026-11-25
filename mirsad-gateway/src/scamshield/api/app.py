"""HTTP API for the gateway and dashboard (see the table in docs/ARCHITECTURE.md)."""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from scamshield import config
from scamshield.api.batch import BatchError, clean_url, invalid_url, merge_row, output_columns, read_input, score_rows, write_csv
from scamshield.engine.pipeline import DEPTHS, Engine
from scamshield.engine.store import strip_html
from scamshield.evidence.api import router as evidence_router
from scamshield.evidence.worker import EvidenceWorker
from scamshield.schemas import Verdict

DASHBOARD_DIR = config.ROOT / "dashboard"
RESULTS_DIR = config.ROOT / "ml" / "results"
BENCHMARKS_MD = config.ROOT / "docs" / "BENCHMARKS.md"
# Origins allowed to call the API from a browser. The dashboard is served by this app and needs none; "*" (the
# default) also lets a dashboard opened from elsewhere use `?api=`. Empty = same origin only.
CORS_ORIGINS = [o.strip() for o in os.environ.get("SCAMSHIELD_CORS_ORIGINS", "*").split(",") if o.strip()]
MAX_BATCH_BYTES = int(os.environ.get("SCAMSHIELD_BATCH_MAX_BYTES", str(5 * 1024 * 1024)))
MAX_BATCH_URLS = int(os.environ.get("SCAMSHIELD_BATCH_MAX_URLS", "20000"))
# Scripts only from the dashboard's own files: injected markup could not run even if escaping failed somewhere.
DASHBOARD_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
                 "connect-src *; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


class CheckRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    depth: str = "page"
    wait_ms: Optional[float] = Field(default=None, ge=0)
    source: Literal["user", "gateway", "watcher", "batch"] = "user"


def _global_brands_loaded() -> bool:
    """Whether the optional global brand list is loaded; False when the intel component itself is unavailable."""
    try:
        from scamshield.intel import global_brands_loaded

        return global_brands_loaded()
    except Exception:
        return False


def _public(verdict: Verdict) -> dict[str, Any]:
    return strip_html(verdict.model_dump(mode="json"))


def create_app(engine: Optional[Engine] = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.engine = await (engine or Engine()).start()
        await app.state.engine.warm_up()
        app.state.engine.start_stale_recheck()
        app.state.evidence = await EvidenceWorker(app.state.engine.store, config.EVIDENCE_DIR).start()
        yield
        await app.state.evidence.close()
        await app.state.engine.close()

    app = FastAPI(title="Mirsad website shield API", version="0.1.0", lifespan=lifespan,
                  description="Mirsad (مرصاد) website shield: investigates a website before a person can load it and explains "
                              "the decision in English and Arabic.")
    if CORS_ORIGINS:
        app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])
    app.include_router(evidence_router)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if not request.url.path.startswith(("/v1/", "/docs", "/openapi.json", "/redoc")):
            response.headers.setdefault("Content-Security-Policy", DASHBOARD_CSP)
        return response

    def eng(request: Request) -> Engine:
        return request.app.state.engine

    @app.post("/v1/check")
    async def check(body: CheckRequest, request: Request) -> dict[str, Any]:
        if body.depth not in DEPTHS:
            raise HTTPException(422, f"depth must be one of {sorted(DEPTHS)}")
        url = clean_url(body.url)
        why = invalid_url(url)
        if why:
            raise HTTPException(422, why)
        verdict = await eng(request).investigate(url, body.depth, wait_ms=body.wait_ms, source=body.source)
        if body.source in ("user", "gateway") and verdict.host:
            eng(request).store.record_visit(verdict.host)
        return _public(verdict)

    @app.get("/v1/host/{host}")
    async def host_decision(host: str, request: Request, visit: bool = True) -> dict[str, Any]:
        """Current decision for a host. `visit=0` is for status polls, which are not traffic."""
        host = host.lower().rstrip(".")
        store = eng(request).store
        if visit:
            store.record_visit(host)
        record = store.host(host)
        if record is None or store.is_stale(record):  # a decision from older scoring code is not enforced
            raise HTTPException(404, "host never seen")
        return record.gateway_view()

    @app.get("/v1/hosts")
    async def hosts(request: Request, limit: int = Query(100, ge=1, le=5000),
                    sort: Literal["visits", "risk", "last_seen", "last_changed"] = "last_seen", q: str = "") -> list[dict[str, Any]]:
        return eng(request).store.host_rows(q=q, sort=sort, limit=limit)

    @app.get("/v1/hosts/{host}/history")
    async def host_history(host: str, request: Request) -> dict[str, Any]:
        host = host.lower().rstrip(".")
        store = eng(request).store
        if store.host(host) is None and not store.visits(host).total:
            raise HTTPException(404, "host never seen")
        return {**store.host_row(host), "changes": await store.host_changes(host),
                "verdicts": await store.host_verdicts(host), "visits_hourly": store.visits(host).last_24h(time.time())}

    @app.get("/v1/verdicts")
    async def verdicts(request: Request, limit: int = Query(50, ge=1, le=500)) -> list[dict[str, Any]]:
        return await eng(request).store.recent_verdicts(limit)

    @app.get("/v1/verdicts/{verdict_id}")
    async def verdict(verdict_id: str, request: Request) -> dict[str, Any]:
        found = await eng(request).store.get_verdict(verdict_id)
        if found is None:
            raise HTTPException(404, "verdict not found")
        return found.model_dump(mode="json")

    @app.post("/v1/verdicts/{verdict_id}/review", status_code=202)
    async def review(verdict_id: str, request: Request) -> dict[str, Any]:
        """Start a second-opinion review; steps stream as `review.step`, the outcome as `verdict.reviewed`."""
        engine_ = eng(request)
        if await engine_.store.get_verdict(verdict_id) is None:
            raise HTTPException(404, "verdict not found")
        started = engine_.start_review(verdict_id)
        return {"verdict_id": verdict_id, "status": "started" if started else "already running"}

    @app.get("/v1/benchmarks")
    async def benchmarks() -> dict[str, Any]:
        results = []
        for path in sorted(RESULTS_DIR.glob("*.json")):
            try:
                results.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        markdown = BENCHMARKS_MD.read_text(encoding="utf-8") if BENCHMARKS_MD.is_file() else None
        return {"results": results, "markdown": markdown}

    @app.get("/v1/verdicts/{verdict_id}/evidence")
    async def evidence(verdict_id: str, request: Request) -> Response:
        engine_ = eng(request)
        found = await engine_.store.get_verdict(verdict_id)
        if found is None:
            raise HTTPException(404, "verdict not found")
        try:
            path = await request.app.state.evidence.pack_for(found)  # stored pack, or built now
        except Exception as exc:
            raise HTTPException(503, f"evidence pack could not be built: {type(exc).__name__}: {exc}")
        return FileResponse(path, media_type="application/zip", filename=path.name)

    @app.get("/v1/events")
    async def events(request: Request) -> EventSourceResponse:
        bus = eng(request).store.bus

        async def stream():
            async with bus.subscribe() as queue:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield {"comment": "keep-alive"}
                        continue
                    yield {"event": event["type"], "data": json.dumps(event, default=str, ensure_ascii=False)}

        return EventSourceResponse(stream())

    @app.post("/v1/batch")
    async def batch(request: Request, depth: str = "page", concurrency: Optional[int] = Query(None, ge=1, le=64),
                    review: bool = False) -> Response:
        if depth not in DEPTHS:
            raise HTTPException(422, f"depth must be one of {sorted(DEPTHS)}")
        text = await _csv_body(request)
        try:
            batch_in = read_input(text)
        except BatchError as exc:
            raise HTTPException(400, str(exc))
        if len(batch_in.rows) > MAX_BATCH_URLS:
            raise HTTPException(413, f"at most {MAX_BATCH_URLS} URLs per batch")
        rows = await score_rows(eng(request), [r.url for r in batch_in.rows], depth=depth, concurrency=concurrency, review=review)
        out = write_csv([merge_row(batch_in, i, row) for i, row in enumerate(rows)], output_columns(batch_in))
        return Response(out, media_type="text/csv",
                        headers={"Content-Disposition": 'attachment; filename="verdicts.csv"'})

    @app.get("/v1/campaigns")
    async def campaigns(request: Request) -> Any:
        try:
            result = eng(request).components.get("list_campaigns")()
            if asyncio.iscoroutine(result):
                result = await result
        except Exception:
            return []
        return [c.model_dump(mode="json") if hasattr(c, "model_dump") else c for c in result or []]

    @app.get("/v1/health")
    async def health(request: Request) -> dict[str, Any]:
        return {"ok": True, "components": eng(request).components.status(), "review_enabled": eng(request).review_enabled,
                "load": eng(request).load(), "optional_data": {"global_brands": _global_brands_loaded()}}

    if DASHBOARD_DIR.is_dir():
        app.mount("/", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")
    else:
        @app.get("/")
        async def root() -> JSONResponse:
            return JSONResponse({"service": "scamshield", "docs": "/docs"})

    return app


async def _csv_body(request: Request) -> str:
    too_large = HTTPException(413, f"batch upload larger than {MAX_BATCH_BYTES} bytes")
    if int(request.headers.get("content-length") or 0) > MAX_BATCH_BYTES:
        raise too_large
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form(max_files=1, max_fields=10)
        upload = next((v for v in form.values() if hasattr(v, "read")), None)
        if upload is None:
            raise HTTPException(400, "multipart body has no file")
        data = await upload.read(MAX_BATCH_BYTES + 1)
    else:
        data = b""
        async for chunk in request.stream():
            data += chunk
            if len(data) > MAX_BATCH_BYTES:
                raise too_large
    if len(data) > MAX_BATCH_BYTES:
        raise too_large
    return data.decode("utf-8", "replace")


app = create_app()
