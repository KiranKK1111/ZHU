"""Provider abstraction (Master Prompt, section 9).

    ProviderAdapter
    ├── initialize()
    ├── get_capabilities()
    ├── validate_configuration()
    ├── submit_prompt()      -> request id
    ├── attach_images()      -> validated attachments
    ├── stream_response()    -> async iterator of ProviderEvent
    ├── cancel_request()
    └── dispose()

Capabilities are configured per provider and model, never assumed. The UI
disables any action whose capability is False.
"""

from __future__ import annotations

import abc
import asyncio
import json
import logging
import uuid
from dataclasses import asdict, dataclass, field
from typing import AsyncIterator, Literal, Optional

MAX_IMAGE_BYTES = 5 * 1024 * 1024  # strictest common provider limit; larger images are re-encoded

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Capabilities:
    text: bool = True
    images: bool = False
    streaming: bool = True
    model_selection: bool = True
    conversation_history: bool = True
    max_images: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class ImageAttachment:
    screenshot_id: str
    media_type: str  # image/png | image/jpeg | image/webp
    data: bytes


@dataclass
class ChatTurn:
    role: Literal["user", "assistant"]
    text: str


@dataclass
class PromptRequest:
    prompt: str
    model: str
    images: list[ImageAttachment] = field(default_factory=list)
    history: list[ChatTurn] = field(default_factory=list)
    system: Optional[str] = None
    max_tokens: int = 16000


@dataclass(frozen=True)
class ProviderEvent:
    # "reasoning" is a reasoning model's thinking, sent before its answer; consumers may ignore it.
    type: Literal["delta", "reasoning", "completed", "error"]
    text: str = ""
    error: Optional["ProviderError"] = None
    usage: Optional[dict] = None
    model: Optional[str] = None


class ProviderError(Exception):
    """kind: authentication | permission | rate_limited | invalid_request | not_found | unavailable | network | refused | cancelled | unsupported"""

    def __init__(self, kind: str, message: str, retry_after_s: Optional[float] = None, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.retry_after_s = retry_after_s
        self.status = status

    def to_dict(self) -> dict:
        return {"kind": self.kind, "message": self.message, "retry_after_s": self.retry_after_s, "status": self.status}


# Gateway wording that says no more than the status code itself.
_EMPTY_WORDS = {
    "bad gateway", "error", "gateway timeout", "internal error", "internal server error", "overloaded",
    "provider returned error", "request failed", "server error", "service unavailable", "unknown error", "upstream error",
}


def provider_words(*texts: object) -> str:
    """The first of the provider's own explanations that says something: one line, at most 200 characters."""
    for text in texts:
        if not isinstance(text, str):
            continue
        said = " ".join(text.split())
        if not said or said.startswith("<") or said.lower().rstrip(".!") in _EMPTY_WORDS:
            continue  # nothing, an HTML error page, or only the status in words
        return said if len(said) <= 200 else said[:199].rstrip() + "…"
    return ""


def error_details(payload: object) -> tuple[str, str]:
    """(what the provider said, which service behind a gateway failed) from an error body: OpenAI's
    ``{"error": {"message"}}``, OpenRouter's ``metadata.raw`` / ``metadata.provider_name``, or a
    plain ``{"message"}`` / ``{"detail"}``."""
    if not isinstance(payload, dict):
        return "", ""
    err = payload.get("error", payload)
    if isinstance(err, str):
        return provider_words(err), ""
    if not isinstance(err, dict):
        return "", ""
    meta = err.get("metadata") if isinstance(err.get("metadata"), dict) else {}
    upstream = meta.get("provider_name") if isinstance(meta.get("provider_name"), str) else ""
    raw = meta.get("raw")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            pass
    if isinstance(raw, dict):
        inner = raw.get("error", raw)
        raw = (inner.get("message") or inner.get("detail")) if isinstance(inner, dict) else inner
    said = provider_words(err.get("message"), raw, payload.get("message"), payload.get("detail"))
    return said, upstream


def server_failure(name: str, status: Optional[int], model: Optional[str] = None, said: str = "", upstream: str = "", attempts: int = 1) -> ProviderError:
    """A failure on the provider's side (HTTP 5xx, or an error reported in the middle of an answer), in
    plain words: what happened, to which model, what the provider said, and what to do."""
    the_model = f"The model {model}" if model else "The model"
    if status in (503, 529):
        what = f"{the_model} is overloaded or temporarily down at {name}"
    elif status == 502:
        what = f"{name} could not get an answer from {the_model[0].lower() + the_model[1:]}" + (f" (run by {upstream})" if upstream else "")
    elif status == 504:
        what = f"{the_model} took too long to answer at {name}"
    else:
        what = f"{name} ran into an error on its side" + (f" while asking {model}" if model else "")
    note = ", ".join(x for x in (f"HTTP {status}" if status else "", f"tried {attempts} times" if attempts > 1 else "") if x)
    text = what + (f" ({note})" if note else "") + "."
    if said:
        text += f" {name} says: “{said.rstrip('.')}”."
    if model and (model.endswith(":free") or model.endswith("/free")):
        text += " Free models are often busy at peak times."
    text += " Try again in a minute, or choose another model."
    return ProviderError("unavailable", text, status=status)


class ProviderAdapter(abc.ABC):
    id: str
    name: str

    def __init__(self) -> None:
        self._requests: dict[str, PromptRequest] = {}
        self._cancel: dict[str, asyncio.Event] = {}

    async def initialize(self) -> None:  # noqa: B027 - optional hook
        """Create clients. Called lazily before the first request."""

    @abc.abstractmethod
    def get_capabilities(self, model: Optional[str] = None) -> Capabilities: ...

    @abc.abstractmethod
    async def validate_configuration(self) -> dict:
        """Live check (e.g. list models). Returns {ok, message, models}."""

    async def list_models(self) -> list[str]:
        return []

    def attach_images(self, request: PromptRequest, images: list[ImageAttachment]) -> PromptRequest:
        caps = self.get_capabilities(request.model)
        if images and not caps.images:
            raise ProviderError("unsupported", f"{request.model or self.name} does not read images. Pick a model that does, or remove the screenshot.")
        if caps.max_images and len(images) > caps.max_images:
            raise ProviderError("invalid_request", f"{self.name} accepts at most {caps.max_images} images per prompt.")
        for img in images:
            if len(img.data) > MAX_IMAGE_BYTES:
                raise ProviderError("invalid_request", "An attachment exceeds 5 MB after compression.")
        request.images = list(images)
        return request

    def submit_prompt(self, request: PromptRequest) -> str:
        if not request.prompt.strip() and not request.images:
            raise ProviderError("invalid_request", "The prompt is empty.")
        if not request.prompt.strip() and not self.get_capabilities(request.model).images:
            raise ProviderError("unsupported", "Image-only prompts are not supported by this provider.")
        rid = "r_" + uuid.uuid4().hex[:16]
        self._requests[rid] = request
        self._cancel[rid] = asyncio.Event()
        return rid

    @abc.abstractmethod
    def _stream(self, request: PromptRequest, cancel: asyncio.Event) -> AsyncIterator[ProviderEvent]: ...

    async def stream_response(self, request_id: str) -> AsyncIterator[ProviderEvent]:
        request = self._requests.pop(request_id)
        cancel = self._cancel[request_id]
        try:
            await self.initialize()
            async for ev in self._stream(request, cancel):
                if cancel.is_set():
                    yield ProviderEvent("error", error=ProviderError("cancelled", "Request cancelled."))
                    return
                yield ev
        except ProviderError as exc:
            if exc.kind != "cancelled":
                # No prompt text: only what kind of failure, and the provider's message where it cannot
                # repeat the request (a rejected request's message may quote it).
                quoted = exc.kind in ("unavailable", "network", "not_found", "authentication", "permission", "rate_limited")
                log.warning("%s (%s) failed: %s, HTTP %s%s", self.id, request.model or "default model", exc.kind, exc.status,
                            f": {exc.message}" if quoted else "")
            yield ProviderEvent("error", error=exc)
        finally:
            self._cancel.pop(request_id, None)

    async def complete(self, request: PromptRequest) -> str:
        """One answer, whole: for ZHU's own one-off requests (the short resume profile). No request id,
        no events: nothing of it reaches the chat. A failure is raised as the ProviderError."""
        await self.initialize()
        parts: list[str] = []
        async for ev in self._stream(request, asyncio.Event()):
            if ev.type == "delta":
                parts.append(ev.text)
            elif ev.type == "error" and ev.error is not None:
                raise ev.error
        return "".join(parts)

    def cancel_request(self, request_id: str) -> bool:
        ev = self._cancel.get(request_id)
        if ev is None:
            return False
        ev.set()
        return True

    async def dispose(self) -> None:  # noqa: B027
        for ev in self._cancel.values():
            ev.set()
