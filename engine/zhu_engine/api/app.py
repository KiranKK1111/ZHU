"""FastAPI application: authenticated REST routes plus the event WebSocket.

Security (see docs/SECURITY_PRIVACY.md):
* binds to 127.0.0.1 only (enforced by __main__);
* every route requires ``Authorization: Bearer <token>``; the WebSocket requires the
  ``bearer.<token>`` subprotocol; comparisons are constant time;
* the Host header must be the loopback address with our port (blocks DNS rebinding);
* CORS allows only the Tauri origins and the Vite dev server.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
import platform
import sys
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from .. import __version__
from ..capture.clipboard import copy_image
from ..capture.screenshots import list_monitors
from ..providers import credentials
from ..providers.registry import chat_models, is_user_defined, validate_base_url
from ..questions.types import QuestionState
from ..session import EngineError, SessionService
from ..resume import MAX_FILE_BYTES
from ..stt.models import CATALOG
from .serialize import question_to_dict, screenshot_to_dict

log = logging.getLogger(__name__)

ALLOWED_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420", "http://127.0.0.1:1420"]


# ------------------------------------------------------------------ request bodies
class SessionCreate(BaseModel):
    name: Optional[str] = Field(None, max_length=200)


class SessionPatch(BaseModel):
    name: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=100_000)


class ListenStart(BaseModel):
    session_id: str
    sources: Optional[list[Literal["microphone", "system"]]] = None


class TextBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=20_000)


class ManualQuestion(BaseModel):
    session_id: str
    text: str = Field(..., min_length=1, max_length=20_000)


class SaveBody(BaseModel):
    saved: bool = True


class MergeBody(BaseModel):
    question_ids: list[str] = Field(..., min_length=2, max_length=20)


class SplitBody(BaseModel):
    at: int = Field(..., ge=1)


class CaptureBody(BaseModel):
    mode: Literal["monitor", "all", "window"]
    monitor: Optional[int] = Field(None, ge=0)
    session_id: Optional[str] = None


class ProviderConfigBody(BaseModel):
    api_key: Optional[str] = Field(None, max_length=500)
    enabled: Optional[bool] = None
    model: Optional[str] = Field(None, max_length=200)
    base_url: Optional[str] = Field(None, max_length=500)
    images: Optional[bool] = None
    effort: Optional[Literal["low", "medium", "high", "xhigh", "max"]] = None
    use_fallbacks: Optional[bool] = None
    display_name: Optional[str] = Field(None, max_length=60)
    include_history: Optional[bool] = None


class CustomProviderBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    base_url: str = Field(min_length=1, max_length=500)
    model: Optional[str] = Field(None, max_length=200)
    api_key: Optional[str] = Field(None, max_length=500)
    images: bool = False


class SubmitBody(BaseModel):
    session_id: Optional[str] = None
    prompt: str = Field("", max_length=100_000)
    screenshot_ids: list[str] = Field(default_factory=list, max_length=20)
    model: Optional[str] = None
    # The user's own guidance for answers ("Answer briefly, as in an interview"), added to the system prompt.
    system: Optional[str] = Field(None, max_length=2000)


class ChatCreateBody(BaseModel):
    title: Optional[str] = Field(None, max_length=200)


class ChatRenameBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ChatSendBody(BaseModel):
    provider_id: str = Field(min_length=1, max_length=64)
    model: Optional[str] = Field(None, max_length=200)
    content: str = Field("", max_length=100_000)
    # Answer the conversation's last message again (with this provider and model) instead of adding one.
    regenerate: bool = False
    screenshot_ids: list[str] = Field(default_factory=list, max_length=10)


class ResumeEnableBody(BaseModel):
    enabled: bool


class VocabularyBody(BaseModel):
    terms: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)


class PurgeBody(BaseModel):
    confirm: Literal["DELETE"]


def create_app(service: SessionService, token: str, port_ref: dict) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await service.start()
        yield
        await service.shutdown()

    app = FastAPI(title="ZHU Engine", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                       allow_headers=["Authorization", "Content-Type"], allow_credentials=False, max_age=600)

    def host_ok(host: Optional[str]) -> bool:
        port = port_ref.get("port")
        return host in (f"127.0.0.1:{port}", f"localhost:{port}")

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if request.method == "OPTIONS":
            return await call_next(request)
        if not host_ok(request.headers.get("host")):
            return JSONResponse({"detail": "forbidden host"}, status_code=403)
        auth = request.headers.get("authorization", "")
        if not (auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].encode(), token.encode())):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return await call_next(request)

    @app.exception_handler(EngineError)
    async def engine_error(_: Request, exc: EngineError):
        return JSONResponse({"detail": exc.message}, status_code=exc.status)

    s = service

    def svc() -> SessionService:
        return s

    # ------------------------------------------------------------------ system
    @app.get("/api/health")
    async def health():
        return {"status": "ok", "version": __version__, "instance": s.hub.instance_id}

    @app.get("/api/system/gpu")
    async def gpu():
        return (await asyncio.to_thread(s.gpu.info)).to_dict()

    @app.get("/api/system/diagnostics")
    async def diagnostics():
        import ctranslate2
        import faster_whisper
        import onnxruntime

        return {
            "engine_version": __version__,
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "frozen": bool(getattr(sys, "frozen", False)),
            "ctranslate2": ctranslate2.__version__,
            "faster_whisper": faster_whisper.__version__,
            "onnxruntime": onnxruntime.__version__,
            "schema_version": s.db.schema_version(),
            "data_dir": str(s.paths.root),
            "listening": s.listening_status(),
            "gpu": (await asyncio.to_thread(s.gpu.info)).to_dict(),
            "event_seq": s.hub.seq,
        }

    # ------------------------------------------------------------------ settings
    @app.get("/api/settings")
    async def get_settings():
        return s.settings.model_dump()

    @app.put("/api/settings")
    async def put_settings(patch: dict[str, Any]):
        try:
            return s.update_settings(patch).model_dump()
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/vocabulary")
    async def get_vocab():
        return {"user_terms": s.db.list_vocabulary(), "builtin_count": len(s.vocab.entries)}

    @app.put("/api/vocabulary")
    async def put_vocab(body: VocabularyBody):
        s.set_vocabulary(body.terms)
        return {"user_terms": s.db.list_vocabulary()}

    # ------------------------------------------------------------------ audio + models
    @app.get("/api/audio/devices")
    async def devices():
        from ..audio.devices import list_devices

        try:
            return [d.to_dict() for d in await asyncio.to_thread(list_devices)]
        except Exception as exc:
            raise HTTPException(503, f"audio subsystem unavailable: {exc}") from exc

    @app.get("/api/models")
    async def models():
        return await asyncio.to_thread(s.models_status)

    @app.post("/api/models/{name}/download")
    async def download(name: str):
        try:
            return s.downloader.start(name).to_dict()
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/models/cancel")
    async def cancel_download():
        s.downloader.cancel()
        return {"ok": True}

    @app.delete("/api/models/{name}")
    async def remove_model(name: str):
        if name not in CATALOG:
            raise HTTPException(404, "unknown model")
        await s.remove_model(name)
        return await asyncio.to_thread(s.models_status)

    # ------------------------------------------------------------------ sessions
    @app.get("/api/sessions")
    async def sessions(query: str = "", sort: str = "recent", limit: int = 500, offset: int = 0):
        return s.db.list_sessions(query=query[:200], sort=sort, limit=min(limit, 2000), offset=max(0, offset))

    @app.post("/api/sessions")
    async def create_session(body: SessionCreate):
        return s.create_session(body.name)

    @app.get("/api/sessions/{sid}")
    async def get_session(sid: str):
        row = s.db.get_session(sid)
        if row is None:
            raise HTTPException(404, "session not found")
        return row

    @app.patch("/api/sessions/{sid}")
    async def patch_session(sid: str, body: SessionPatch):
        return s.update_session(sid, body.name, body.notes)

    @app.post("/api/sessions/{sid}/end")
    async def end_session(sid: str):
        return await s.end_session(sid)

    @app.delete("/api/sessions/{sid}")
    async def delete_session(sid: str):
        await s.delete_session(sid)
        return {"ok": True}

    @app.get("/api/sessions/{sid}/export")
    async def export(sid: str, format: Literal["md", "json"] = "md"):
        body, media = s.export_session(sid, format)
        name = f"zhu-session-{sid[-8:]}.{format}"
        return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/sessions/{sid}/transcript")
    async def transcript(sid: str):
        return s.db.list_segments(sid)

    @app.delete("/api/sessions/{sid}/transcript")
    async def transcript_clear(sid: str):
        """Delete everything transcribed in a session so far. Questions and answers are kept, and listening goes on."""
        if s.db.get_session(sid) is None:
            raise HTTPException(404, "session not found")
        removed = s.db.clear_transcript(sid)
        s.hub.publish("transcript.cleared", {"session_id": sid, "removed": removed}, sid)
        return {"ok": True, "removed": removed}

    @app.patch("/api/transcript/{row_id}")
    async def correct(row_id: int, body: TextBody):
        row = s.db.correct_segment(row_id, body.text)
        if row is None:
            raise HTTPException(404, "segment not found")
        s.hub.publish("transcript.corrected", row, row["session_id"])
        return row

    # ------------------------------------------------------------------ listening
    @app.get("/api/listening/status")
    async def listening_status():
        return s.listening_status()

    @app.post("/api/listening/start")
    async def listen_start(body: ListenStart):
        return await s.start_listening(body.session_id, body.sources)

    @app.post("/api/listening/pause")
    async def listen_pause():
        return await s.pause_listening()

    @app.post("/api/listening/resume")
    async def listen_resume():
        return await s.resume_listening()

    @app.post("/api/listening/stop")
    async def listen_stop():
        return await s.stop_listening()

    @app.post("/api/listening/restart-worker")
    async def restart_worker():
        return await s.restart_worker()

    # ------------------------------------------------------------------ questions
    @app.get("/api/sessions/{sid}/questions")
    async def questions(sid: str, include_discarded: bool = False):
        eng = s.engine_for(sid)
        live = [question_to_dict(q) for q in eng.questions.values() if include_discarded or q.state is not QuestionState.DISCARDED]
        return sorted(live, key=lambda q: q["started_at_ms"])

    @app.delete("/api/sessions/{sid}/questions")
    async def questions_clear(sid: str):
        """Remove every question of a session from the list. The transcript and the answers are kept."""
        if s.db.get_session(sid) is None:
            raise HTTPException(404, "session not found")
        return {"ok": True, "removed": len(s.question_action(sid, "discard_all"))}

    @app.get("/api/questions")
    async def all_questions(query: str = "", saved: bool = False, limit: int = 500):
        return [question_to_dict(q) for q in s.db.list_questions(None, saved_only=saved, query=query[:200], limit=min(limit, 5000))]

    @app.get("/api/questions/{qid}/history")
    async def question_history(qid: str):
        return s.db.question_history(qid)

    @app.post("/api/questions")
    async def manual_question(body: ManualQuestion):
        return s.question_action(body.session_id, "create_manual", body.text, s._session_clock_ms() if s.listening_session == body.session_id else 0)

    @app.patch("/api/questions/{qid}")
    async def edit_question(qid: str, body: TextBody):
        sid = s.find_question_session(qid)
        return s.question_action(sid, "edit_question", qid, body.text, s._session_clock_ms())

    @app.post("/api/questions/{qid}/save")
    async def save_question(qid: str, body: SaveBody):
        sid = s.find_question_session(qid)
        return s.question_action(sid, "set_saved", qid, body.saved)

    @app.post("/api/questions/merge")
    async def merge(body: MergeBody):
        sid = s.find_question_session(body.question_ids[0])
        return s.question_action(sid, "merge_questions", body.question_ids, s._session_clock_ms())

    @app.post("/api/questions/{qid}/split")
    async def split(qid: str, body: SplitBody):
        sid = s.find_question_session(qid)
        return s.question_action(sid, "split_question", qid, body.at, s._session_clock_ms())

    @app.delete("/api/questions/{qid}")
    async def discard(qid: str):
        sid = s.find_question_session(qid)
        return s.question_action(sid, "discard_question", qid)

    # ------------------------------------------------------------------ capture
    @app.get("/api/capture/monitors")
    async def monitors():
        return [m.to_dict() for m in await asyncio.to_thread(list_monitors)]

    @app.post("/api/capture")
    async def capture(body: CaptureBody):
        return await s.capture(body.mode, body.monitor, body.session_id)

    @app.get("/api/screenshots")
    async def screenshots(session_id: Optional[str] = None, limit: int = 500):
        return [screenshot_to_dict(r) for r in s.db.list_screenshots(session_id, min(limit, 5000))]

    def _shot(sid: str) -> dict:
        row = s.db.get_screenshot(sid)
        if row is None:
            raise HTTPException(404, "screenshot not found")
        return row

    @app.get("/api/screenshots/{sid}/image")
    async def screenshot_image(sid: str):
        row = _shot(sid)
        media = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp"}[row["format"]]
        return FileResponse(s.paths.screenshots / row["file_name"], media_type=media, headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/api/screenshots/{sid}/thumbnail")
    async def screenshot_thumb(sid: str):
        row = _shot(sid)
        return FileResponse(s.paths.thumbnails / row["thumb_name"], media_type="image/webp", headers={"Cache-Control": "private, max-age=86400"})

    @app.get("/api/screenshots/{sid}/path")
    async def screenshot_path(sid: str):
        return {"path": str(s.paths.screenshots / _shot(sid)["file_name"])}

    @app.post("/api/screenshots/{sid}/copy")
    async def screenshot_copy(sid: str):
        row = _shot(sid)
        try:
            await asyncio.to_thread(copy_image, s.paths.screenshots / row["file_name"])
        except Exception as exc:
            raise HTTPException(500, f"could not copy image: {exc}") from exc
        return {"ok": True}

    @app.delete("/api/screenshots/{sid}")
    async def screenshot_delete(sid: str):
        s.delete_screenshot(sid)
        return {"ok": True}

    # ------------------------------------------------------------------ providers
    @app.get("/api/providers")
    async def providers():
        return [s.providers.info(pid) for pid in s.providers.definitions]

    @app.post("/api/providers/custom")
    async def provider_add_custom(body: CustomProviderBody):
        """Add a user-defined OpenAI-compatible endpoint (a local server, a gateway, another vendor)."""
        try:
            pid = s.providers.add_custom(body.name, body.base_url, body.model, body.images)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if body.api_key and body.api_key.strip():
            credentials.set_api_key(pid, body.api_key)
        s.save_provider_configs()
        info = s.providers.info(pid)
        s.hub.publish("provider.updated", info)
        return info

    @app.delete("/api/providers/{pid}")
    async def provider_remove_custom(pid: str):
        if not is_user_defined(pid) or pid not in s.providers.definitions:
            raise HTTPException(404, "only custom models you added can be removed")
        await s.providers.remove_custom(pid)
        s.save_provider_configs()
        s.hub.publish("provider.updated", {"id": pid, "removed": True})
        return {"ok": True}

    @app.put("/api/providers/{pid}/config")
    async def provider_config(pid: str, body: ProviderConfigBody):
        if pid not in s.providers.definitions:
            raise HTTPException(404, "unknown provider")
        if body.base_url:
            try:
                body.base_url = validate_base_url(body.base_url)
            except ValueError as exc:
                raise HTTPException(400, str(exc))
        if body.api_key is not None:
            if body.api_key.strip():
                credentials.set_api_key(pid, body.api_key)
            else:
                credentials.delete_api_key(pid)
        cfg = s.providers.configs[pid]
        for field in ("enabled", "model", "base_url", "images", "effort", "use_fallbacks", "display_name", "include_history"):
            v = getattr(body, field)
            if v is not None:
                setattr(cfg, field, v if v != "" else None)
        s.save_provider_configs()
        await s.providers.reset_adapter(pid)
        info = s.providers.info(pid)
        s.hub.publish("provider.updated", info)
        return info

    @app.delete("/api/providers/{pid}/credential")
    async def provider_forget(pid: str):
        if pid not in s.providers.definitions:
            raise HTTPException(404, "unknown provider")
        credentials.delete_api_key(pid)
        await s.providers.reset_adapter(pid)
        info = s.providers.info(pid)
        s.hub.publish("provider.updated", info)
        return info

    @app.post("/api/providers/{pid}/test")
    async def provider_test(pid: str):
        """Connect: check the key against the provider, list its models, and choose one when none is set."""
        if pid not in s.providers.definitions:
            raise HTTPException(404, "unknown provider")
        result = await s.providers.adapter(pid).validate_configuration()
        entries = result.pop("entries", None)  # the raw list (with prices) stays in the engine
        if result.get("ok"):
            result["model"] = s.providers.remember_models(pid, result["models"], entries)
            cfg = s.providers.configs[pid]
            # The stored list is capped (gateways list hundreds of models); the count says how many there are.
            result["model_count"] = len(chat_models(pid, result["models"]))
            result["models"], result["free_models"], result["free_basis"] = cfg.known_models, cfg.free_models, cfg.free_basis
            s.save_provider_configs()
            await s.providers.reset_adapter(pid)
            s.hub.publish("provider.updated", s.providers.info(pid))
        return result

    @app.post("/api/providers/{pid}/submit")
    async def provider_submit(pid: str, body: SubmitBody):
        return await s.submit_prompt(pid, body.session_id, body.prompt, body.screenshot_ids, body.model, body.system)

    @app.post("/api/requests/{rid}/cancel")
    async def cancel(rid: str):
        return {"cancelled": s.cancel_request(rid)}

    @app.get("/api/sessions/{sid}/interactions")
    async def interactions(sid: str):
        return s.db.list_interactions(sid)

    # ------------------------------------------------------------------ chat (the built-in chat tab)
    @app.get("/api/chats")
    async def chats(limit: int = Query(100, ge=1, le=500)):
        return s.db.list_chats(limit)

    @app.post("/api/chats")
    async def chat_create(body: ChatCreateBody):
        return s.chat_create(body.title)

    @app.get("/api/chats/{cid}")
    async def chat_get(cid: str):
        return {**s.chat_get(cid), "messages": s.db.list_chat_messages(cid)}

    @app.patch("/api/chats/{cid}")
    async def chat_rename(cid: str, body: ChatRenameBody):
        return s.chat_rename(cid, body.title)

    @app.delete("/api/chats/{cid}")
    async def chat_delete(cid: str):
        s.chat_delete(cid)
        return {"ok": True}

    @app.post("/api/chats/{cid}/messages")
    async def chat_send(cid: str, body: ChatSendBody):
        return await s.chat_send(cid, body.provider_id, body.model, body.content, body.regenerate, body.screenshot_ids)

    # ------------------------------------------------------------------ résumé
    @app.get("/api/resume")
    async def resume_get():
        return s.resume_info()

    @app.post("/api/resume")
    async def resume_upload(request: Request, file_name: str = Query(..., min_length=1, max_length=260)):
        """Upload a résumé: the request body is the file itself. Only its text is kept."""
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_FILE_BYTES:
            raise HTTPException(413, "The file is larger than 10 MB.")
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > MAX_FILE_BYTES:
                raise HTTPException(413, "The file is larger than 10 MB.")
        return await asyncio.to_thread(s.resume_set, file_name, bytes(data))

    @app.patch("/api/resume")
    async def resume_enable(body: ResumeEnableBody):
        return s.resume_enable(body.enabled)

    @app.delete("/api/resume")
    async def resume_delete():
        s.resume_delete()
        return {"ok": True}

    # ------------------------------------------------------------------ privacy
    @app.post("/api/data/purge")
    async def purge(_: PurgeBody):
        await s.purge_all()
        return {"ok": True}

    # ------------------------------------------------------------------ websocket
    @app.websocket("/ws")
    async def ws(websocket: WebSocket):
        if not host_ok(websocket.headers.get("host")):
            await websocket.close(code=4403)
            return
        origin = websocket.headers.get("origin")
        if origin and origin not in ALLOWED_ORIGINS:
            await websocket.close(code=4403)
            return
        protocols = [p.strip() for p in websocket.headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
        bearer = next((p[7:] for p in protocols if p.startswith("bearer.")), "")
        if not hmac.compare_digest(bearer.encode(), token.encode()):
            await websocket.close(code=4401)
            return
        await websocket.accept(subprotocol="zhu.v1" if "zhu.v1" in protocols else None)
        try:
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=10)
        except Exception:
            hello = {}
        last_seq = int(hello.get("last_seq") or 0) if isinstance(hello, dict) else 0
        if hello.get("instance") and hello.get("instance") != s.hub.instance_id:
            last_seq = 0  # different engine process: sequence numbers are not comparable
        q, replay, gap = s.hub.subscribe(last_seq)
        try:
            await websocket.send_json({"type": "hello.ack", "instance": s.hub.instance_id, "seq": s.hub.seq, "gap": gap,
                                       "listening": s.listening_status()})
            for env in replay:
                await websocket.send_json(env)
            receiver = asyncio.create_task(_drain(websocket))
            while True:
                getter = asyncio.create_task(q.get())
                done, _ = await asyncio.wait({getter, receiver}, return_when=asyncio.FIRST_COMPLETED)
                if receiver in done:
                    getter.cancel()
                    break
                await websocket.send_json(getter.result())
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            s.hub.unsubscribe(q)

    return app


async def _drain(websocket: WebSocket) -> None:
    """Consume client messages (pings); returns when the client disconnects."""
    try:
        while True:
            await websocket.receive_text()
    except Exception:
        return
