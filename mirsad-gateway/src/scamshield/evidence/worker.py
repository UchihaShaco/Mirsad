"""Evidence worker: captures the evidence pack the moment a verdict turns warn or block.

Scam pages are taken down within hours, so waiting for someone to click "download" can be too late. The
worker listens to the engine's event bus and, for every verdict that becomes warn or block (including a
late revoke by the deep crawl), builds the pack in a separate process at the lowest CPU priority, never on
the path that answers users. At most `concurrency` builds run at once; blocks go before warnings and the
newest detection first. A failed build is retried once.

Every verdict gets its own pack under its own case reference (`reference.case_reference`), so the pack always
states that verdict's facts. When the verdict changes (decision, reasons, brand, review), its report, summary and
takedown texts are rebuilt. The browser and network work is not repeated when the page is unchanged: the
screenshots, rendered page and registration records of the earlier capture of the same host and content are
reused, and both the capture time and the report time are recorded.

Packs live in `<root>/<case ref>/` (unzipped) next to `<root>/<case ref>.zip`; `<root>/<case ref>.case.json`
indexes them so the API can serve the stored pack instead of rebuilding it.
"""

from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import logging
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from ..schemas import Verdict
from .reference import case_reference

log = logging.getLogger(__name__)

TRIGGERS = {"layer.done", "verdict.updated", "verdict.revoked", "verdict.reviewed"}
PRIORITY = {"block": 0, "warn": 1}
BUILD_TIMEOUT_S = 180.0
SETTLE_S = 3.0  # let the layer that raised the alarm finish saving before the verdict is read
RETRY_DELAY_S = 60.0
BACKFILL = 100  # recent warn / block verdicts without evidence, captured at start-up


def fingerprint(verdict: Verdict) -> str:
    """The facts a report states; when any of them changes, the report is rebuilt."""
    facts = {
        "decision": verdict.decision.value,
        "risk": round(verdict.risk_score),
        "reasons": sorted(r.code for r in verdict.reasons),
        "brand": verdict.brand.brand if verdict.brand else None,
        "review": verdict.review.outcome.value if verdict.review else None,
        "campaign": verdict.campaign_id,
        "stage": verdict.stage.value,
    }
    return hashlib.sha256(json.dumps(facts, sort_keys=True).encode()).hexdigest()[:16]


def _wants_evidence(decision: Optional[str], stage: Optional[str], final: Optional[bool]) -> bool:
    return decision in PRIORITY and (stage in ("page", "deep") or bool(final))


class EvidenceWorker:
    def __init__(self, store: Any, root: Path, *, concurrency: int = 2, settle_s: float = SETTLE_S,
                 retry_delay_s: float = RETRY_DELAY_S, build_timeout_s: float = BUILD_TIMEOUT_S) -> None:
        self.store = store
        self.root = Path(root)
        self.concurrency = concurrency
        self.settle_s = settle_s
        self.retry_delay_s = retry_delay_s
        self.build_timeout_s = build_timeout_s
        self.cases: dict[str, dict[str, Any]] = {}
        self.by_verdict: dict[str, str] = {}
        self.by_content: dict[tuple[str, str], str] = {}
        self.state: dict[str, dict[str, Any]] = {}  # verdict id -> {state, attempts, error}
        self._queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._seq = itertools.count()
        self._tasks: list[asyncio.Task] = []
        self._procs: set[asyncio.subprocess.Process] = set()

    # Lifecycle -------------------------------------------------------------------------------------

    async def start(self) -> "EvidenceWorker":
        self.root.mkdir(parents=True, exist_ok=True)
        for path in self.root.glob("*.case.json"):
            try:
                self._index(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError) as exc:
                log.warning("unreadable evidence index %s: %s", path, exc)
        self._tasks.append(asyncio.create_task(self._listen()))
        self._tasks += [asyncio.create_task(self._work()) for _ in range(self.concurrency)]
        self._tasks.append(asyncio.create_task(self._backfill()))
        return self

    async def close(self) -> None:
        for proc in list(self._procs):
            if proc.returncode is None:
                proc.kill()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # Queueing --------------------------------------------------------------------------------------

    def request(self, verdict_id: str, decision: str) -> bool:
        """Queue a capture (or a report refresh) for `verdict_id` unless one is already waiting."""
        if self.state.get(verdict_id, {}).get("state") in ("queued", "building"):
            return False
        attempts = self.state.get(verdict_id, {}).get("attempts", 0)
        self.state[verdict_id] = {"state": "queued", "attempts": attempts, "error": None}
        self._queue.put_nowait((PRIORITY.get(decision, 2), -next(self._seq), verdict_id))
        return True

    async def _listen(self) -> None:
        async with self.store.bus.subscribe(4096) as queue:
            while True:
                event = await queue.get()
                vid = event.get("verdict_id")
                if event.get("type") in TRIGGERS and vid and (vid in self.by_verdict or _wants_evidence(
                        event.get("decision"), event.get("stage"), event.get("final"))):
                    self.request(vid, event.get("decision") or "warn")

    async def _backfill(self) -> None:
        try:
            recent = await self.store.recent_verdicts(BACKFILL)
        except Exception as exc:
            log.warning("evidence backfill skipped: %s", exc)
            return
        for v in reversed(recent):  # oldest first, so the newest ends up at the front of the queue
            if _wants_evidence(v.get("decision"), v.get("stage"), v.get("final")) and not v.get("evidence_ref"):
                self.request(v["id"], v["decision"])

    async def _work(self) -> None:
        while True:
            _, _, verdict_id = await self._queue.get()
            try:
                await asyncio.sleep(self.settle_s)
                await self._capture(verdict_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("evidence capture for %s crashed", verdict_id)
                self._failed(verdict_id, f"{type(exc).__name__}: {exc}")

    async def _capture(self, verdict_id: str) -> None:
        verdict = await self.store.get_verdict(verdict_id)
        if verdict is None:
            self.state[verdict_id] = {"state": "failed", "attempts": 0, "error": "verdict not found"}
            return
        current = self.cases.get(case_reference(verdict_id))
        if current and current.get("fingerprint") == fingerprint(verdict) and (self.root / f"{current['case_ref']}.zip").is_file():
            await self._link(verdict_id, current["case_ref"])
            return
        self.state[verdict_id] = {**self.state.get(verdict_id, {"attempts": 0}), "state": "building", "error": None}
        try:
            case = await self.build(verdict, self._reusable(verdict))
        except Exception as exc:
            self._failed(verdict_id, str(exc))
            return
        await self._link(verdict_id, case["case_ref"])

    def _failed(self, verdict_id: str, error: str) -> None:
        attempts = self.state.get(verdict_id, {}).get("attempts", 0) + 1
        self.state[verdict_id] = {"state": "failed", "attempts": attempts, "error": error[:500]}
        log.warning("evidence capture for %s failed (attempt %d): %s", verdict_id, attempts, error[:200])
        if attempts < 2:
            asyncio.get_running_loop().call_later(self.retry_delay_s, self._retry, verdict_id)

    def _retry(self, verdict_id: str) -> None:
        state = self.state.get(verdict_id, {})
        if state.get("state") == "failed":
            self._queue.put_nowait((PRIORITY["warn"] + 1, -next(self._seq), verdict_id))
            self.state[verdict_id] = {**state, "state": "queued"}

    # Building --------------------------------------------------------------------------------------

    @staticmethod
    def _content_key(verdict: Verdict) -> tuple[str, str]:
        page = verdict.page
        digest = (page.content_hash if page else None) or (page.final_url if page else None) or verdict.url
        return verdict.host or verdict.url, digest

    def _reusable(self, verdict: Verdict) -> Optional[Path]:
        """The folder of an earlier capture of the same host and unchanged page, if one exists."""
        case_ref = self.by_content.get(self._content_key(verdict))
        folder = self.root / case_ref if case_ref else None
        return folder if folder and (folder / "manifest.json").is_file() else None

    async def build(self, verdict: Verdict, reuse: Optional[Path] = None) -> dict[str, Any]:
        """Build a pack for `verdict` in a child process at the lowest priority and index it. With `reuse`, the
        captured artefacts in that folder are reused and only the report is written afresh."""
        pending = self.root / ".pending"
        pending.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile("w", suffix=".json", dir=pending, delete=False, encoding="utf-8") as tmp:
            tmp.write(verdict.model_dump_json())
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "scamshield.evidence", tmp.name, str(self.root), *([str(reuse)] if reuse else []),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, preexec_fn=lambda: os.nice(19),
            )
            self._procs.add(proc)
            try:
                out, err = await asyncio.wait_for(proc.communicate(), self.build_timeout_s)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise RuntimeError(f"evidence build exceeded {self.build_timeout_s:.0f} s")
            finally:
                self._procs.discard(proc)
        finally:
            Path(tmp.name).unlink(missing_ok=True)
        if proc.returncode != 0:
            tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no output"]
            raise RuntimeError(f"evidence build exited {proc.returncode}: {tail[0][:300]}")
        result = json.loads(out.decode().strip().splitlines()[-1])
        case_ref = result["case_ref"]
        summary = json.loads((self.root / case_ref / "summary.json").read_text(encoding="utf-8"))
        shots = summary["screenshots"]
        case = {
            "case_ref": case_ref,
            "verdict_ids": [],
            "host": summary["host"],
            "url": summary["url"],
            "decision": summary["decision"],
            "risk_score": summary["risk_score"],
            "brand": summary["brand"],
            "brand_ar": summary["brand_ar"],
            "captured_at": (summary["captured_at"] or summary["built_at"])["utc"],
            "built_at": summary["built_at"]["utc"],
            "content_key": list(self._content_key(verdict)),
            "fingerprint": fingerprint(verdict),
            "artefacts_from": (summary.get("artefacts_from") or {}).get("case_ref"),
            "report_at": summary["built_at"]["utc"],
            "live": bool(shots["live"]["file"]),
            "engine_view": bool(shots["engine"]["file"]),
            "views_differ": summary["views"].get("differs"),
            "thumbnail": bool(result.get("thumbnail")),
        }
        self._save(case)
        return case

    async def pack_for(self, verdict: Verdict) -> Path:
        """The stored zip for `verdict` if it still states this verdict's facts, else one built now."""
        case = self.cases.get(case_reference(verdict.id))
        if case and case.get("fingerprint") == fingerprint(verdict) and (self.root / f"{case['case_ref']}.zip").is_file():
            return self.root / f"{case['case_ref']}.zip"
        case = await self.build(verdict, self._reusable(verdict))
        await self._link(verdict.id, case["case_ref"])
        return self.root / f"{case['case_ref']}.zip"

    # Index -----------------------------------------------------------------------------------------

    def _index(self, case: dict[str, Any]) -> None:
        ref = case["case_ref"]
        self.cases[ref] = case
        for vid in case["verdict_ids"]:
            if ref == case_reference(vid) or vid not in self.by_verdict:  # a verdict's own case wins over older shared ones
                self.by_verdict[vid] = ref
        if case.get("live") or case.get("engine_view"):
            self.by_content[tuple(case["content_key"])] = ref

    def _save(self, case: dict[str, Any]) -> None:
        path = self.root / f"{case['case_ref']}.case.json"
        tmp = path.with_suffix(".part")
        tmp.write_text(json.dumps(case, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)
        self._index(case)

    async def _link(self, verdict_id: str, case_ref: str) -> None:
        case = self.cases[case_ref]
        if verdict_id not in case["verdict_ids"]:
            case["verdict_ids"].append(verdict_id)
            self._save(case)
        self.state[verdict_id] = {"state": "ready", "attempts": self.state.get(verdict_id, {}).get("attempts", 0), "error": None}
        verdict = await self.store.get_verdict(verdict_id)
        if verdict is not None and verdict.evidence_ref != case_ref:
            verdict.evidence_ref = case_ref
            verdict.evidence_at = datetime.fromisoformat(case["captured_at"])
            await self.store.save_verdict(verdict)
        await self.store.publish("evidence.ready", {
            "verdict_id": verdict_id, "host": case["host"], "case_ref": case_ref, "decision": case["decision"],
            "captured_at": case["captured_at"], "live": case["live"], "engine_view": case["engine_view"],
            "views_differ": case["views_differ"],
        })

    # Queries for the API ---------------------------------------------------------------------------

    def case_for(self, verdict_id: str) -> Optional[dict[str, Any]]:
        case_ref = self.by_verdict.get(verdict_id)
        return self.cases.get(case_ref) if case_ref else None

    def status(self, verdict_id: str) -> dict[str, Any]:
        if verdict_id in self.by_verdict:
            return {"state": "ready", "case_ref": self.by_verdict[verdict_id]}
        return self.state.get(verdict_id, {"state": "none"})

    def folder(self, case_ref: str) -> Optional[Path]:
        return self.root / case_ref if case_ref in self.cases else None

    def listing(self, q: str = "", limit: int = 200) -> list[dict[str, Any]]:
        needle = q.strip().lower()
        rows = [c for c in self.cases.values()
                if not needle or needle in c["host"] or needle in (c.get("brand") or "").lower() or needle in c["case_ref"].lower()]
        rows.sort(key=lambda c: c["captured_at"], reverse=True)
        return rows[:limit]
