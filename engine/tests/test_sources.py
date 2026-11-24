"""What Start listening listens to: system audio, the microphone, or both, and switching it while listening."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from zhu_engine.api.app import create_app
from zhu_engine.api.hub import EventHub
from zhu_engine.session import SessionService
from zhu_engine.storage.db import Database
from zhu_engine.system.paths import AppPaths

TOKEN = "t" * 48
PORT = 50998
SR = 16_000


class FakeCapture:
    """Stands in for SourceCapture: no audio device, a clock that is set by the test."""

    made: list["FakeCapture"] = []

    def __init__(self, kind, device_id, on_block, on_status, noise_reduction=True):
        self.kind, self.on_status = kind, on_status
        self.samples_out = 0
        self.started_at: int | None = None
        self.paused = self.paused_before_start = self.stopped = False
        FakeCapture.made.append(self)

    def start(self, sample_offset=0):
        self.started_at = self.samples_out = sample_offset
        self.paused_before_start = self.paused

    def stop(self):
        self.stopped = True

    def pause(self):
        self.paused = True

    def resume(self):
        self.paused = False


class FakeSegmenter:
    def __init__(self, source, cfg, on_start, on_audio, on_end):
        self.source, self.flushed = source, False

    def flush(self):
        self.flushed = True


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    monkeypatch.setattr("zhu_engine.providers.credentials.get_api_key", lambda pid: None)
    monkeypatch.setattr("zhu_engine.audio.capture.SourceCapture", FakeCapture)
    monkeypatch.setattr("zhu_engine.session.Segmenter", FakeSegmenter)
    FakeCapture.made = []
    paths = AppPaths(tmp_path).ensure()
    service = SessionService(paths, Database(paths.database), EventHub())
    yield service
    service.db.close()


def listening(svc: SessionService, *sources: str) -> None:
    """A session that is listening to these sources (what start_listening leaves behind, minus the model)."""
    svc.listening_session = "s"
    svc.state = "listening"
    for src in sources:
        svc._start_source(src, 0)


def test_the_choice_is_kept_and_both_off_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr("zhu_engine.providers.credentials.get_api_key", lambda pid: None)
    paths = AppPaths(tmp_path).ensure()
    service = SessionService(paths, Database(paths.database), EventHub())
    app = create_app(service, TOKEN, {"port": PORT})
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}") as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        assert service.chosen_sources() == ["microphone", "system"]  # both, by default
        r = c.put("/api/settings", json={"audio": {"microphone_enabled": True, "system_enabled": False}})
        assert r.status_code == 200 and service.chosen_sources() == ["microphone"]
        # Never neither: the choice is one of three, and this would leave Start listening nothing to do.
        r = c.put("/api/settings", json={"audio": {"microphone_enabled": False}})
        assert r.status_code == 422 and "listen to" in r.json()["detail"]
        assert c.get("/api/settings").json()["audio"]["microphone_enabled"] is True
        # Other changes are never blocked by it.
        assert c.put("/api/settings", json={"audio": {"noise_reduction": False}}).status_code == 200


def test_switching_while_listening_stops_one_and_starts_the_other_on_the_same_clock(svc):
    listening(svc, "microphone", "system")
    mic, system = FakeCapture.made
    mic.samples_out, system.samples_out = 5 * SR, 7 * SR  # seven seconds into the session

    svc.update_settings({"audio": {"system_enabled": False}})
    status = asyncio.run(svc.apply_chosen_sources())
    assert system.stopped and svc._segmenters.get("system") is None and not mic.stopped
    assert set(status["sources"]) == {"microphone"} and svc._captures == {"microphone": mic}

    svc.update_settings({"audio": {"system_enabled": True, "microphone_enabled": False}})
    asyncio.run(svc.apply_chosen_sources())
    new_system = FakeCapture.made[-1]
    assert mic.stopped and new_system.kind == "system" and new_system is not system
    # It joins at the session's audio clock (the newest source's), not at zero.
    assert new_system.started_at == 5 * SR and svc._captures == {"system": new_system}


def test_a_source_chosen_while_paused_starts_paused(svc):
    listening(svc, "system")
    svc.state = "paused"
    svc.update_settings({"audio": {"microphone_enabled": True}})
    asyncio.run(svc.apply_chosen_sources())
    mic = FakeCapture.made[-1]
    assert mic.kind == "microphone" and mic.paused_before_start


def test_a_change_while_not_listening_only_changes_the_next_start(svc):
    svc.update_settings({"audio": {"system_enabled": False}})
    asyncio.run(svc.apply_chosen_sources())
    assert FakeCapture.made == [] and svc._captures == {}


def test_a_stopped_source_does_not_come_back_in_the_status(svc):
    svc.loop = asyncio.new_event_loop()
    try:
        listening(svc, "microphone", "system")
        system = FakeCapture.made[1]
        svc.update_settings({"audio": {"system_enabled": False}})
        svc.loop.run_until_complete(svc.apply_chosen_sources())
        # Its thread says "stopped" after it was taken out; that must not list it again.
        system.on_status("system", "stopped", None)
        svc.loop.run_until_complete(asyncio.sleep(0))
        assert "system" not in svc.listening_status()["sources"]
    finally:
        svc.loop.close()
