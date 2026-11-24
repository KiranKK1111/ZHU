"""What the user is told when a model fails, and the quiet retries before that.

A local OpenAI-compatible server plays a gateway whose free model is busy: HTTP 503 with an
OpenRouter-shaped body, an HTML error page, or an error event in the middle of a stream.
"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from zhu_engine.providers import openai_compat
from zhu_engine.providers.base import PromptRequest, error_details, provider_words, server_failure
from zhu_engine.providers.openai_compat import OpenAICompatibleAdapter

MODEL = "nvidia/nemotron-3.5-super-vl:free"
BUSY = {"error": {"message": "Provider returned error", "code": 503,
                  "metadata": {"provider_name": "Nvidia", "raw": json.dumps({"error": {"message": "No instances available for this model"}})}}}


def _event(obj: dict) -> str:
    return f"data: {json.dumps(obj)}\n\n"


class _Gateway(BaseHTTPRequestHandler):
    """Answers each POST with the next scripted reply: (status, content type, body)."""

    replies: list[tuple[int, str, str]] = []
    calls = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        _Gateway.calls += 1
        status, ctype, body = _Gateway.replies.pop(0) if _Gateway.replies else (200, "text/event-stream", _event({"choices": [{"delta": {"content": "ok"}}]}) + "data: [DONE]\n\n")
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture()
def gateway(monkeypatch):
    monkeypatch.setattr(openai_compat, "RETRY_DELAYS", (0.01, 0.01))
    _Gateway.replies, _Gateway.calls = [], 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    finally:
        server.shutdown()


async def _ask(base: str) -> tuple[str, list]:
    adapter = OpenAICompatibleAdapter("kilo", "Kilo Gateway", base, None, False, MODEL, require_key=False)
    try:
        rid = adapter.submit_prompt(PromptRequest(prompt="Microservices or a monolith?", model=MODEL))
        events = [ev async for ev in adapter.stream_response(rid)]
    finally:
        await adapter.dispose()
    return "".join(ev.text for ev in events if ev.type == "delta"), [ev.error for ev in events if ev.type == "error"]


BUSY_REPLY = (503, "application/json", json.dumps(BUSY))


def test_a_busy_model_is_asked_again_quietly(gateway):
    _Gateway.replies = [BUSY_REPLY, BUSY_REPLY]
    text, errors = asyncio.run(_ask(gateway))
    assert (text, errors, _Gateway.calls) == ("ok", [], 3)


def test_a_model_that_stays_down_is_explained_in_plain_words(gateway):
    _Gateway.replies = [BUSY_REPLY] * 3
    text, errors = asyncio.run(_ask(gateway))
    assert text == "" and _Gateway.calls == 3 and len(errors) == 1
    err = errors[0]
    assert (err.kind, err.status) == ("unavailable", 503)
    assert err.message == (
        f"The model {MODEL} is overloaded or temporarily down at Kilo Gateway (HTTP 503, tried 3 times). "
        "Kilo Gateway says: “No instances available for this model”. "
        "Free models are often busy at peak times. Try again in a minute, or choose another model."
    )
    assert "Retry later" not in err.message


def test_an_html_error_page_is_not_quoted(gateway):
    page = (502, "text/html", "<html><body><h1>502 Bad Gateway</h1></body></html>")
    _Gateway.replies = [page] * 3
    _, [err] = asyncio.run(_ask(gateway))
    assert err.message.startswith(f"Kilo Gateway could not get an answer from the model {MODEL} (HTTP 502, tried 3 times).")
    assert "<" not in err.message and "says" not in err.message


def test_an_error_in_the_middle_of_the_stream_is_reported(gateway):
    failed = _event({"error": {"code": 502, "message": "Upstream timed out", "metadata": {"provider_name": "Nvidia"}}, "choices": [{"delta": {}, "finish_reason": "error"}]})
    # Before the first word: asked again. After words were shown: reported, never silently dropped.
    _Gateway.replies = [(200, "text/event-stream", failed)]
    text, errors = asyncio.run(_ask(gateway))
    assert (text, errors, _Gateway.calls) == ("ok", [], 2)

    _Gateway.calls = 0
    _Gateway.replies = [(200, "text/event-stream", _event({"choices": [{"delta": {"content": "Part of it"}}]}) + failed)]
    text, [err] = asyncio.run(_ask(gateway))
    assert text == "Part of it" and _Gateway.calls == 1
    assert err.message.startswith(f"Kilo Gateway could not get an answer from the model {MODEL} (run by Nvidia) (HTTP 502).")
    assert "“Upstream timed out”" in err.message


def test_client_errors_are_not_retried(gateway):
    _Gateway.replies = [(400, "application/json", json.dumps({"error": {"message": "max_tokens is too large"}}))] * 2
    _, [err] = asyncio.run(_ask(gateway))
    assert err.kind == "invalid_request" and err.message == "Kilo Gateway rejected the request (HTTP 400): max_tokens is too large"
    assert _Gateway.calls == 2  # the second one only without stream_options (see the adapter)


def test_no_server_is_a_connection_message():
    async def ask():
        return await _ask("http://127.0.0.1:9/v1")

    _, [err] = asyncio.run(ask())
    assert err.kind == "network" and err.message.startswith("Could not connect to Kilo Gateway.")


def test_what_the_provider_said():
    assert error_details(BUSY) == ("No instances available for this model", "Nvidia")
    assert error_details({"error": {"message": "The model is loading"}}) == ("The model is loading", "")
    assert error_details({"detail": "Model not ready"}) == ("Model not ready", "")
    assert error_details({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}) == ("", "")
    assert error_details("nonsense") == ("", "")
    assert provider_words("  Service   Unavailable. ", "<html>", "x" * 300) == "x" * 199 + "…"
    msg = server_failure("Anthropic", 529, "claude-opus-5-5").message
    assert msg == "The model claude-opus-5-5 is overloaded or temporarily down at Anthropic (HTTP 529). Try again in a minute, or choose another model."
    assert server_failure("Local", 500).message.startswith("Local ran into an error on its side (HTTP 500).")
