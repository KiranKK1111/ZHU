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
import uuid
from dataclasses import asdict, dataclass, field
from typing import AsyncIterator, Literal, Optional

MAX_IMAGE_BYTES = 5 * 1024 * 1024  # strictest common provider limit; larger images are re-encoded


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
            yield ProviderEvent("error", error=exc)
        finally:
            self._cancel.pop(request_id, None)

    def cancel_request(self, request_id: str) -> bool:
        ev = self._cancel.get(request_id)
        if ev is None:
            return False
        ev.set()
        return True

    async def dispose(self) -> None:  # noqa: B027
        for ev in self._cancel.values():
            ev.set()
