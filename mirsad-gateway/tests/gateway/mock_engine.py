"""Scripted stand-in for the engine API, used to test the gateway without the real pipeline.

Behaviour is chosen by the first label of the host name:

    allow-*   allowed at once                 slow-*    allowed after SLOW_S
    block-*   blocked (risk 92) at once       warn-*    warning (risk 52)
    revoke-*  allowed, then revoked (blocked) REVOKE_S after the first check
    review-*  allowed, revoked after REVOKE_S, then the review overturns the block REVIEW_S later
    hang-*    the engine never answers        reject-*  every check is refused with HTTP 422
    anything else: allowed

Like the real engine, /v1/check refuses URLs over 4,096 characters (422), and GET /v1/host records
whether the caller asked it not to count the lookup as a visit (`visit=0`).

Run standalone with `python tests/gateway/mock_engine.py --port 8000`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

SLOW_S = 2.0
REVOKE_S = 1.5
REVIEW_S = 2.0

REASONS = [
    {"code": "brand.impersonation", "severity": "critical", "points": 45.0,
     "title_en": "Pretends to be Abu Dhabi Police fines payment",
     "title_ar": "ينتحل صفة بوابة دفع مخالفات شرطة أبوظبي"},
    {"code": "domain.newly_registered", "severity": "high", "points": 25.0,
     "title_en": "Domain registered 3 days ago", "title_ar": "تم تسجيل النطاق قبل 3 أيام"},
    {"code": "form.card_and_otp", "severity": "high", "points": 22.0,
     "title_en": "Asks for card number and one-time code", "title_ar": "يطلب رقم البطاقة ورمز التحقق"},
    {"code": "url.lure_keywords", "severity": "medium", "points": 30.0,
     "title_en": 'Address contains lure words: "fines", "payment"',
     "title_ar": 'العنوان يحتوي على كلمات إغراء: "fines", "payment"'},
    {"code": "tls.valid", "severity": "info", "points": -3.0,
     "title_en": "Valid certificate", "title_ar": "شهادة صالحة"},
]


class CheckBody(BaseModel):
    url: str
    depth: str = "page"
    wait_ms: float | None = None


class MockEngine:
    def __init__(self) -> None:
        self.first_seen: dict[str, float] = {}
        self.verdict_ids: dict[str, str] = {}
        self.calls: list[dict] = []
        self.host_calls: list[dict] = []
        self.subscribers: set[asyncio.Queue] = set()
        self.timelines: set[asyncio.Task] = set()
        self.phase: dict[str, str] = {}  # revoke-/review- hosts: "revoked", then "reviewed"

    def kind(self, host: str) -> str:
        label = host.split(".", 1)[0]
        return label.split("-", 1)[0] if "-" in label else "allow"

    def view(self, host: str) -> dict | None:
        """Current decision for a host at this moment, in the shape of GET /v1/host."""
        if host not in self.first_seen:
            return None
        age = time.monotonic() - self.first_seen[host]
        kind = self.kind(host)
        decision, risk, stage, final, reviewed = "allow", 8.0, "page", False, None
        if kind == "hang":
            decision, risk, stage = "warn", 50.0, "reputation"
        elif kind == "slow" and age < SLOW_S:
            decision, risk, stage = "warn", 40.0, "url"
        elif kind == "block":
            decision, risk = "block", 92.0
        elif kind == "warn":
            decision, risk = "warn", 52.0
        elif self.phase.get(host) == "revoked":
            decision, risk, stage = "block", 88.0, "deep"
        elif self.phase.get(host) == "reviewed":
            decision, risk, stage, final, reviewed = "allow", 20.0, "deep", True, "overturned"
        return {"decision": decision, "risk_score": risk, "stage": stage, "final": final,
                "verdict_id": self.verdict_ids[host], "reviewed": reviewed}

    def verdict(self, host: str) -> dict:
        view = self.view(host) or {}
        blocked = view.get("decision") in ("block", "warn")
        return {"id": self.verdict_ids[host], "url": f"https://{host}/", "host": host, **view,
                "summary_en": "Fake fines payment page that steals card details." if blocked else "",
                "summary_ar": "صفحة دفع مخالفات مزيفة تسرق بيانات البطاقة." if blocked else "",
                "reasons": REASONS if blocked else [],
                "brand": {"brand": "Abu Dhabi Police", "brand_ar": "شرطة أبوظبي"} if blocked else None,
                "evidence_ref": f"SS-20261125-{self.verdict_ids[host][:8].upper()}" if blocked else None}

    def publish(self, event: str, data: dict) -> None:
        for queue in list(self.subscribers):
            queue.put_nowait((event, data))

    async def _timeline(self, host: str) -> None:
        kind = self.kind(host)
        await asyncio.sleep(REVOKE_S)
        self.phase[host] = "revoked"
        self.publish("verdict.revoked", {**self.verdict(host), "verdict_id": self.verdict_ids[host]})
        if kind == "review":
            await asyncio.sleep(REVIEW_S)
            self.phase[host] = "reviewed"
            self.publish("verdict.reviewed", {"verdict_id": self.verdict_ids[host], "host": host,
                                              "outcome": "overturned", "decision": "allow"})

    def first_check(self, host: str) -> None:
        if host in self.first_seen:
            return
        self.first_seen[host] = time.monotonic()
        self.verdict_ids[host] = uuid.uuid4().hex
        if self.kind(host) in ("revoke", "review"):
            task = asyncio.get_running_loop().create_task(self._timeline(host))
            self.timelines.add(task)
            task.add_done_callback(self.timelines.discard)


def create_app() -> FastAPI:
    app = FastAPI(title="ScamShield mock engine")
    mock = MockEngine()
    app.state.mock = mock

    @app.post("/v1/check")
    async def check(body: CheckBody) -> dict:
        host = (body.url.split("://", 1)[-1].split("/", 1)[0].split("?", 1)[0].split(":", 1)[0]).lower()
        mock.calls.append({"host": host, "url": body.url, "depth": body.depth})
        if len(body.url) > 4096 or mock.kind(host) == "reject":
            raise HTTPException(422, "url refused")
        mock.first_check(host)
        kind = mock.kind(host)
        wait_s = (body.wait_ms or 8000) / 1000
        if kind == "hang":
            await asyncio.sleep(wait_s + 5)
        elif kind == "slow":
            await asyncio.sleep(min(SLOW_S, wait_s))
        return mock.verdict(host)

    @app.get("/v1/host/{host}")
    async def host_view(host: str, visit: str = "1") -> dict:
        mock.host_calls.append({"host": host.lower(), "counted": visit != "0"})
        view = mock.view(host.lower())
        if view is None:
            raise HTTPException(404, "host never seen")
        return view

    @app.get("/v1/verdicts/{verdict_id}")
    async def verdict(verdict_id: str) -> dict:
        host = next((h for h, v in mock.verdict_ids.items() if v == verdict_id), None)
        if host is None:
            raise HTTPException(404, "unknown verdict")
        return mock.verdict(host)

    @app.get("/v1/events")
    async def events() -> StreamingResponse:
        queue: asyncio.Queue = asyncio.Queue()
        mock.subscribers.add(queue)

        async def stream():
            try:
                yield ": connected\n\n"
                while True:
                    event, data = await queue.get()
                    yield f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            finally:
                mock.subscribers.discard(queue)

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.get("/mock/calls")
    async def calls() -> list[dict]:
        return mock.calls

    @app.get("/mock/host_calls")
    async def host_calls() -> list[dict]:
        return mock.host_calls

    @app.get("/mock/subscribers")
    async def subscribers() -> dict:
        return {"count": len(mock.subscribers)}

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")
