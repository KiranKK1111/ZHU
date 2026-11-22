"""Claude (Anthropic Messages API) adapter, using the official ``anthropic`` Python SDK.

* Streaming through ``client.beta.messages.stream``. The beta namespace is used
  only for the server-side refusal fallback (``fallbacks: "default"``), which
  routes a declined request to a fallback model inside the same call. It can be
  disabled in the provider configuration.
* Images are sent as base64 ``image`` content blocks placed before the text.
* Errors are mapped from the SDK's typed exceptions, most specific first.
"""

from __future__ import annotations

import asyncio
import base64
from typing import AsyncIterator, Optional

from .base import Capabilities, PromptRequest, ProviderAdapter, ProviderError, ProviderEvent

DEFAULT_MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class AnthropicAdapter(ProviderAdapter):
    id = "claude"
    name = "Claude"

    def __init__(self, api_key: Optional[str], effort: str = "medium", use_fallbacks: bool = True) -> None:
        super().__init__()
        self._api_key = api_key
        self._effort = effort
        self._use_fallbacks = use_fallbacks
        self._client = None

    async def initialize(self) -> None:
        if self._client is not None:
            return
        if not self._api_key:
            raise ProviderError("authentication", "No Anthropic API key is configured. Add one in Settings → Providers.")
        import anthropic

        self._client = anthropic.AsyncAnthropic(api_key=self._api_key, max_retries=2, timeout=600.0)

    def get_capabilities(self, model: Optional[str] = None) -> Capabilities:
        return Capabilities(text=True, images=True, streaming=True, model_selection=True, conversation_history=True, max_images=20)

    async def list_models(self) -> list[str]:
        await self.initialize()
        assert self._client is not None
        try:
            page = await self._client.models.list(limit=100)
            return [m.id for m in page.data]
        except Exception as exc:
            raise _map_error(exc) from exc

    async def validate_configuration(self) -> dict:
        try:
            models = await self.list_models()
            return {"ok": True, "message": f"Connected. {len(models)} models available.", "models": models}
        except ProviderError as exc:
            return {"ok": False, "message": exc.message, "models": [], "error": exc.to_dict()}

    def _messages(self, request: PromptRequest) -> list[dict]:
        messages: list[dict] = [{"role": t.role, "content": t.text} for t in request.history if t.text.strip()]
        content: list[dict] = [
            {"type": "image", "source": {"type": "base64", "media_type": img.media_type, "data": base64.standard_b64encode(img.data).decode("ascii")}}
            for img in request.images
        ]
        if request.prompt.strip():
            content.append({"type": "text", "text": request.prompt})
        messages.append({"role": "user", "content": content})
        return messages

    async def _stream(self, request: PromptRequest, cancel: asyncio.Event) -> AsyncIterator[ProviderEvent]:
        assert self._client is not None
        kwargs: dict = {
            "model": request.model or DEFAULT_MODEL,
            "max_tokens": request.max_tokens,
            "messages": self._messages(request),
            "output_config": {"effort": self._effort},
        }
        if request.system:
            kwargs["system"] = request.system
        if self._use_fallbacks:
            kwargs["betas"] = [FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        try:
            async with self._client.beta.messages.stream(**kwargs) as stream:
                async for event in stream:
                    if cancel.is_set():  # leaving the context manager closes the HTTP stream
                        raise ProviderError("cancelled", "Request cancelled.")
                    if event.type == "content_block_delta" and event.delta.type == "text_delta":
                        yield ProviderEvent("delta", text=event.delta.text)
                final = await stream.get_final_message()
        except ProviderError:
            raise
        except Exception as exc:
            raise _map_error(exc) from exc
        if final.stop_reason == "refusal":
            category = getattr(getattr(final, "stop_details", None), "category", None)
            raise ProviderError("refused", "Claude declined this request" + (f" ({category})." if category else "."))
        usage = {"input_tokens": final.usage.input_tokens, "output_tokens": final.usage.output_tokens, "stop_reason": final.stop_reason}
        yield ProviderEvent("completed", usage=usage, model=final.model)

    async def dispose(self) -> None:
        await super().dispose()
        if self._client is not None:
            await self._client.close()
            self._client = None


def _map_error(exc: Exception) -> ProviderError:
    import anthropic

    if isinstance(exc, anthropic.AuthenticationError):
        return ProviderError("authentication", "The Anthropic API key was rejected.", status=401)
    if isinstance(exc, anthropic.PermissionDeniedError):
        return ProviderError("permission", "This API key cannot use the requested model or feature.", status=403)
    if isinstance(exc, anthropic.NotFoundError):
        return ProviderError("not_found", "Model or endpoint not found. Pick another model.", status=404)
    if isinstance(exc, anthropic.RateLimitError):
        retry = exc.response.headers.get("retry-after") if exc.response is not None else None
        return ProviderError("rate_limited", "Anthropic rate limit reached.", retry_after_s=float(retry) if retry else None, status=429)
    if isinstance(exc, anthropic.BadRequestError):
        return ProviderError("invalid_request", f"Request rejected: {exc.message}", status=400)
    if isinstance(exc, anthropic.APIStatusError):
        return ProviderError("unavailable", f"Anthropic API error {exc.status_code}. Retry later.", status=exc.status_code)
    if isinstance(exc, anthropic.APIConnectionError):
        return ProviderError("network", "Network error contacting Anthropic. Check your connection.")
    return ProviderError("unavailable", str(exc))
