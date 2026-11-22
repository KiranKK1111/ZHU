"""Adapters for providers that expose an OpenAI-compatible Chat Completions API:
OpenAI (ChatGPT models), DeepSeek, xAI (Grok), and user-configured custom endpoints
(any number of them; an API key is optional there, since local servers need none).

Implemented with httpx and server-sent events. Image support is a per-provider
configuration value (default from the provider definition), not an assumption.
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import AsyncIterator, Callable, Optional

import httpx

from .base import Capabilities, PromptRequest, ProviderAdapter, ProviderError, ProviderEvent


class OpenAICompatibleAdapter(ProviderAdapter):
    def __init__(self, provider_id: str, name: str, base_url: str, api_key: Optional[str], images: bool, default_model: Optional[str],
                 require_key: bool = True, reads_images: Optional[Callable[[Optional[str]], bool]] = None) -> None:
        super().__init__()
        # Per model, where the provider's model list says which models read images (see the registry).
        self._reads_images = reads_images
        self.id = provider_id
        self.name = name
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._require_key = require_key
        self._images = images
        self._default_model = default_model
        self._client: Optional[httpx.AsyncClient] = None
        self._usage_option = True  # send stream_options.include_usage until a server rejects it

    async def initialize(self) -> None:
        if self._client is not None:
            return
        if not self._api_key and self._require_key:
            raise ProviderError("authentication", f"No API key is saved for {self.name}. Add one in Settings.")
        if not self.base_url:
            raise ProviderError("invalid_request", f"No address is set for {self.name}. Add one in Settings.")
        # Custom endpoints (local servers such as Ollama) may need no key: send no Authorization header then.
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0),
        )

    def get_capabilities(self, model: Optional[str] = None) -> Capabilities:
        images = self._reads_images(model or self._default_model) if self._reads_images else self._images
        return Capabilities(text=True, images=images, streaming=True, model_selection=True, conversation_history=True, max_images=10 if images else 0)

    async def list_model_entries(self) -> list[dict]:
        """The provider's model list as it sends it (ids plus whatever else it states, such as prices), sorted by id."""
        await self.initialize()
        assert self._client is not None
        try:
            r = await self._client.get("/models")
        except httpx.HTTPError as exc:
            raise ProviderError("network", f"Network error contacting {self.name}: {exc}") from exc
        if r.status_code != 200:
            raise _http_error(self.name, r)
        try:
            payload = r.json()
        except ValueError as exc:
            raise ProviderError("invalid_request", f"{self.name} did not return a model list. Check the address.") from exc
        return _model_entries(payload)

    async def list_models(self) -> list[str]:
        return [e["id"] for e in await self.list_model_entries()]

    async def validate_configuration(self) -> dict:
        try:
            entries = await self.list_model_entries()
            return {"ok": True, "message": f"Connected. {len(entries)} models available.", "models": [e["id"] for e in entries], "entries": entries}
        except ProviderError as exc:
            return {"ok": False, "message": exc.message, "models": [], "error": exc.to_dict()}

    def _messages(self, request: PromptRequest) -> list[dict]:
        msgs: list[dict] = []
        if request.system:
            msgs.append({"role": "system", "content": request.system})
        msgs += [{"role": t.role, "content": t.text} for t in request.history if t.text.strip()]
        if request.images:
            parts: list[dict] = []
            if request.prompt.strip():
                parts.append({"type": "text", "text": request.prompt})
            for img in request.images:
                b64 = base64.b64encode(img.data).decode("ascii")
                parts.append({"type": "image_url", "image_url": {"url": f"data:{img.media_type};base64,{b64}"}})
            msgs.append({"role": "user", "content": parts})
        else:
            msgs.append({"role": "user", "content": request.prompt})
        return msgs

    async def _stream(self, request: PromptRequest, cancel: asyncio.Event) -> AsyncIterator[ProviderEvent]:
        assert self._client is not None
        model = request.model or self._default_model
        if not model:
            raise ProviderError("invalid_request", f"No model is selected for {self.name}. Press Connect in Settings.")
        body = {"model": model, "messages": self._messages(request), "stream": True}
        usage = None
        try:
            # Token usage is requested when the server accepts the option. Some OpenAI-compatible
            # servers reject unknown fields with HTTP 400/422; those get the same request without it.
            for with_usage in (self._usage_option, False):
                if with_usage:
                    body["stream_options"] = {"include_usage": True}
                else:
                    body.pop("stream_options", None)
                async with self._client.stream("POST", "/chat/completions", json=body) as r:
                    if r.status_code in (400, 422) and with_usage:
                        await r.aread()
                        self._usage_option = False
                        continue
                    if r.status_code != 200:
                        await r.aread()
                        raise _http_error(self.name, r)
                    async for event in self._read_stream(r, cancel):
                        if isinstance(event, dict):
                            usage = event
                        else:
                            yield event
                break
        except httpx.HTTPError as exc:
            raise ProviderError("network", f"Network error contacting {self.name}: {exc}") from exc
        yield ProviderEvent("completed", usage=usage, model=model)

    async def _read_stream(self, r: httpx.Response, cancel: asyncio.Event):
        """Read a server-sent-events response: yields delta events, and the usage report as a plain dict."""
        async for line in r.aiter_lines():
            if cancel.is_set():
                raise ProviderError("cancelled", "Request cancelled.")
            if not line.startswith("data:"):
                continue  # blank lines and SSE comments (keep-alives)
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if chunk.get("usage"):
                yield chunk["usage"]
            for choice in chunk.get("choices", []):
                delta = choice.get("delta") or {}
                # Reasoning models think first; servers name the field either way.
                thinking = delta.get("reasoning_content") or delta.get("reasoning")
                if isinstance(thinking, str) and thinking:
                    yield ProviderEvent("reasoning", text=thinking)
                if delta.get("content"):
                    yield ProviderEvent("delta", text=delta["content"])
                if choice.get("finish_reason") == "content_filter":
                    raise ProviderError("refused", f"{self.name} declined this request (content filter).")

    async def dispose(self) -> None:
        await super().dispose()
        if self._client is not None:
            await self._client.aclose()
            self._client = None


def _model_entries(payload) -> list[dict]:
    """Normalize a ``GET /models`` body: ``{"data": [...]}`` (OpenAI), ``{"models": [...]}`` or a bare list; items may be ids or objects."""
    items = payload if isinstance(payload, list) else (payload.get("data") or payload.get("models") or []) if isinstance(payload, dict) else []
    entries: dict[str, dict] = {}
    for item in items if isinstance(items, list) else []:
        entry = {"id": item} if isinstance(item, str) else item if isinstance(item, dict) else None
        if entry is None:
            continue
        mid = entry.get("id") or entry.get("name")
        if isinstance(mid, str) and mid.strip():
            entries.setdefault(mid, {**entry, "id": mid})
    return [entries[k] for k in sorted(entries)]


def _http_error(name: str, r: httpx.Response) -> ProviderError:
    try:
        detail = r.json().get("error", {})
        message = detail.get("message") if isinstance(detail, dict) else str(detail)
    except Exception:
        message = r.text[:300]
    status = r.status_code
    if status == 401:
        return ProviderError("authentication", f"{name} rejected the API key (or requires one).", status=status)
    if status == 403:
        return ProviderError("permission", f"{name}: access denied. {message or ''}".strip(), status=status)
    if status == 404:
        # The provider's own words say which it is (a gateway answers 404 for "no endpoint supports image input", too).
        said = " ".join(str(message or "").split())[:200]
        return ProviderError("not_found", f"{name}: model or endpoint not found." + (f" ({said})" if said else ""), status=status)
    if status == 429:
        retry = r.headers.get("retry-after")
        try:
            retry_s = float(retry) if retry else None
        except ValueError:
            retry_s = None
        return ProviderError("rate_limited", f"{name} rate limit or quota reached. {message or ''}".strip(), retry_after_s=retry_s, status=status)
    if 400 <= status < 500:
        return ProviderError("invalid_request", f"{name} rejected the request: {message}", status=status)
    return ProviderError("unavailable", f"{name} returned HTTP {status}. Retry later.", status=status)
