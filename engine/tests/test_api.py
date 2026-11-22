"""API integration tests: security properties, sessions, questions, settings, providers, WebSocket."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from zhu_engine.api.app import create_app
from zhu_engine.api.hub import EventHub
from zhu_engine.session import SessionService
from zhu_engine.storage.db import Database
from zhu_engine.system.paths import AppPaths

TOKEN = "t" * 48
PORT = 50999


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("zhu_engine.providers.credentials.get_api_key", lambda pid: None)
    paths = AppPaths(tmp_path).ensure()
    svc = SessionService(paths, Database(paths.database), EventHub())
    app = create_app(svc, TOKEN, {"port": PORT})
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}") as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        yield c


def test_requires_token(client):
    r = client.get("/api/health", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401
    r = client.get("/api/health", headers={"Authorization": ""})
    assert r.status_code == 401


def test_rejects_foreign_host_dns_rebinding(client):
    r = client.get("/api/health", headers={"Host": "attacker.example:50999"})
    assert r.status_code == 403


def test_cors_only_allows_tauri_origins(client):
    ok = client.options("/api/health", headers={"Origin": "http://tauri.localhost", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://tauri.localhost"
    bad = client.options("/api/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_session_and_question_flow(client):
    s = client.post("/api/sessions", json={"name": "Mock"}).json()
    q = client.post("/api/questions", json={"session_id": s["id"], "text": "explain the cap theorem"}).json()[0]
    assert q["formatted_text"] == "Explain the CAP theorem." and q["state"] == "COMPLETE"
    edited = client.patch(f"/api/questions/{q['question_id']}", json={"text": "Explain the CAP theorem with an example."}).json()[0]
    assert edited["state"] == "MANUALLY_EDITED"
    saved = client.post(f"/api/questions/{q['question_id']}/save", json={"saved": True}).json()[0]
    assert saved["saved"] is True
    listed = client.get(f"/api/sessions/{s['id']}/questions").json()
    assert len(listed) == 1
    assert client.get("/api/questions", params={"saved": True}).json()[0]["question_id"] == q["question_id"]
    md = client.get(f"/api/sessions/{s['id']}/export", params={"format": "md"})
    assert "Explain the CAP theorem with an example." in md.text
    assert client.delete(f"/api/questions/{q['question_id']}").json()[0]["state"] == "DISCARDED"
    renamed = client.patch(f"/api/sessions/{s['id']}", json={"name": "Renamed"}).json()
    assert renamed["name"] == "Renamed"
    assert client.get("/api/sessions", params={"query": "Renamed"}).json()[0]["id"] == s["id"]
    assert client.delete(f"/api/sessions/{s['id']}").json()["ok"]


def test_listening_requires_model(client):
    s = client.post("/api/sessions", json={}).json()
    r = client.post("/api/listening/start", json={"session_id": s["id"]})
    assert r.status_code == 409 and "No speech model" in r.json()["detail"]


def test_settings_validation(client):
    r = client.put("/api/settings", json={"vad": {"start_threshold": 5}})
    assert r.status_code == 422
    r = client.put("/api/settings", json={"bogus": {}})
    assert r.status_code == 422
    ok = client.put("/api/settings", json={"transcription": {"profile": "latency"}}).json()
    assert ok["transcription"]["profile"] == "latency"
    assert client.get("/api/settings").json()["transcription"]["profile"] == "latency"


def test_providers_capabilities_without_keys(client):
    ps = {p["id"]: p for p in client.get("/api/providers").json()}
    free = ["gemini", "groq", "openrouter", "kilo", "pollinations", "sambanova", "nvidia", "zai"]
    assert list(ps)[:len(free)] == free and all(ps[i]["free_tier"] for i in free)  # free options are listed first
    assert not any(p["free_tier"] for i, p in ps.items() if i not in free)
    # Two of them need no key: they can be connected straight away.
    assert [i for i in free if not ps[i]["key_required"]] == ["kilo", "pollinations"] and ps["kilo"]["status"] == "needs_model"
    assert "meta" not in ps  # website-only assistants live in the AI chat tabs, not in the model list
    assert ps["claude"]["status"] == "not_configured" and ps["claude"]["has_api_key"] is False
    assert "api_key" not in str(ps["claude"]["config"])  # keys never returned
    r = client.post("/api/providers/claude/submit", json={"prompt": "hi"})
    assert r.status_code == 409


def _install_fake_model(models_root, name: str) -> None:
    from zhu_engine.stt.models import _COMPLETE_MARKER, model_dir, required_files

    d = model_dir(models_root, name)
    d.mkdir(parents=True)
    for f in (*required_files(name), _COMPLETE_MARKER):
        (d / f).write_text("x", encoding="utf-8")


def test_remove_an_installed_speech_model(client, tmp_path):
    models = AppPaths(tmp_path).models
    _install_fake_model(models, "small")
    _install_fake_model(models, "medium")
    assert client.get("/api/models").json()["installed"] == ["medium", "small"]
    after = client.delete("/api/models/small").json()
    assert after["installed"] == ["medium"] and after["setup_required"] is False and not (models / "small").exists()
    assert client.delete("/api/models/small").status_code == 200  # already gone: nothing to do
    assert client.delete("/api/models/medium").json()["setup_required"] is True  # none left: setup is offered again
    assert client.delete("/api/models/not-a-model").status_code == 404


def test_removing_the_loaded_model_releases_it_first(tmp_path):
    import asyncio

    from zhu_engine.session import EngineError
    from zhu_engine.stt.models import DownloadProgress, Selection

    class FakeTranscriber:
        stopped = False

        def stop(self):
            self.stopped = True

    paths = AppPaths(tmp_path).ensure()
    svc = SessionService(paths, Database(paths.database), EventHub())
    _install_fake_model(paths.models, "small")
    loaded = FakeTranscriber()
    svc.transcriber, svc.selection = loaded, Selection("small", "cuda", "float16", "test")  # type: ignore[assignment]
    svc.downloader.last["small"] = DownloadProgress("small", "completed")

    # While listening, the model in use cannot be removed.
    svc.state = "listening"
    with pytest.raises(EngineError):
        asyncio.run(svc.remove_model("small"))
    assert (paths.models / "small").exists() and not loaded.stopped

    # Idle but still loaded (ZHU keeps it for two minutes after Stop): unloaded at once, then deleted.
    svc.state = "idle"
    asyncio.run(svc.remove_model("small"))
    assert loaded.stopped and svc.transcriber is None and svc.selection is None
    assert not (paths.models / "small").exists() and "small" not in svc.models_status()["downloads"]
    svc.db.close()


def test_models_status_reports_setup_required(client):
    m = client.get("/api/models").json()
    assert m["setup_required"] is True and m["installed"] == []
    assert {c["name"] for c in m["catalog"]} >= {"large-v3-turbo", "small"}


def test_websocket_auth_and_replay(client):
    # Starlette's TestClient mutates the headers dict it is given, so build a fresh one per call.
    def host():
        return {"host": f"127.0.0.1:{PORT}"}

    client.post("/api/sessions", json={"name": "ws-1"})
    client.post("/api/sessions", json={"name": "ws-2"})
    with pytest.raises(Exception):
        with client.websocket_connect("/ws", subprotocols=["bearer.wrong"], headers=host()) as ws:
            ws.receive_json()
    with pytest.raises(Exception):  # correct token but foreign Host header (DNS rebinding)
        with client.websocket_connect("/ws", subprotocols=[f"bearer.{TOKEN}"], headers={"host": "evil.example"}) as ws:
            ws.receive_json()
    with client.websocket_connect("/ws", subprotocols=["zhu.v1", f"bearer.{TOKEN}"], headers=host()) as ws:
        ws.send_json({"type": "hello", "last_seq": 1})
        ack = ws.receive_json()
        assert ack["type"] == "hello.ack" and ack["seq"] == 2 and ack["gap"] is False
        replay = ws.receive_json()
        assert replay["seq"] == 2 and replay["event_type"] == "session.created" and replay["data"]["name"] == "ws-2"


def test_vocabulary_update(client):
    r = client.put("/api/vocabulary", json={"terms": [{"canonical": "Quarkus", "aliases": ["quark us"], "domains": ["JAVA"]}]})
    assert r.status_code == 200
    s = client.post("/api/sessions", json={}).json()
    q = client.post("/api/questions", json={"session_id": s["id"], "text": "what is quark us"}).json()[0]
    assert q["formatted_text"] == "What is Quarkus?"
    bad = client.put("/api/vocabulary", json={"terms": [{"canonical": "X", "aliases": []}]})
    assert bad.status_code == 400


def test_purge_requires_confirmation(client):
    assert client.post("/api/data/purge", json={"confirm": "yes"}).status_code == 422
    assert client.post("/api/data/purge", json={"confirm": "DELETE"}).json()["ok"]


def test_clear_transcript_keeps_questions(client, tmp_path):
    from zhu_engine.questions import AudioSource, TranscriptSegment

    s = client.post("/api/sessions", json={"name": "Mock"}).json()
    other = client.post("/api/sessions", json={"name": "Other"}).json()
    q = client.post("/api/questions", json={"session_id": s["id"], "text": "explain the cap theorem"}).json()[0]
    db = Database(AppPaths(tmp_path).database)
    for sid, n in ((s["id"], 3), (other["id"], 2)):
        for i in range(n):
            db.upsert_segment(sid, TranscriptSegment(segment_id=f"seg{i}", revision=1, text=f"line {i}", start_ms=i * 1000, end_ms=i * 1000 + 900,
                                                     is_final=True, source=AudioSource.SYSTEM))
    db.close()
    assert len(client.get(f"/api/sessions/{s['id']}/transcript").json()) == 3

    with client.websocket_connect("/ws", subprotocols=["zhu.v1", f"bearer.{TOKEN}"], headers={"host": f"127.0.0.1:{PORT}"}) as ws:
        ws.send_json({"type": "hello", "last_seq": 10_000})
        assert ws.receive_json()["type"] == "hello.ack"
        r = client.delete(f"/api/sessions/{s['id']}/transcript")
        assert r.json() == {"ok": True, "removed": 3}
        event = next(m for m in (ws.receive_json() for _ in range(20)) if m.get("event_type") == "transcript.cleared")
        assert event["session_id"] == s["id"] and event["data"] == {"session_id": s["id"], "removed": 3}  # every window clears its view

    assert client.get(f"/api/sessions/{s['id']}/transcript").json() == []
    assert len(client.get(f"/api/sessions/{other['id']}/transcript").json()) == 2  # only this session
    assert client.get(f"/api/sessions/{s['id']}/questions").json()[0]["question_id"] == q["question_id"]  # questions stay
    assert client.delete(f"/api/sessions/{s['id']}/transcript").json()["removed"] == 0  # nothing left: still fine
    assert client.delete("/api/sessions/nope/transcript").status_code == 404


def test_clear_questions_keeps_transcript_and_lets_them_be_asked_again(client):
    s = client.post("/api/sessions", json={"name": "Mock"}).json()
    other = client.post("/api/sessions", json={"name": "Other"}).json()
    ask = lambda sid, text: client.post("/api/questions", json={"session_id": sid, "text": text}).json()[0]  # noqa: E731
    first, second = ask(s["id"], "explain the cap theorem"), ask(s["id"], "what is a mutex")
    kept = ask(other["id"], "what is a semaphore")

    with client.websocket_connect("/ws", subprotocols=["zhu.v1", f"bearer.{TOKEN}"], headers={"host": f"127.0.0.1:{PORT}"}) as ws:
        ws.send_json({"type": "hello", "last_seq": 10_000})
        assert ws.receive_json()["type"] == "hello.ack"
        assert client.delete(f"/api/sessions/{s['id']}/questions").json() == {"ok": True, "removed": 2}
        gone = [m["data"]["question_id"] for m in (ws.receive_json() for _ in range(2)) if m["event_type"] == "question.discarded"]
        assert sorted(gone) == sorted([first["question_id"], second["question_id"]])  # one update per question: every window empties its list

    assert client.get(f"/api/sessions/{s['id']}/questions").json() == []
    assert len(client.get(f"/api/sessions/{s['id']}/questions", params={"include_discarded": True}).json()) == 2
    assert [q["question_id"] for q in client.get(f"/api/sessions/{other['id']}/questions").json()] == [kept["question_id"]]  # only this session
    # The same question asked again is a new question, not a repeat of a cleared one.
    again = ask(s["id"], "explain the cap theorem")
    assert again["state"] == "COMPLETE" and again["question_id"] != first["question_id"] and not again.get("repeat_of")
    assert client.delete(f"/api/sessions/{s['id']}/questions").json()["removed"] == 1
    assert client.delete(f"/api/sessions/{s['id']}/questions").json()["removed"] == 0  # nothing left: still fine
    assert client.delete("/api/sessions/nope/questions").status_code == 404
