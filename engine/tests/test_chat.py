"""The built-in chat tab: free-model detection, conversations, streaming answers, and what is sent as context."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

from zhu_engine.api.app import create_app
from zhu_engine.api.hub import EventHub
from zhu_engine.providers.openai_compat import _model_entries
from zhu_engine.providers.registry import DEFINITIONS, ProviderRegistry, _custom_definition, detect_free_models, is_local_address, model_inputs, model_is_free, model_reads_images
from zhu_engine.session import CHAT_HISTORY_CHARS, SessionService, _chat_history, _chat_title
from zhu_engine.storage.db import Database
from zhu_engine.system.paths import AppPaths

TOKEN = "t" * 48
PORT = 50997


@pytest.fixture()
def keys(monkeypatch):
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


# ------------------------------------------------------------------ which models are free
@pytest.mark.parametrize(
    "entry, expected",
    [
        ({"id": "a/b", "pricing": {"prompt": "0", "completion": "0", "request": "0"}}, True),  # OpenRouter shape
        ({"id": "a/b", "pricing": {"prompt": "0.0000004", "completion": "0.000002"}}, False),
        ({"id": "router/auto", "pricing": {"prompt": "-1", "completion": "-1"}}, False),  # "varies" is not free
        ({"id": "a/b", "pricing": {"input": 0, "output": 0, "hourly": 3.5}}, True),  # only token prices count
        ({"id": "a/b", "pricing": {"input": 0.88, "output": 0.88}}, False),
        ({"id": "a/b", "metadata": {"pricing": {"input_tokens": 0.0, "output_tokens": 0.0}}}, True),
        ({"id": "a/b", "metadata": {"pricing": {"input_tokens": 0.03, "output_tokens": 0.05}}}, False),
        ({"id": "a/b", "input_token_price_per_m": 0, "output_token_price_per_m": 0}, True),
        ({"id": "a/b", "input_token_price_per_m": 1400, "output_token_price_per_m": 2800}, False),
        ({"id": "meta/llama-4:free"}, True),  # no prices: the id says so
        ({"id": "Llama-Vision-Free"}, True),
        ({"id": "freeform-model"}, None),  # "free" inside a word says nothing
        ({"id": "gpt-oss-120b"}, None),
        ({"id": "a/b", "pricing": {"prompt": "n/a"}}, None),  # unreadable price: unknown, never "free"
        ({"id": "a/b:free", "pricing": {"prompt": "0.001", "completion": "0.002"}}, False),  # a stated price beats the id
        ({"id": "stealth/cluster", "isFree": True, "pricing": {"prompt": "0", "completion": "0"}}, True),  # Kilo Gateway's flag
        ({"id": "a/b", "isFree": False}, False),
        ({"id": "a/b", "tags": ["reasoning", "free"], "pricing": {"input": "0.000001", "output": "0.000002"}}, True),  # a "free" tag
    ],
)
def test_model_is_free(entry, expected):
    assert model_is_free(entry) is expected


def test_local_addresses():
    for url in ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1", "http://192.168.1.20:8000/v1", "http://10.0.0.5/v1", "http://nas.local:1234/v1"]:
        assert is_local_address(url), url
    for url in ["https://openrouter.ai/api/v1", "https://8.8.8.8/v1", "https://localhost.example.com/v1", "", None]:
        assert not is_local_address(url), url


def test_detect_free_models_explains_its_basis():
    gateway = _custom_definition("custom-aaaaaaaa", "Gateway", "https://gateway.example/v1")
    priced = [{"id": "big/model", "pricing": {"prompt": "0.001", "completion": "0.002"}}, {"id": "small/model:free", "pricing": {"prompt": "0", "completion": "0"}},
              {"id": "whisper-large", "pricing": {"prompt": "0", "completion": "0"}}]
    # Prices in the list decide, and a free speech model is still not a chat model.
    assert detect_free_models(gateway, "https://gateway.example/v1", priced) == (["small/model:free"], "listed")
    # No prices and no markers: nothing can be said about a remote service...
    assert detect_free_models(gateway, "https://gateway.example/v1", [{"id": "m1"}, {"id": "m2"}]) == ([], "unknown")
    # ...but a server on this computer has no per-use price,
    assert detect_free_models(gateway, "http://localhost:11434/v1", [{"id": "m1"}, {"id": "m2"}]) == (["m1", "m2"], "local")
    # and a provider with a free tier offers all its chat models on it.
    assert detect_free_models(DEFINITIONS["groq"], None, [{"id": "llama-4"}, {"id": "whisper-large-v3"}]) == (["llama-4"], "free_tier")
    # OpenRouter has a free tier, but its list says which models that covers.
    assert detect_free_models(DEFINITIONS["openrouter"], None, priced) == (["small/model:free"], "listed")
    # SambaNova's list has prices, yet its free tier is the account's: every chat model is offered on it.
    assert detect_free_models(DEFINITIONS["sambanova"], None, priced[:1]) == (["big/model"], "free_tier")
    # Z.ai publishes no prices in its list; its documentation names the free models.
    glm = [{"id": m} for m in ["glm-5.3", "glm-5.3-flash", "glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash", "glm-4.7"]]
    assert detect_free_models(DEFINITIONS["zai"], None, glm) == (["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"], "listed")


def test_keyless_free_gateway_selects_a_free_model(keys):
    reg = ProviderRegistry({})
    entries = [{"id": "big/paid", "isFree": False, "pricing": {"prompt": "0.001", "completion": "0.002"}}, {"id": "small/one:free", "isFree": True},
               {"id": "kilo-auto/free", "isFree": True}, {"id": "stealth/cluster", "isFree": True}]
    assert reg.remember_models("kilo", [e["id"] for e in entries], entries) == "kilo-auto/free"
    cfg = reg.configs["kilo"]
    assert cfg.free_models == ["small/one:free", "kilo-auto/free", "stealth/cluster"] and cfg.known_models[-1] == "big/paid"
    assert reg.info("kilo")["status"] == "ready" and reg.info("kilo")["has_api_key"] is False


def test_model_list_shapes():
    assert [e["id"] for e in _model_entries({"data": [{"id": "b"}, {"id": "a", "pricing": {}}, {"object": "model"}]})] == ["a", "b"]
    assert [e["id"] for e in _model_entries({"models": [{"name": "models/x"}]})] == ["models/x"]
    assert [e["id"] for e in _model_entries(["m2", "m1", "m1", 7, None])] == ["m1", "m2"]
    assert _model_entries({"error": "nope"}) == [] and _model_entries("text") == [] and _model_entries({"data": "x"}) == []


def test_connecting_a_gateway_lists_free_models_first_and_selects_one(keys):
    reg = ProviderRegistry({})
    pid = reg.add_custom("Gateway", "https://gateway.example/v1")
    entries = [{"id": "alpha/paid", "pricing": {"prompt": "0.01", "completion": "0.02"}}, {"id": "beta/free-one", "pricing": {"prompt": "0", "completion": "0"}},
               {"id": "gamma/paid", "pricing": {"prompt": "0.01", "completion": "0.02"}}]
    chosen = reg.remember_models(pid, [e["id"] for e in entries], entries)
    cfg = reg.configs[pid]
    # Connecting must never select a model that costs money when a free one exists.
    assert chosen == "beta/free-one" and cfg.known_models == ["beta/free-one", "alpha/paid", "gamma/paid"]
    assert cfg.free_models == ["beta/free-one"] and cfg.free_basis == "listed"
    info = reg.info(pid)
    assert info["config"]["free_models"] == ["beta/free-one"] and "free_models" not in {k for k in info if k != "config"}
    # The result survives a restart.
    again = ProviderRegistry(reg.serialize_configs())
    assert again.info(pid)["config"]["free_basis"] == "listed"


@pytest.mark.parametrize("entry,expected", [
    ({"id": "a", "architecture": {"input_modalities": ["text", "image"]}}, True),
    ({"id": "a", "architecture": {"input_modalities": ["text"], "modality": "text->text"}}, False),
    ({"id": "a", "architecture": {"modality": "text+image->text"}}, True),
    ({"id": "a", "architecture": {"modality": "text->text+image"}}, False),  # makes images, does not read them
    ({"id": "a", "input_modalities": ["TEXT", "Image"]}, True),
    ({"id": "a", "architecture": {"input_modalities": []}}, None),
    ({"id": "a"}, None),
])
def test_model_reads_images(entry, expected):
    assert model_reads_images(entry) is expected


def test_model_inputs_lists_what_a_model_takes_besides_text():
    assert model_inputs({"id": "a", "architecture": {"input_modalities": ["text", "video", "file", "image", "audio"]}}) == ["image", "file", "audio", "video"]
    assert model_inputs({"id": "a", "architecture": {"modality": "text+image+audio->text"}}) == ["image", "audio"]
    assert model_inputs({"id": "a", "architecture": {"input_modalities": ["text"]}}) == []
    assert model_inputs({"id": "a", "pricing": {}}) is None


def test_a_gateway_reads_images_per_model(keys):
    # A gateway offers models that read images next to models that reject them (with "not found").
    reg = ProviderRegistry({"kilo": {"images": True}})
    entries = [{"id": "see/vl:free", "isFree": True, "architecture": {"input_modalities": ["text", "image"]}},
               {"id": "text/only:free", "isFree": True, "architecture": {"input_modalities": ["text"]}}]
    reg.remember_models("kilo", [e["id"] for e in entries], entries)
    assert reg.configs["kilo"].image_models == ["see/vl:free"]
    assert reg.configs["kilo"].model_inputs == {"see/vl:free": ["image"], "text/only:free": []}
    assert reg.info("kilo")["config"]["model_inputs"]["text/only:free"] == []
    # The list decides for the models it describes, whatever the provider's own switch says.
    assert reg.reads_images("kilo", "see/vl:free") and not reg.reads_images("kilo", "text/only:free")
    assert reg.reads_images("kilo", "not/listed")  # unknown model: the switch
    adapter = reg.adapter("kilo")
    assert adapter.get_capabilities("see/vl:free").images and not adapter.get_capabilities("text/only:free").images
    # The provider's entry describes its selected model.
    reg.configs["kilo"].model = "text/only:free"
    assert reg.info("kilo")["capabilities"]["images"] is False
    reg.configs["kilo"].images = None
    reg.configs["kilo"].model = "see/vl:free"
    assert reg.info("kilo")["capabilities"]["images"] is True and ProviderRegistry(reg.serialize_configs()).reads_images("kilo", "see/vl:free")


def test_a_model_list_without_modalities_leaves_the_switch_in_charge(keys):
    reg = ProviderRegistry({})
    reg.remember_models("groq", ["llama", "qwen"], [{"id": "llama"}, {"id": "qwen"}])
    assert reg.configs["groq"].image_models is None and not reg.reads_images("groq", "llama")
    reg.configs["groq"].images = True
    assert reg.reads_images("groq", "llama")


def test_providers_connected_before_free_models_were_recorded(keys):
    # Stored by an earlier version: a model list, but no free list. It is worked out from the ids.
    reg = ProviderRegistry({"openrouter": {"model": "x/y:free", "known_models": ["x/y:free", "a/paid"]}, "groq": {"model": "llama", "known_models": ["llama", "qwen"]}})
    assert reg.info("openrouter")["config"]["free_models"] == ["x/y:free"]
    assert reg.info("groq")["config"]["free_models"] == ["llama", "qwen"] and reg.info("groq")["config"]["free_basis"] == "free_tier"
    assert reg.info("chatgpt")["config"]["free_models"] == [] and reg.info("chatgpt")["config"]["free_basis"] is None


# ------------------------------------------------------------------ context
def _m(role, content, seq):
    return {"role": role, "content": content, "seq": seq}


def test_chat_history_alternates_and_fits():
    turns = _chat_history([_m("user", "q1", 1), _m("assistant", "a1", 2), _m("user", "q2 (answer failed)", 3), _m("assistant", "", 4), _m("user", "q3", 5), _m("assistant", "a3", 6)])
    # The question whose answer never arrived is dropped, so roles alternate.
    assert [(t.role, t.text) for t in turns] == [("user", "q1"), ("assistant", "a1"), ("user", "q3"), ("assistant", "a3")]
    # A trailing unanswered question is dropped too: the new message takes its place.
    assert [t.text for t in _chat_history([_m("user", "q1", 1), _m("assistant", "a1", 2), _m("user", "q2", 3)])] == ["q1", "a1"]
    big = "x" * (CHAT_HISTORY_CHARS // 2)
    kept = _chat_history([_m("user", "old", 1), _m("assistant", big, 2), _m("user", "mid", 3), _m("assistant", big, 4), _m("user", "new", 5), _m("assistant", "newest", 6)])
    # The oldest turns go first, and the context still starts with a user turn.
    assert [t.text for t in kept] == ["mid", big, "new", "newest"] and kept[0].role == "user"
    assert _chat_history([]) == []
    # A model's thinking is not sent back to it, and an answer that was only thinking counts as no answer.
    thought = _chat_history([_m("user", "q1", 1), _m("assistant", "<think>hmm\nlet me see</think>\n\nThe answer.", 2), _m("user", "q2", 3), _m("assistant", "<think>cut off", 4), _m("user", "q3", 5), _m("assistant", "a3", 6)])
    assert [t.text for t in thought] == ["q1", "The answer.", "q3", "a3"]


def test_chat_title():
    assert _chat_title("  Explain\n  the CAP   theorem ") == "Explain the CAP theorem"
    long = _chat_title("word " * 40)
    assert len(long) == 60 and long.endswith("\u2026")


# ------------------------------------------------------------------ a gateway-like server
class _Gateway(BaseHTTPRequestHandler):
    """An OpenAI-compatible gateway whose model list carries prices, as OpenRouter-style services do."""

    seen: list[dict] = []
    fail_with: int | None = None
    reasoning = False

    def log_message(self, *args):
        pass

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        models = [
            {"id": "vendor/paid-large", "pricing": {"prompt": "0.000003", "completion": "0.000015"}},
            {"id": "vendor/free-small", "pricing": {"prompt": "0", "completion": "0"}},
            {"id": "vendor/free-embed-embedding", "pricing": {"prompt": "0", "completion": "0"}},
        ]
        self._send(200 if self.path == "/v1/models" else 404, json.dumps({"data": models}).encode(), "application/json")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        _Gateway.seen.append(body)
        if _Gateway.fail_with:
            return self._send(_Gateway.fail_with, json.dumps({"error": {"message": "slow down"}}).encode(), "application/json")
        answer = f"Answer {sum(1 for m in body['messages'] if m['role'] == 'user')} from {body['model']}."
        deltas = [{"content": w + " "} for w in answer.split()]
        if _Gateway.reasoning:  # a reasoning model: thinking first, under either field name, then the answer
            deltas = [{"content": "", "reasoning": "Let me "}, {"reasoning_content": "think."}] + deltas
        out = "".join(f"data: {json.dumps({'choices': [{'delta': d}]})}\n\n" for d in deltas) + "data: [DONE]\n\n"
        self._send(200, out.encode(), "text/event-stream")


@pytest.fixture()
def gateway():
    _Gateway.seen.clear()
    _Gateway.fail_with = None
    _Gateway.reasoning = False
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    finally:
        _Gateway.fail_with = None
        server.shutdown()


def _ws(client):
    return client.websocket_connect("/ws", subprotocols=["zhu.v1", f"bearer.{TOKEN}"], headers={"host": f"127.0.0.1:{PORT}"})


def _stream(ws, mid: str) -> tuple[str, dict]:
    """Collect one answer: its text and the event that ended it."""
    text = ""
    for _ in range(400):
        msg = ws.receive_json()
        data = msg.get("data") or {}
        if data.get("message_id") != mid:
            continue
        if msg["event_type"] == "chat.delta":
            text += data["text"]
        elif msg["event_type"] in ("chat.completed", "chat.error"):
            return text, msg
    pytest.fail("the answer never finished")


def test_adding_a_provider_recognizes_its_free_models(client, gateway):
    pid = client.post("/api/providers/custom", json={"name": "Gateway", "base_url": gateway, "api_key": "sk-test-123456789"}).json()["id"]
    test = client.post(f"/api/providers/{pid}/test").json()
    assert test["ok"] and test["free_models"] == ["vendor/free-small"] and test["free_basis"] == "listed", test
    assert test["models"] == ["vendor/free-small", "vendor/paid-large"]  # free first; the embedding model is not offered
    assert test["model"] == "vendor/free-small" and "entries" not in test  # the free one is selected; raw entries stay in the engine
    assert test["model_count"] == 2
    info = next(p for p in client.get("/api/providers").json() if p["id"] == pid)
    assert info["status"] == "ready" and info["config"]["free_models"] == ["vendor/free-small"]


def test_chat_conversation_flow(client, gateway):
    pid = client.post("/api/providers/custom", json={"name": "Gateway", "base_url": gateway}).json()["id"]
    assert client.post(f"/api/providers/{pid}/test").json()["ok"]
    conv = client.post("/api/chats", json={}).json()
    cid = conv["id"]
    assert conv["title"] == "" and conv["message_count"] == 0

    with _ws(client) as ws:
        ws.send_json({"type": "hello", "last_seq": 0})
        assert ws.receive_json()["type"] == "hello.ack"

        # First turn: the model is given per message, and the conversation is titled from it.
        r = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/free-small", "content": "What is a mutex?\nBe brief."})
        assert r.status_code == 200, r.text
        first = r.json()
        assert first["conversation"]["title"] == "What is a mutex? Be brief." and first["conversation"]["streaming_request_id"] == first["request_id"]
        assert first["user_message"]["role"] == "user" and first["assistant_message"]["status"] == "streaming"
        text, end = _stream(ws, first["assistant_message"]["id"])
        assert end["event_type"] == "chat.completed" and text.strip() == "Answer 1 from vendor/free-small."

        # Second turn with another model: the whole conversation goes along as context.
        second = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/paid-large", "content": "And a semaphore?"}).json()
        text, end = _stream(ws, second["assistant_message"]["id"])
        assert end["event_type"] == "chat.completed" and text.strip() == "Answer 2 from vendor/paid-large."
        sent = _Gateway.seen[-1]["messages"]
        assert [m["role"] for m in sent] == ["system", "user", "assistant", "user"]
        assert sent[1]["content"] == "What is a mutex?\nBe brief." and sent[2]["content"].strip() == "Answer 1 from vendor/free-small." and sent[3]["content"] == "And a semaphore?"

        stored = client.get(f"/api/chats/{cid}").json()
        assert [(m["role"], m["status"]) for m in stored["messages"]] == [("user", "completed"), ("assistant", "completed")] * 2
        assert stored["messages"][3]["model"] == "vendor/paid-large" and stored["streaming_request_id"] is None and stored["title"] == "What is a mutex? Be brief."

        # Answer again: the last answer is replaced, the question is not repeated.
        again = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/free-small", "regenerate": True}).json()
        assert again["user_message"]["id"] == second["user_message"]["id"]
        text, end = _stream(ws, again["assistant_message"]["id"])
        assert text.strip() == "Answer 2 from vendor/free-small."
        messages = client.get(f"/api/chats/{cid}").json()["messages"]
        assert len(messages) == 4 and messages[3]["id"] == again["assistant_message"]["id"] and messages[3]["content"].strip() == "Answer 2 from vendor/free-small."

        # A provider error ends the answer as failed, with the provider's reason; the question stays.
        _Gateway.fail_with = 429
        failed = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/free-small", "content": "Third question"}).json()
        text, end = _stream(ws, failed["assistant_message"]["id"])
        assert end["event_type"] == "chat.error" and end["data"]["status"] == "failed" and end["data"]["error"]["kind"] == "rate_limited"
        last = client.get(f"/api/chats/{cid}").json()["messages"][-1]
        assert last["status"] == "failed" and last["error"]["kind"] == "rate_limited" and last["content"] == ""

        # Retrying after the provider recovers sends the question once, without the failed attempt.
        _Gateway.fail_with = None
        retry = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/free-small", "regenerate": True}).json()
        text, end = _stream(ws, retry["assistant_message"]["id"])
        assert end["event_type"] == "chat.completed" and text.strip() == "Answer 3 from vendor/free-small."
        assert [m["role"] for m in _Gateway.seen[-1]["messages"]] == ["system", "user", "assistant", "user", "assistant", "user"]
        assert len(client.get(f"/api/chats/{cid}").json()["messages"]) == 6

    listed = client.get("/api/chats").json()
    assert [c["id"] for c in listed] == [cid] and listed[0]["message_count"] == 6
    assert client.patch(f"/api/chats/{cid}", json={"title": "  Locks  "}).json()["title"] == "Locks"
    assert client.delete(f"/api/chats/{cid}").json()["ok"] and client.get("/api/chats").json() == []
    assert client.get(f"/api/chats/{cid}").status_code == 404


def test_reasoning_is_kept_apart_from_the_answer(client, gateway):
    pid = client.post("/api/providers/custom", json={"name": "Gateway", "base_url": gateway}).json()["id"]
    assert client.post(f"/api/providers/{pid}/test").json()["ok"]
    cid = client.post("/api/chats", json={}).json()["id"]
    _Gateway.reasoning = True
    with _ws(client) as ws:
        ws.send_json({"type": "hello", "last_seq": 0})
        assert ws.receive_json()["type"] == "hello.ack"
        first = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/free-small", "content": "Why?"}).json()
        text, end = _stream(ws, first["assistant_message"]["id"])
        # The thinking streams inside a <think> block, closed before the answer begins.
        assert end["event_type"] == "chat.completed" and text == "<think>Let me think.</think>\n\nAnswer 1 from vendor/free-small. "
        assert client.get(f"/api/chats/{cid}").json()["messages"][-1]["content"] == text
        second = client.post(f"/api/chats/{cid}/messages", json={"provider_id": pid, "model": "vendor/free-small", "content": "And then?"}).json()
        _stream(ws, second["assistant_message"]["id"])
    # The next turn carries the answer as context, without the thinking.
    assert [m["content"].strip() for m in _Gateway.seen[-1]["messages"][1:]] == ["Why?", "Answer 1 from vendor/free-small.", "And then?"]
    # The Home screen's answers (the other consumer of the adapter) are unaffected by thinking.
    sid = client.post("/api/sessions", json={"name": "s"}).json()["id"]
    assert client.post(f"/api/providers/{pid}/submit", json={"session_id": sid, "prompt": "Why?", "model": "vendor/free-small"}).status_code == 200


def test_chat_rejects_what_it_cannot_send(client, gateway):
    cid = client.post("/api/chats", json={"title": "Named"}).json()["id"]
    pid = client.post("/api/providers/custom", json={"name": "Gateway", "base_url": gateway}).json()["id"]
    send = lambda **body: client.post(f"/api/chats/{cid}/messages", json=body)  # noqa: E731
    assert send(provider_id="nope", content="hi").status_code == 404
    assert send(provider_id="chatgpt", content="hi").status_code == 409  # no key saved
    assert send(provider_id=pid, content="hi").status_code == 409  # no model chosen yet
    assert send(provider_id=pid, model="vendor/free-small", content="   ").status_code == 422
    assert send(provider_id=pid, model="vendor/free-small", regenerate=True).status_code == 409  # nothing to answer again
    assert client.post("/api/chats/ch_missing/messages", json={"provider_id": pid, "content": "hi"}).status_code == 404
    # None of the rejected requests left anything behind.
    assert client.get(f"/api/chats/{cid}").json()["messages"] == [] and _Gateway.seen == []


def test_chats_are_purged_and_interrupted_answers_are_closed(client, gateway):
    cid = client.post("/api/chats", json={}).json()["id"]
    paths: AppPaths = client.paths  # type: ignore[attr-defined]
    db = Database(paths.database)
    db.add_chat_message({"id": "cm_user", "conversation_id": cid, "role": "user", "content": "q", "status": "completed"})
    db.add_chat_message({"id": "cm_half", "conversation_id": cid, "role": "assistant", "content": "half an ans", "status": "streaming"})
    db.close()
    # The engine stopped mid-answer: on the next start the answer is closed, keeping what had arrived.
    svc = SessionService(paths, Database(paths.database), EventHub())
    half = svc.db.get_chat_message("cm_half")
    assert half["status"] == "cancelled" and half["content"] == "half an ans" and half["completed_at"]
    svc.db.close()
    assert client.post("/api/data/purge", json={"confirm": "DELETE"}).json()["ok"]
    assert client.get("/api/chats").json() == []
