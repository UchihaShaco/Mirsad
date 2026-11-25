from __future__ import annotations

import asyncio
import json

from evidence_samples import full_verdict

from scamshield.engine.store import EventBus
from scamshield.evidence.reference import case_reference
from scamshield.evidence.worker import EvidenceWorker, fingerprint
from scamshield.schemas import BrandMatch, Decision, Verdict


class FakeStore:
    def __init__(self, verdicts: list[Verdict]) -> None:
        self.bus = EventBus()
        self.verdicts = {v.id: v for v in verdicts}
        self.events: list[dict] = []

    async def get_verdict(self, verdict_id: str):
        v = self.verdicts.get(verdict_id)
        return v.model_copy(deep=True) if v else None

    async def save_verdict(self, verdict: Verdict) -> None:
        self.verdicts[verdict.id] = verdict

    async def recent_verdicts(self, limit: int = 50) -> list[dict]:
        return []

    async def publish(self, event_type: str, payload: dict) -> None:
        self.events.append({"type": event_type, **payload})


def _event(v: Verdict, kind: str = "layer.done") -> dict:
    return {"type": kind, "verdict_id": v.id, "host": v.host, "decision": v.decision.value, "stage": v.stage.value, "final": v.final}


async def _until(predicate, timeout: float = 3.0) -> None:
    for _ in range(int(timeout / 0.02)):
        if predicate():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not reached")


def _fake_build(worker: EvidenceWorker, builds: list, fail_first: bool = False):
    async def build(verdict: Verdict, reuse=None) -> dict:
        builds.append((verdict.id, reuse.name if reuse else None))
        if fail_first and len(builds) == 1:
            raise RuntimeError("browser crashed")
        ref = case_reference(verdict.id)
        (worker.root / ref).mkdir(exist_ok=True)
        (worker.root / ref / "manifest.json").write_text("{}")
        (worker.root / f"{ref}.zip").write_bytes(b"zip")
        case = {"case_ref": ref, "verdict_ids": [], "host": verdict.host, "url": verdict.url,
                "decision": verdict.decision.value, "risk_score": verdict.risk_score, "brand": None, "brand_ar": None,
                "captured_at": "2026-11-24T19:00:00+00:00", "built_at": "2026-11-24T19:00:01+00:00",
                "content_key": list(worker._content_key(verdict)), "fingerprint": fingerprint(verdict),
                "live": True, "engine_view": True, "views_differ": False, "thumbnail": False}
        worker._save(case)
        return case

    return build


async def test_each_verdict_gets_its_own_case_reusing_the_capture(tmp_path):
    first = full_verdict()
    second = full_verdict()
    second.id = "1" * 32
    store = FakeStore([first, second])
    worker = EvidenceWorker(store, tmp_path, settle_s=0)
    builds: list = []
    worker.build = _fake_build(worker, builds)
    await worker.start()
    try:
        await asyncio.sleep(0.05)
        store.bus.publish(_event(first))
        await _until(lambda: worker.status(first.id)["state"] == "ready")
        store.bus.publish(_event(second, "verdict.updated"))
        await _until(lambda: worker.status(second.id)["state"] == "ready")
    finally:
        await worker.close()
    assert builds == [(first.id, None), (second.id, "SS-0F3C9A1B")]
    assert worker.case_for(second.id)["case_ref"] == "SS-11111111"
    assert store.verdicts[first.id].evidence_ref == "SS-0F3C9A1B" and store.verdicts[first.id].evidence_at is not None
    assert [e["verdict_id"] for e in store.events if e["type"] == "evidence.ready"] == [first.id, second.id]


async def test_changed_verdict_gets_a_fresh_report_and_unchanged_one_does_not(tmp_path):
    verdict = full_verdict()
    store = FakeStore([verdict])
    worker = EvidenceWorker(store, tmp_path, settle_s=0)
    builds: list = []
    worker.build = _fake_build(worker, builds)
    await worker.start()
    try:
        await asyncio.sleep(0.05)
        store.bus.publish(_event(verdict))
        await _until(lambda: worker.status(verdict.id)["state"] == "ready")
        store.bus.publish(_event(verdict, "verdict.updated"))
        await asyncio.sleep(0.1)
        changed = store.verdicts[verdict.id]
        changed.brand = BrandMatch(brand="Example Police", official_domains=["police.example"])
        store.bus.publish(_event(changed, "verdict.reviewed"))
        await _until(lambda: len(builds) == 2)
    finally:
        await worker.close()
    assert builds == [(verdict.id, None), (verdict.id, "SS-0F3C9A1B")]


async def test_allowed_and_url_only_verdicts_are_ignored(tmp_path):
    allowed = full_verdict()
    allowed.decision = Decision.ALLOW
    store = FakeStore([allowed])
    worker = EvidenceWorker(store, tmp_path, settle_s=0)
    await worker.start()
    try:
        await asyncio.sleep(0.05)
        store.bus.publish(_event(allowed))
        store.bus.publish({"type": "layer.done", "verdict_id": "x", "decision": "block", "stage": "url", "final": False})
        await asyncio.sleep(0.1)
    finally:
        await worker.close()
    assert worker.status(allowed.id)["state"] == "none" and worker.status("x")["state"] == "none"


async def test_failed_capture_is_retried_once(tmp_path):
    verdict = full_verdict()
    store = FakeStore([verdict])
    worker = EvidenceWorker(store, tmp_path, settle_s=0, retry_delay_s=0.05)
    builds: list[str] = []
    worker.build = _fake_build(worker, builds, fail_first=True)
    await worker.start()
    try:
        await asyncio.sleep(0.05)
        store.bus.publish(_event(verdict, "verdict.revoked"))
        await _until(lambda: worker.status(verdict.id)["state"] == "ready")
    finally:
        await worker.close()
    assert builds == [(verdict.id, None), (verdict.id, None)]


async def test_index_survives_restart(tmp_path):
    verdict = full_verdict()
    store = FakeStore([verdict])
    worker = EvidenceWorker(store, tmp_path, settle_s=0)
    builds: list[str] = []
    worker.build = _fake_build(worker, builds)
    await worker.start()
    try:
        await asyncio.sleep(0.05)
        store.bus.publish(_event(verdict))
        await _until(lambda: worker.status(verdict.id)["state"] == "ready")
    finally:
        await worker.close()
    again = EvidenceWorker(store, tmp_path)
    await again.start()
    await again.close()
    assert again.case_for(verdict.id)["case_ref"] == "SS-0F3C9A1B"
