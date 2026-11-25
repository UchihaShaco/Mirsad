"""Fixtures for the pipeline tests."""

from __future__ import annotations

import pytest

from pipeline_fakes import World
from scamshield.engine.pipeline import Engine
from scamshield.engine.store import Store


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
async def engine(world: World, tmp_path):
    eng = await Engine(Store(tmp_path / "test.db"), world.components(), review_enabled=True).start()
    yield eng
    await eng.close()
