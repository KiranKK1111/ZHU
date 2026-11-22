"""Custom models: user-defined OpenAI-compatible endpoints (registry, keyless adapter, API, a real local server)."""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from fastapi.testclient import TestClient

from zhu_engine.api.app import create_app
from zhu_engine.api.hub import EventHub
from zhu_engine.providers.base import PromptRequest, ProviderError
from zhu_engine.providers.openai_compat import OpenAICompatibleAdapter
from zhu_engine.providers.registry import DEFINITIONS, MAX_CUSTOM_PROVIDERS, ProviderRegistry, chat_models, is_user_defined, recommend_model, validate_base_url
from zhu_engine.session import SessionService
from zhu_engine.storage.db import Database
from zhu_engine.system.paths import AppPaths

TOKEN = "t" * 48
PORT = 50998


@pytest.fixture()
def keys(monkeypatch):
    """An in-memory credential store, so tests never touch Windows Credential Manager."""
    store: dict[str, str] = {}
    monkeypatch.setattr("zhu_engine.providers.credentials.get_api_key", lambda pid: store.get(pid))
    monkeypatch.setattr("zhu_engine.providers.credentials.set_api_key", lambda pid, key: store.__setitem__(pid, key.strip()))
    monkeypatch.setattr("zhu_engine.providers.credentials.delete_api_key", lambda pid: store.pop(pid, None))
    return store


@pytest.fixture()
def client(tmp_path, keys):
    paths = AppPaths(tmp_path).ensure()
    svc = SessionService(paths, Database(paths.database), EventHub())
    with TestClient(create_app(svc, TOKEN, {"port": PORT}), base_url=f"http://127.0.0.1:{PORT}") as c:
        c.headers["Authorization"] = f"Bearer {TOKEN}"
        c.paths = paths  # type: ignore[attr-defined]
        yield c


# ------------------------------------------------------------------ registry
def test_base_url_validation():
    assert validate_base_url(" http://localhost:11434/v1/ ") == "http://localhost:11434/v1"
    assert validate_base_url("https://openrouter.ai/api/v1") == "https://openrouter.ai/api/v1"
    for bad in ["", "localhost:11434", "ftp://host/v1", "file:///C:/x", "https://", "https://user:secret@host/v1"]:
        with pytest.raises(ValueError):
            validate_base_url(bad)


def test_user_defined_ids():
    assert is_user_defined("custom-1a2b3c4d") and not is_user_defined("custom") and not is_user_defined("chatgpt")
    assert not is_user_defined("custom-../../x") and not is_user_defined("custom-ABC123")


def test_add_persist_and_remove(keys):
    reg = ProviderRegistry({})
    pid = reg.add_custom("  Local  Llama ", "http://localhost:11434/v1/", "llama3.2", images=True)
    assert is_user_defined(pid) and reg.definitions[pid].key_required is False
    info = reg.info(pid)
    assert (info["name"], info["status"], info["model"]) == ("Local Llama", "ready", "llama3.2")
    assert info["user_defined"] is True and info["has_api_key"] is False and info["capabilities"]["images"] is True
    assert reg.configs[pid].base_url == "http://localhost:11434/v1"

    # Restart: the endpoint comes back from the saved settings, after the built-in providers.
    again = ProviderRegistry(json.loads(json.dumps(reg.serialize_configs())))
    assert list(again.definitions)[-1] == pid and again.info(pid)["name"] == "Local Llama"
    assert again.adapter(pid).base_url == "http://localhost:11434/v1"

    keys[pid] = "sk-secret"
    asyncio.run(again.remove_custom(pid))
    assert pid not in again.definitions and pid not in again.serialize_configs() and pid not in keys
    with pytest.raises(KeyError):
        asyncio.run(again.remove_custom("chatgpt"))  # built-in providers cannot be removed


def test_add_custom_rejects_bad_input_and_enforces_limit(keys):
    reg = ProviderRegistry({})
    with pytest.raises(ValueError):
        reg.add_custom("   ", "http://localhost:1234/v1")
    with pytest.raises(ValueError):
        reg.add_custom("x", "not a url")
    for i in range(MAX_CUSTOM_PROVIDERS):
        reg.add_custom(f"m{i}", "http://localhost:1234/v1")
    with pytest.raises(ValueError):
        reg.add_custom("one too many", "http://localhost:1234/v1")


def test_settings_with_a_forged_id_are_ignored(keys):
    reg = ProviderRegistry({"custom-../evil": {"base_url": "http://x/v1"}, "nonsense": {"base_url": "http://x/v1"}})
    assert set(reg.definitions) == set(ProviderRegistry({}).definitions)


def test_builtin_providers_still_need_a_key(keys):
    reg = ProviderRegistry({})
    assert reg.info("chatgpt")["status"] == "not_configured" and reg.info("gemini")["status"] == "not_configured"
    # The built-in local entry needs no key, only a model.
    assert reg.info("custom")["status"] == "needs_model" and reg.info("custom")["key_required"] is False


# ------------------------------------------------------------------ choosing a model for the user
def test_free_providers_come_first_and_are_marked():
    ids = list(DEFINITIONS)
    free = ["gemini", "groq", "openrouter", "kilo", "pollinations", "sambanova", "nvidia", "zai"]
    assert ids[:len(free)] == free and all(DEFINITIONS[i].free_tier for i in free)
    assert not any(DEFINITIONS[i].free_tier for i in ids[len(free):])
    info = ProviderRegistry({}).info("gemini")
    assert info["free_tier"] is True and info["keys_url"].startswith("https://")
    assert not {"prefer", "free_models", "free_by_list"} & set(info)  # selection rules stay in the engine
    for d in DEFINITIONS.values():
        assert d.default_base_url is None or d.default_base_url.startswith("https://") or d.id == "custom"


def test_non_chat_models_are_not_offered():
    listed = ["whisper-large-v3", "openai/gpt-oss-120b", "canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-86m",
              "openai/gpt-oss-safeguard-20b", "qwen/qwen3.8-27b", "text-embedding-3-small", "models/gemini-3.8-flash-preview-tts",
              "models/gemini-3.8-flash", "models/imagen-5", "models/gemini-3.8-flash-live", "gpt-realtime", "dall-e-3"]
    assert chat_models("groq", listed) == ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "models/gemini-3.8-flash"]
    assert chat_models("x", ["whisper-1"]) == ["whisper-1"]  # never an empty list when the server has models


def test_openrouter_lists_free_models_first():
    listed = ["anthropic/claude-opus", "google/gemma-4-31b-it:free", "openrouter/free", "openai/gpt-5", "nvidia/nemotron:free"]
    assert chat_models("openrouter", listed)[:3] == ["openrouter/free", "google/gemma-4-31b-it:free", "nvidia/nemotron:free"]
    assert recommend_model(DEFINITIONS["openrouter"], listed) == "openrouter/free"
    assert recommend_model(DEFINITIONS["openrouter"], ["a/b:free", "c/d"]) == "a/b:free"


def test_recommended_model_is_taken_from_the_provider_list_not_hard_coded():
    gemini = ["models/gemini-3.5-flash-lite", "models/gemini-3.8-flash", "models/gemini-4-hydrogen", "models/gemini-3.9-flash-preview",
              "models/gemini-3.1-pro-preview", "models/gemini-embedding-2"]
    assert recommend_model(DEFINITIONS["gemini"], gemini) == "models/gemini-3.8-flash"  # newest stable flash, not the preview
    assert recommend_model(DEFINITIONS["gemini"], ["models/gemini-5-ultra"]) == "models/gemini-5-ultra"  # the line-up changed: still a Gemini model
    groq = ["llama-3.3-70b-versatile", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "whisper-large-v3"]
    assert recommend_model(DEFINITIONS["groq"], groq) == "openai/gpt-oss-120b"
    assert recommend_model(DEFINITIONS["groq"], ["some/new-model", "another/one"]) is None  # nothing familiar: the user chooses
    assert recommend_model(DEFINITIONS["chatgpt"], ["gpt-5", "gpt-5.5", "gpt-5.5-mini", "gpt-5.5-2026-03-01", "o9"]) == "gpt-5.5"
    assert recommend_model(DEFINITIONS["custom"], ["llama3.2:latest", "qwen2.5"]) == "llama3.2:latest"  # local server: its first model
    assert recommend_model(DEFINITIONS["groq"], []) is None


def test_connecting_keeps_a_model_the_user_already_chose(keys):
    reg = ProviderRegistry({"groq": {"model": "qwen/qwen3.8-27b"}})
    assert reg.remember_models("groq", ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "whisper-large-v3"]) == "qwen/qwen3.8-27b"
    assert reg.configs["groq"].known_models == ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]
    assert reg.remember_models("claude", ["claude-x"]) == DEFINITIONS["claude"].default_model


# ------------------------------------------------------------------ adapter
def test_keyless_adapter_sends_no_authorization_header():
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json={"data": [{"id": "llama3.2"}, {"id": "qwen2.5"}]})

    async def go(key, require):
        a = OpenAICompatibleAdapter("custom-aaaaaaaa", "Local", "http://localhost:11434/v1", key, False, None, require_key=require)
        await a.initialize()
        assert a._client is not None
        headers = dict(a._client.headers)
        await a._client.aclose()
        a._client = httpx.AsyncClient(base_url=a.base_url, headers=headers, transport=httpx.MockTransport(handler))
        models = await a.list_models()
        await a.dispose()
        return models

    assert asyncio.run(go(None, False)) == ["llama3.2", "qwen2.5"] and seen["auth"] is None
    assert asyncio.run(go("sk-abc", False)) and seen["auth"] == "Bearer sk-abc"
    with pytest.raises(ProviderError):
        asyncio.run(go(None, True))  # built-in cloud providers still refuse to run without a key


# ------------------------------------------------------------------ API
def test_api_add_configure_remove(client, keys):
    before = [p["id"] for p in client.get("/api/providers").json()]
    r = client.post("/api/providers/custom", json={"name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1", "api_key": "sk-or-123456789", "model": "meta/llama"})
    assert r.status_code == 200, r.text
    p = r.json()
    pid = p["id"]
    assert is_user_defined(pid) and p["user_defined"] and p["status"] == "ready" and p["has_api_key"] and p["api_key_hint"] == "…6789"
    assert "sk-or-123456789" not in r.text and keys[pid] == "sk-or-123456789"  # the key is stored, never returned
    assert [x["id"] for x in client.get("/api/providers").json()] == before + [pid]

    r = client.put(f"/api/providers/{pid}/config", json={"display_name": "My router", "base_url": "https://openrouter.ai/api/v1/"})
    assert r.json()["name"] == "My router" and r.json()["config"]["base_url"] == "https://openrouter.ai/api/v1"
    assert client.put(f"/api/providers/{pid}/config", json={"base_url": "javascript:alert(1)"}).status_code == 400

    assert client.delete("/api/providers/chatgpt").status_code == 404
    assert client.delete("/api/providers/custom").status_code == 404  # the built-in entry stays
    assert client.delete(f"/api/providers/{pid}").status_code == 200
    assert [x["id"] for x in client.get("/api/providers").json()] == before and pid not in keys
    assert client.delete(f"/api/providers/{pid}").status_code == 404
    assert client.put(f"/api/providers/{pid}/config", json={"model": "x"}).status_code == 404


def test_api_rejects_invalid_custom_models(client):
    assert client.post("/api/providers/custom", json={"name": "x", "base_url": "localhost:11434"}).status_code == 400
    assert client.post("/api/providers/custom", json={"name": "", "base_url": "http://localhost:1/v1"}).status_code == 422
    assert client.post("/api/providers/custom", json={"name": "x", "base_url": "https://u:p@host/v1"}).status_code == 400


def test_custom_models_survive_an_engine_restart(client, keys):
    pid = client.post("/api/providers/custom", json={"name": "LM Studio", "base_url": "http://localhost:1234/v1"}).json()["id"]
    paths: AppPaths = client.paths  # type: ignore[attr-defined]
    svc = SessionService(paths, Database(paths.database), EventHub())
    assert pid in svc.providers.definitions and svc.providers.info(pid)["name"] == "LM Studio"
    assert svc.providers.info(pid)["status"] == "needs_model"


# ------------------------------------------------------------------ a real local OpenAI-compatible server
class _FakeServer(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible server (what Ollama or LM Studio expose), without authentication."""

    seen: list[dict] = []
    reject_usage_option = False  # behave like a strict server that rejects unknown request fields

    def log_message(self, *args):  # silence
        pass

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        _FakeServer.seen.append({"path": self.path, "auth": self.headers.get("Authorization")})
        if self.path == "/v1/models":
            self._send(200, json.dumps({"data": [{"id": "local-model"}]}).encode(), "application/json")
        else:
            self._send(404, b"{}", "application/json")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        _FakeServer.seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        if _FakeServer.reject_usage_option and "stream_options" in body:
            return self._send(400, json.dumps({"error": {"message": "Extra inputs are not permitted: stream_options"}}).encode(), "application/json")
        chunks = ["A lock ", "is ", "pessimistic."]
        out = "".join(f"data: {json.dumps({'choices': [{'delta': {'content': c}}]})}\n\n" for c in chunks) + "data: [DONE]\n\n"
        self._send(200, out.encode(), "text/event-stream")


@pytest.mark.parametrize("strict", [False, True])
def test_keyless_custom_model_against_a_real_local_server(client, strict):
    _FakeServer.seen.clear()
    _FakeServer.reject_usage_option = strict
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_address[1]}/v1"
        pid = client.post("/api/providers/custom", json={"name": "Local server", "base_url": base}).json()["id"]
        test = client.post(f"/api/providers/{pid}/test").json()
        # "Connect" is one step: the model list is fetched and a model is chosen.
        assert test["ok"] and test["models"] == ["local-model"] and test["model"] == "local-model", test
        info = next(p for p in client.get("/api/providers").json() if p["id"] == pid)
        assert info["status"] == "ready" and info["model"] == "local-model"

        sid = client.post("/api/sessions", json={"name": "custom model"}).json()["id"]
        with client.websocket_connect("/ws", subprotocols=["zhu.v1", f"bearer.{TOKEN}"], headers={"host": f"127.0.0.1:{PORT}"}) as ws:
            ws.send_json({"type": "hello", "last_seq": 0})
            assert ws.receive_json()["type"] == "hello.ack"
            r = client.post(f"/api/providers/{pid}/submit", json={"session_id": sid, "prompt": "What is pessimistic locking?", "system": "Answer in one sentence."})
            assert r.status_code == 200, r.text
            text, done = "", False
            for _ in range(200):
                msg = ws.receive_json()
                if msg.get("event_type") == "provider.delta":
                    text += msg["data"]["text"]
                if msg.get("event_type") == "provider.completed":
                    done = True
                    break
                if msg.get("event_type") == "provider.error":
                    pytest.fail(str(msg["data"]))
        assert done and text == "A lock is pessimistic."
        chats = [x for x in _FakeServer.seen if x["path"] == "/v1/chat/completions"]
        # A strict server refuses the usage option once; the same question is then sent without it.
        assert len(chats) == (2 if strict else 1) and ("stream_options" in chats[-1]["body"]) is (not strict)
        chat = chats[-1]
        assert chat["auth"] is None and chat["body"]["model"] == "local-model"
        assert chat["body"]["messages"][0]["role"] == "system" and chat["body"]["messages"][0]["content"].endswith("Answer in one sentence.")
        assert chat["body"]["messages"][-1] == {"role": "user", "content": "What is pessimistic locking?"}
        stored = client.get(f"/api/sessions/{sid}/interactions").json()
        assert stored[-1]["provider_id"] == pid and stored[-1]["response"] == "A lock is pessimistic."
    finally:
        _FakeServer.reject_usage_option = False
        server.shutdown()
