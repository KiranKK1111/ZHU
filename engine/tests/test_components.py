"""Unit tests: event hub, providers (mocked transport), DSP, model selection, redaction, screenshots."""

from __future__ import annotations

import asyncio
import json
import math

import httpx
import numpy as np
import pytest

from zhu_engine.api.hub import EventHub
from zhu_engine.audio.preprocess import Preprocessor
from zhu_engine.providers.base import ImageAttachment, PromptRequest, ProviderError
from zhu_engine.providers.openai_compat import OpenAICompatibleAdapter
from zhu_engine.stt.models import select_model
from zhu_engine.system.logging_setup import redact


# ------------------------------------------------------------------ hub
def test_hub_sequence_replay_and_gap():
    async def go():
        hub = EventHub(ring_size=3)
        hub.bind_loop(asyncio.get_running_loop())
        for i in range(5):
            hub.publish("x", {"i": i})
        q, replay, gap = hub.subscribe(last_seq=3)
        assert [e["seq"] for e in replay] == [4, 5] and not gap
        _, replay2, gap2 = hub.subscribe(last_seq=1)  # seq 2 already evicted
        assert gap2
        hub.publish("y", {})
        assert (await q.get())["seq"] == 6

    asyncio.run(go())


def test_hub_drops_slow_subscriber():
    async def go():
        hub = EventHub(subscriber_queue=2)
        q, _, _ = hub.subscribe()
        for _ in range(5):
            hub.publish("x", {})
        assert q not in hub._subs

    asyncio.run(go())


# ------------------------------------------------------------------ providers
def _sse(chunks: list[str]) -> bytes:
    body = "".join(f"data: {json.dumps({'choices': [{'delta': {'content': c}}]})}\n\n" for c in chunks)
    body += f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 3, 'completion_tokens': 2}})}\n\ndata: [DONE]\n\n"
    return body.encode()


def _adapter(handler, images=True) -> OpenAICompatibleAdapter:
    a = OpenAICompatibleAdapter("chatgpt", "ChatGPT", "https://api.example/v1", "sk-test-key-123456", images, "model-x")
    a._client = httpx.AsyncClient(base_url=a.base_url, transport=httpx.MockTransport(handler))
    return a


def test_openai_compatible_streaming_and_images():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=_sse(["Hel", "lo"]), headers={"content-type": "text/event-stream"})

    async def go():
        a = _adapter(handler)
        req = PromptRequest("Explain", model="model-x")
        a.attach_images(req, [ImageAttachment("s1", "image/png", b"\x89PNG")])
        rid = a.submit_prompt(req)
        events = [e async for e in a.stream_response(rid)]
        return events

    events = asyncio.run(go())
    assert "".join(e.text for e in events if e.type == "delta") == "Hello"
    assert events[-1].type == "completed" and events[-1].usage["completion_tokens"] == 2
    content = seen["body"]["messages"][-1]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_rate_limit_maps_retry_after():
    def handler(req):
        return httpx.Response(429, json={"error": {"message": "quota"}}, headers={"retry-after": "12"})

    async def go():
        a = _adapter(handler)
        rid = a.submit_prompt(PromptRequest("x", model="m"))
        return [e async for e in a.stream_response(rid)]

    ev = asyncio.run(go())[-1]
    assert ev.type == "error" and ev.error.kind == "rate_limited" and ev.error.retry_after_s == 12.0


def test_images_rejected_when_unsupported():
    a = _adapter(lambda r: httpx.Response(200), images=False)
    with pytest.raises(ProviderError) as e:
        a.attach_images(PromptRequest("x", model="m"), [ImageAttachment("s", "image/png", b"x")])
    assert e.value.kind == "unsupported"


def test_cancel_request():
    def handler(req):
        return httpx.Response(200, content=_sse(["a"] * 50))

    async def go():
        a = _adapter(handler)
        rid = a.submit_prompt(PromptRequest("x", model="m"))
        out = []
        async for e in a.stream_response(rid):
            out.append(e)
            a.cancel_request(rid)
        return out

    out = asyncio.run(go())
    assert out[-1].type == "error" and out[-1].error.kind == "cancelled"


def test_anthropic_error_mapping():
    import anthropic

    from zhu_engine.providers.anthropic_adapter import _map_error

    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx.Response(429, headers={"retry-after": "7"}, request=req)
    err = _map_error(anthropic.RateLimitError("rate", response=resp, body=None))
    assert err.kind == "rate_limited" and err.retry_after_s == 7.0
    err = _map_error(anthropic.AuthenticationError("bad", response=httpx.Response(401, request=req), body=None))
    assert err.kind == "authentication"


def test_anthropic_message_shape_images_before_text():
    from zhu_engine.providers.anthropic_adapter import AnthropicAdapter

    a = AnthropicAdapter("k")
    req = PromptRequest("Describe", model="claude-opus-5-5", images=[ImageAttachment("s", "image/png", b"abc")])
    msgs = a._messages(req)
    assert msgs[-1]["content"][0]["type"] == "image" and msgs[-1]["content"][1] == {"type": "text", "text": "Describe"}


# ------------------------------------------------------------------ DSP
def test_highpass_matches_reference_iir():
    pre = Preprocessor(16_000, 1, noise_reduction=False)
    rng = np.random.default_rng(0)
    x = rng.standard_normal(2000).astype(np.float32)
    y = np.concatenate([pre.process(x[:700]), pre.process(x[700:])])
    a = pre._alpha
    ref = np.zeros_like(x, dtype=np.float64)
    px = py = 0.0
    for i, v in enumerate(x.astype(np.float64)):
        py = a * (py + v - px)
        px = v
        ref[i] = py
    assert np.max(np.abs(y - ref)) < 1e-4


def test_highpass_removes_dc_and_resamples():
    pre = Preprocessor(48_000, 2, noise_reduction=False)
    t = np.arange(48_000) / 48_000
    tone = 0.5 * np.sin(2 * math.pi * 440 * t) + 0.3  # with DC offset
    out = pre.process(np.stack([tone, tone], axis=1).astype(np.float32))
    # The streaming resampler holds back its filter delay (~21 ms) until the next block.
    assert 15_500 <= out.size <= 16_000
    assert abs(float(np.mean(out[4000:]))) < 0.01


# ------------------------------------------------------------------ model selection
def test_model_selection_ladder():
    installed = ["large-v3-turbo", "small"]
    s = select_model("large-v3-turbo", installed, True, 7800, 4096)
    assert (s.model, s.device, s.compute_type) == ("large-v3-turbo", "cuda", "float16")
    s = select_model("large-v3-turbo", installed, True, 2600, 4096)  # little VRAM free
    assert s.model == "large-v3-turbo" and s.compute_type == "int8_float16"
    s = select_model("large-v3-turbo", installed, True, 1600, 4096)  # 1600 - 768 reserve = 832 MB
    assert s.model == "small" and s.device == "cuda"
    s = select_model("large-v3-turbo", installed, True, 1200, 4096)  # 432 MB usable: nothing fits on GPU
    assert s.device == "cpu"
    s = select_model("large-v3-turbo", installed, False, None, 4096)
    assert s.device == "cpu" and s.model == "small"
    assert select_model("small", [], True, 8000, 4096) is None


# ------------------------------------------------------------------ redaction
@pytest.mark.parametrize("secret", ["sk-abcdefghijklmnopqrstuvwxyz", "sk-ant-api03-abcdefghijklmnop", "xai-abcdefghijklmnopqrstu"])
def test_log_redaction(secret):
    assert secret not in redact(f"calling with key {secret}")
    assert "[REDACTED]" in redact(f"Authorization: Bearer {'x' * 40}")


# ------------------------------------------------------------------ screenshots
def test_screenshot_store_and_crop(tmp_path):
    from PIL import Image

    from zhu_engine.capture.screenshots import ScreenshotStore, encode_for_provider

    store = ScreenshotStore(tmp_path, tmp_path / "t", tmp_path / "f")
    (tmp_path / "t").mkdir()
    (tmp_path / "f").mkdir()
    img = Image.new("RGB", (800, 600), (10, 20, 30))
    saved = store.save(img, "png")
    assert saved.width == 800 and (tmp_path / saved.file_name).exists() and (tmp_path / "t" / saved.thumb_name).exists()
    assert store.pixel_hash(img) == saved.sha256
    media, data = encode_for_provider(tmp_path / saved.file_name)
    assert media == "image/png" and data[:4] == b"\x89PNG"
