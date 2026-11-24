"""SessionService: the engine's composition root.

    SourceCapture (thread per source) -> Segmenter (VAD) -> Transcriber (single GPU worker)
        -> [event loop] QuestionEngine -> Database -> EventHub -> WebSocket clients

All mutable state is touched only on the asyncio loop thread. Worker threads hand
results over with ``loop.call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import sys
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import numpy as np

from .api.hub import EventHub
from .api.serialize import question_to_dict, screenshot_to_dict, segment_to_dict
from .capture.screenshots import ScreenshotStore, active_window_rect, encode_for_provider, grab_monitor, _grab
from .providers.base import ChatTurn, ImageAttachment, PromptRequest, ProviderError
from .providers.registry import ProviderRegistry
from . import resume as resume_file
from .profile import ProfileNotFound, ProfileStore
from .questions import AudioSource, QuestionEngine, QuestionEngineConfig, QuestionEvent, TechnicalVocabulary, TranscriptSegment
from .settings import EngineSettings, merge_settings
from .storage.db import Database, now_ms
from .stt.models import CATALOG, ModelDownloader, Selection, delete_model, installed_models, select_model
from .stt.transcriber import SttOptions, Transcriber
from .system.gpu import GpuMonitor
from .system.memory import host_memory, load_memory_problem
from .system.paths import AppPaths
from .vad.segmenter import Segmenter, SpeechSegment, VadConfig

log = logging.getLogger(__name__)
SR = 16_000


class EngineError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


class SessionService:
    def __init__(self, paths: AppPaths, db: Database, hub: EventHub) -> None:
        self.paths = paths
        self.db = db
        self.hub = hub
        self.profile = ProfileStore(db, lambda: self.hub.publish("resume.updated", {}), paths.resume)
        self._condensing: set[asyncio.Task] = set()
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.settings = EngineSettings.model_validate(db.get_setting("engine_settings", {}) or {})
        self.gpu = GpuMonitor()
        self.vocab = self._load_vocabulary()
        self.providers = ProviderRegistry(db.get_setting("providers", {}) or {})
        self.screens = ScreenshotStore(paths.screenshots, paths.thumbnails, paths.frozen)
        self.downloader = ModelDownloader(paths.models, self._on_download_progress)
        self._engines: "OrderedDict[str, QuestionEngine]" = OrderedDict()
        self._saved_relationships: dict[str, int] = {}
        # listening state
        self.state = "idle"  # idle | loading_model | listening | paused | error
        self.state_message: Optional[str] = None
        self.listening_session: Optional[str] = None
        self._session_t0_ms: int = 0
        self._captures: dict[str, object] = {}
        self._segmenters: dict[str, Segmenter] = {}
        self._open_segments: dict[str, dict] = {}  # source -> {"id", "rev", "last_partial", "seg"}
        self._source_status: dict[str, dict] = {}
        self._sources_lock = asyncio.Lock()  # one change of the sources listened to at a time
        self.transcriber: Optional[Transcriber] = None
        self.selection: Optional[Selection] = None
        self._listen_started_at: Optional[float] = None
        self._elapsed_before_ms = 0
        self._last_level_emit: dict[str, float] = {}
        self._tasks: list[asyncio.Task] = []
        self._requests: dict[str, tuple[str, asyncio.Task]] = {}
        self._unload_task: Optional[asyncio.Task] = None
        # Built-in chat: conversation id -> request id of the answer that is streaming there.
        self._chat_streams: dict[str, str] = {}
        db.interrupt_streaming_chat_messages()
        # Crash recovery: sessions left 'active' by an unexpected termination stay active, so the
        # user can resume them. Recording never resumes automatically; it needs an explicit Start.
        resumable = [r["id"] for r in db.list_sessions() if r["status"] == "active"]
        if resumable:
            log.info("%d session(s) left active by a previous run are resumable (recording stays off)", len(resumable))

    # ================================================================== lifecycle
    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.hub.bind_loop(self.loop)
        self._tasks.append(asyncio.create_task(self._ticker()))
        self._tasks.append(asyncio.create_task(self._telemetry()))
        self._apply_retention()

    async def shutdown(self) -> None:
        await self.stop_listening()
        for t in self._tasks:
            t.cancel()
        for _, task in list(self._requests.values()):
            task.cancel()
        await self.providers.dispose()
        self.db.close()

    # ================================================================== helpers
    def _load_vocabulary(self) -> TechnicalVocabulary:
        base = TechnicalVocabulary.load()
        user = self.db.list_vocabulary()
        return TechnicalVocabulary(TechnicalVocabulary.merge_user_entries(base.entries, user)) if user else base

    def _qcfg(self) -> QuestionEngineConfig:
        q = self.settings.questions
        return QuestionEngineConfig(short_pause_ms=q.short_pause_ms, base_pause_ms=q.base_pause_ms,
                                    extended_pause_ms=q.extended_pause_ms, max_completion_timeout_ms=q.max_completion_timeout_ms)

    def engine_for(self, session_id: str) -> QuestionEngine:
        eng = self._engines.get(session_id)
        if eng is None:
            if self.db.get_session(session_id) is None:
                raise EngineError("session not found", 404)
            sources = {AudioSource(s) for s in self.settings.audio.question_sources} | {AudioSource.MANUAL}
            eng = QuestionEngine(session_id, self.vocab, self._qcfg(), question_sources=sources)
            eng.restore(self.db.list_questions(session_id, include_discarded=False))
            self._saved_relationships[session_id] = len(eng.relationships)
            self._engines[session_id] = eng
            while len(self._engines) > 4:
                old, _ = self._engines.popitem(last=False)
                if old == self.listening_session:  # never evict the live engine
                    self._engines[old] = _
                    self._engines.move_to_end(old, last=False)
                    break
        else:
            self._engines.move_to_end(session_id)
        return eng

    def _label(self, source: str) -> str:
        return self.settings.audio.source_labels.get(source, source)

    def _session_clock_ms(self) -> int:
        """Wall-clock ms since the session started (used for manual actions)."""
        return int(time.time() * 1000) - self._session_t0_ms

    def _audio_clock_ms(self) -> int:
        """The clock transcript segments are stamped with: samples delivered by the capture
        sources. Question completion must use the same clock, or capture latency and
        loopback gaps would look like extra silence."""
        clocks = [c.samples_out for c in self._captures.values()]  # type: ignore[attr-defined]
        return max(clocks) * 1000 // SR if clocks else self._session_clock_ms()

    def _publish_questions(self, session_id: str, events: list[QuestionEvent], editor: str = "engine") -> None:
        for ev in events:
            self.db.save_question(ev.question, editor=editor)
            self.hub.publish(ev.event_type.value, question_to_dict(ev.question), session_id)
        eng = self._engines.get(session_id)
        if eng is not None:
            start = self._saved_relationships.get(session_id, 0)
            for rel in eng.relationships[start:]:
                if self.db.get_question(rel.from_question_id):
                    self.db.save_relationship(rel.from_question_id, rel.to_question_id, rel.type.value)
            self._saved_relationships[session_id] = len(eng.relationships)
        if events:
            self.db.touch_session(session_id)

    # ================================================================== sessions
    def create_session(self, name: Optional[str]) -> dict:
        sid = "sess_" + uuid.uuid4().hex[:12]
        name = (name or "").strip() or time.strftime("Session %b %d, %H:%M")
        row = self.db.create_session(sid, name[:200])
        self.hub.publish("session.created", row, sid)
        return row

    def update_session(self, sid: str, name: Optional[str], notes: Optional[str]) -> dict:
        row = self.db.update_session(sid, name=name.strip()[:200] if name else None, notes=notes)
        if row is None:
            raise EngineError("session not found", 404)
        self.hub.publish("session.updated", row, sid)
        return row

    async def end_session(self, sid: str) -> dict:
        if self.listening_session == sid:
            await self.stop_listening()
        row = self.db.end_session(sid)
        if row is None:
            raise EngineError("session not found", 404)
        self.hub.publish("session.updated", row, sid)
        return row

    async def delete_session(self, sid: str) -> None:
        if self.listening_session == sid:
            await self.stop_listening()
        shots = self.db.delete_session(sid)
        self._delete_screenshot_files(shots)
        self._engines.pop(sid, None)
        self.hub.publish("session.deleted", {"id": sid}, sid)

    def export_session(self, sid: str, fmt: str) -> tuple[str, str]:
        session = self.db.get_session(sid)
        if session is None:
            raise EngineError("session not found", 404)
        segments = self.db.list_segments(sid)
        questions = self.db.list_questions(sid)
        interactions = self.db.list_interactions(sid)
        if fmt == "json":
            payload = {"session": session, "transcript": segments, "questions": [question_to_dict(q) for q in questions],
                       "interactions": interactions, "exported_at": now_ms(), "format": "zhu-session-v1"}
            return json.dumps(payload, indent=2, ensure_ascii=False), "application/json"
        lines = [f"# {session['name']}", "", f"- Started: {time.strftime('%Y-%m-%d %H:%M', time.localtime(session['started_at'] / 1000))}"]
        if session.get("ended_at"):
            lines.append(f"- Duration: {(session['ended_at'] - session['started_at']) // 60000} min")
        if session.get("notes"):
            lines += ["", "## Notes", "", session["notes"]]
        lines += ["", "## Questions", ""]
        for i, q in enumerate(questions, 1):
            lines.append(f"{i}. **{q.display_text}**  _({q.category.value.replace('_', ' ').title()}, {_fmt_ts(q.started_at_ms)})_")
            for sq in q.subquestions:
                lines.append(f"    - {sq}")
        lines += ["", "## Transcript", ""]
        for s in segments:
            text = s.get("corrected_text") or s["text"]
            if text:
                lines.append(f"[{_fmt_ts(s['start_ms'])}] **{self._label(s['source'])}:** {text}")
        if interactions:
            lines += ["", "## Provider responses", ""]
            for it in interactions:
                lines += [f"### {self._provider_name(it['provider_id'])} ({it.get('model') or ''})", "",
                          f"> {it['prompt']}", "", it.get("response") or f"_{it['status']}_", ""]
        return "\n".join(lines) + "\n", "text/markdown"

    # ================================================================== listening
    def listening_status(self) -> dict:
        elapsed = self._elapsed_before_ms + (int((time.monotonic() - self._listen_started_at) * 1000) if self._listen_started_at else 0)
        sel = self.selection
        return {
            "state": self.state,
            "message": self.state_message,
            "session_id": self.listening_session,
            "elapsed_ms": elapsed,
            "sources": self._source_status,
            "model": sel.model if sel else None,
            "device": sel.device if sel else None,
            "compute_type": sel.compute_type if sel else None,
            "selection_reason": sel.reason if sel else None,
            "stats": self.transcriber.stats if self.transcriber else None,
            "question_state": {src: eng.window_state(AudioSource(src)).value for src in ("microphone", "system")
                               for eng in [self._engines.get(self.listening_session or "")] if eng} if self.listening_session else {},
        }

    def _emit_status(self) -> None:
        self.hub.publish("listening.status", self.listening_status(), self.listening_session)

    async def start_listening(self, session_id: str, sources: Optional[list[str]] = None) -> dict:
        if self.state in ("listening", "loading_model", "paused"):
            if self.listening_session == session_id:
                return self.listening_status()
            await self.stop_listening()
        session = self.db.get_session(session_id)
        if session is None:
            raise EngineError("session not found", 404)
        if session["status"] != "active":
            raise EngineError("this session has ended; start a new session to record")
        wanted = sources or self.chosen_sources()
        if not wanted:
            raise EngineError("Choose what to listen to (system audio, the microphone, or both): the button next to Start listening.")
        installed = installed_models(self.paths.models)
        if not installed:
            raise EngineError("No speech model is installed yet. Download one from the model setup screen.", 409)

        if self._unload_task is not None:
            self._unload_task.cancel()
            self._unload_task = None
        self.listening_session = session_id
        self._session_t0_ms = session["started_at"]
        self.engine_for(session_id)
        self.state, self.state_message = "loading_model", None
        self._emit_status()

        sel = await asyncio.to_thread(self._choose_model, installed)
        if sel is None:
            self.state, self.state_message = "error", "No installed model fits the configured device and VRAM budget."
            self._emit_status()
            raise EngineError(self.state_message, 409)
        if self.transcriber is None or self.selection != sel or self.transcriber.load_error:
            if self.transcriber:
                await asyncio.to_thread(self.transcriber.stop)
            self.selection = sel
            self.transcriber = Transcriber(self.paths.models, sel, self._stt_options(), self._on_stt_segment, self._on_stt_error)
            self.transcriber.start()
            await asyncio.to_thread(self.transcriber.ready.wait, 180)
            # Load fallback ladder. Allocation failures (VRAM *or* host RAM / commit charge, which
            # CTranslate2 can report as "CUDA out of memory") are retried with cheaper options:
            # same model INT8/FP16 -> smaller models on GPU -> CPU INT8.
            for fallback in self._fallback_ladder(sel, installed):
                if not self.transcriber.load_error:
                    break
                err = self.transcriber.load_error
                log.warning("model load failed (%s); retrying with %s/%s/%s", err, fallback.model, fallback.device, fallback.compute_type)
                await asyncio.to_thread(self.transcriber.stop)
                self.selection = Selection(fallback.model, fallback.device, fallback.compute_type, f"fallback after load error: {err[:120]}")
                self.transcriber = Transcriber(self.paths.models, self.selection, self._stt_options(), self._on_stt_segment, self._on_stt_error)
                self.transcriber.start()
                await asyncio.to_thread(self.transcriber.ready.wait, 180)
            if self.transcriber.load_error:
                from .system.memory import load_memory_problem

                hint = load_memory_problem(sel.model)
                self.state, self.state_message = "error", f"Speech model failed to load: {self.transcriber.load_error}" + (f" — {hint}" if hint else "")
                self._emit_status()
                raise EngineError(self.state_message, 500)

        offset = max(0, self._session_clock_ms()) * SR // 1000
        for src in wanted:
            self._start_source(src, offset)
        self.state, self.state_message = "listening", None
        self._listen_started_at = time.monotonic()
        self._elapsed_before_ms = 0
        if self.selection is not None and self.selection.device == "cpu":
            self.state_message = "Local transcription is running in CPU mode."
        self._emit_status()
        return self.listening_status()

    def chosen_sources(self) -> list[str]:
        """What Start listening listens to: system audio, the microphone, or both (Settings → Listening,
        and the button next to Start listening)."""
        audio = self.settings.audio
        return [s for s, on in (("microphone", audio.microphone_enabled), ("system", audio.system_enabled)) if on]

    def _start_source(self, src: str, offset: int, paused: bool = False) -> None:
        """Capture one source from ``offset`` (16 kHz samples on the session clock) and feed its speech in."""
        from .audio.capture import SourceCapture

        audio = self.settings.audio
        seg = Segmenter(src, VadConfig(**self.settings.vad.model_dump()), self._make_cb(src, "start"), self._make_cb(src, "audio"), self._make_cb(src, "end"))
        self._segmenters[src] = seg
        dev_id = audio.microphone_device if src == "microphone" else audio.system_device

        def on_block(block: np.ndarray, off: int, _seg=seg, _src=src) -> None:
            _seg.feed(block, off)
            self._maybe_emit_level(_src, block)

        cap = SourceCapture(src, dev_id, on_block, self._on_capture_status, noise_reduction=audio.noise_reduction)
        if paused:
            cap.pause()  # before it starts, so not a block of a paused session gets through
        self._captures[src] = cap
        self._source_status[src] = {"state": "starting", "device": None, "label": self._label(src), "message": None}
        cap.start(offset)

    async def apply_chosen_sources(self) -> dict:
        """While listening (or paused), listen to what is chosen now, without a new start: a source no
        longer chosen stops, after what it was saying is finished; a newly chosen one starts on the
        session's audio clock, so its transcript and the question timing line up with the others."""
        async with self._sources_lock:
            wanted = self.chosen_sources()
            if self.state not in ("listening", "paused") or not wanted:
                return self.listening_status()
            offset = self._audio_clock_ms() * SR // 1000
            # The new one first, then the old one stops: no gap, and the audio library is never
            # restarted in between (with no stream open it re-initializes, and a device opened in
            # that very moment fails once with "Invalid sample rate" and is retried).
            removed = [s for s in self._captures if s not in wanted]
            for src in wanted:
                if src not in self._captures:
                    self._start_source(src, offset, paused=self.state == "paused")
            for src in removed:
                cap = self._captures.pop(src, None)
                self._source_status.pop(src, None)
                if cap is not None:  # else Stop took it meanwhile
                    await asyncio.to_thread(cap.stop)  # type: ignore[attr-defined]
                seg = self._segmenters.pop(src, None)
                if seg is not None:
                    seg.flush()
            log.info("listening to: %s", ", ".join(sorted(self._captures)) or "nothing")
            self._emit_status()
            return self.listening_status()

    @staticmethod
    def _fallback_ladder(sel: Selection, installed: list[str]) -> list[Selection]:
        ladder: list[Selection] = []
        spec = CATALOG.get(sel.model)
        if spec is not None and spec.backend == "parakeet":
            # A DirectML load failure is almost always memory: the same model on the CPU (INT8)
            # needs about 1.3 GB instead of 3.3 GB. Whisper on the CPU is the last resort.
            if sel.device != "cpu":
                ladder.append(Selection(sel.model, "cpu", "int8", "fallback"))
            for m in ("small", "base"):
                if m in installed:
                    ladder.append(Selection(m, "cpu", "int8", "fallback"))
                    break
            return ladder
        if sel.device == "cuda":
            if sel.compute_type != "int8_float16":
                ladder.append(Selection(sel.model, "cuda", "int8_float16", "fallback"))
            for m in ("medium", "small", "base"):
                if m in installed and m != sel.model:
                    ladder.append(Selection(m, "cuda", "int8_float16", "fallback"))
        for m in ("small", "base", sel.model):
            if m in installed:
                ladder.append(Selection(m, "cpu", "int8", "fallback"))
                break
        return ladder

    def _choose_model(self, installed: list[str]) -> Optional[Selection]:
        from .stt.parakeet import directml_available

        info = self.gpu.info()
        t = self.settings.transcription
        mem = host_memory()
        return select_model(t.model, installed, info.cuda_available, info.vram_free_mb, t.vram_budget_mb,
                            device_pref=t.device, compute_pref=t.compute_type, cuda_compute_types=info.compute_types,
                            language=t.language, directml=directml_available(),
                            commit_free_mb=mem.commit_available_mb if mem else None)

    def _stt_options(self) -> SttOptions:
        t = self.settings.transcription
        beam = {"accuracy": 5, "balanced": 3, "latency": 1}[t.profile]
        hot = None
        if t.vocabulary_hints:
            hot = ", ".join(sorted({e.canonical for e in self.vocab.entries if e.context is None and any(c.isupper() for c in e.canonical)})[:60])
        return SttOptions(language=t.language, beam_size_final=beam, hotwords=hot)

    async def pause_listening(self) -> dict:
        if self.state != "listening":
            raise EngineError("not listening")
        for cap in self._captures.values():
            cap.pause()  # type: ignore[attr-defined]
        for seg in self._segmenters.values():
            seg.flush()
        self._elapsed_before_ms += int((time.monotonic() - (self._listen_started_at or time.monotonic())) * 1000)
        self._listen_started_at = None
        self.state = "paused"
        self._emit_status()
        return self.listening_status()

    async def resume_listening(self) -> dict:
        if self.state != "paused":
            raise EngineError("not paused")
        for cap in self._captures.values():
            cap.resume()  # type: ignore[attr-defined]
        self._listen_started_at = time.monotonic()
        self.state = "listening"
        self._emit_status()
        return self.listening_status()

    async def stop_listening(self) -> dict:
        caps = list(self._captures.values())
        self._captures.clear()
        for cap in caps:
            await asyncio.to_thread(cap.stop)  # type: ignore[attr-defined]
        for seg in self._segmenters.values():
            seg.flush()
        self._segmenters.clear()
        self._source_status.clear()
        if self.state != "idle":
            self.state, self.state_message = "idle", None
            self._listen_started_at = None
            self._emit_status()
        self._schedule_model_unload()
        return self.listening_status()

    def _schedule_model_unload(self, idle_s: float = 120.0) -> None:
        """Release the speech model (VRAM and ~2 GB of host RAM for turbo) after the engine has been
        idle for ``idle_s``. Starting again within that window reuses the loaded model instantly."""
        if self._unload_task is not None:
            self._unload_task.cancel()

        async def unload_later() -> None:
            await asyncio.sleep(idle_s)
            if self.state == "idle" and self.transcriber is not None:
                tr, self.transcriber, self.selection = self.transcriber, None, None
                await asyncio.to_thread(tr.stop)
                log.info("speech model unloaded after %.0f s idle", idle_s)
                self._emit_status()

        if self.loop is not None:
            self._unload_task = self.loop.create_task(unload_later())

    async def restart_worker(self) -> dict:
        """Recover the STT worker. Question state lives in the event loop and is preserved."""
        session = self.listening_session
        await self.stop_listening()
        if self.transcriber:
            await asyncio.to_thread(self.transcriber.stop)
            self.transcriber = None
        if session:
            return await self.start_listening(session)
        return self.listening_status()

    # ---------------------------------------------------------- thread callbacks
    def _make_cb(self, source: str, kind: str):
        def cb(seg: SpeechSegment) -> None:
            if kind == "start":
                sid = f"{(self.listening_session or 'x')[-6:]}-{source[:3]}-{uuid.uuid4().hex[:10]}"
                self._open_segments[source] = {"id": sid, "rev": 0, "last_partial": 0.0}
                t_ms = seg.start_sample * 1000 // SR
                self._call(self._on_speech_start, source, t_ms)
            elif kind == "audio":
                st = self._open_segments.get(source)
                if not st or not self.transcriber:
                    return
                now = time.monotonic()
                if now - st["last_partial"] * 1.0 >= self.settings.transcription.partial_interval_ms / 1000:
                    st["last_partial"] = now
                    st["rev"] += 1
                    self.transcriber.submit(st["id"], AudioSource(source), seg.samples(), seg.start_sample * 1000 // SR, False, st["rev"])
            elif kind == "end":
                st = self._open_segments.pop(source, None)
                if not st or not self.transcriber:
                    return
                st["rev"] += 1
                end_ms = (seg.end_sample or seg.start_sample) * 1000 // SR
                self.transcriber.submit(st["id"], AudioSource(source), seg.samples(), seg.start_sample * 1000 // SR, True, st["rev"] + 1000)
                self._call(self._on_speech_end, source, end_ms)

        return cb

    def _call(self, fn, *args) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(fn, *args)

    def _on_speech_start(self, source: str, t_ms: int) -> None:
        if self.listening_session:
            evs = self.engine_for(self.listening_session).on_speech_start(AudioSource(source), t_ms)
            self._publish_questions(self.listening_session, evs)
            self.hub.publish("speech.activity", {"source": source, "active": True, "t_ms": t_ms}, self.listening_session)

    def _on_speech_end(self, source: str, t_ms: int) -> None:
        if self.listening_session:
            evs = self.engine_for(self.listening_session).on_speech_end(AudioSource(source), t_ms)
            self._publish_questions(self.listening_session, evs)
            self.hub.publish("speech.activity", {"source": source, "active": False, "t_ms": t_ms}, self.listening_session)

    def _on_stt_segment(self, seg: TranscriptSegment, meta: dict) -> None:
        self._call(self._handle_segment, seg, meta)

    def _handle_segment(self, seg: TranscriptSegment, meta: dict) -> None:
        sid = self.listening_session
        if sid is None:
            return
        payload = segment_to_dict(seg, self._label(seg.source.value))
        payload["meta"] = meta
        self.hub.publish("transcript.final" if seg.is_final else "transcript.partial", payload, sid)
        if seg.is_final and seg.text and self.settings.privacy.store_transcripts:
            self.db.upsert_segment(sid, seg)
        evs = self.engine_for(sid).ingest_segment(seg)
        self._publish_questions(sid, evs)

    def _on_stt_error(self, message: str) -> None:
        self._call(lambda: self.hub.publish("engine.error", {"message": message}, self.listening_session))

    def _on_capture_status(self, source: str, state: str, message: Optional[str]) -> None:
        def apply() -> None:
            if source not in self._captures:
                return  # stopped: its last report ("stopped") comes after it was taken out
            st = self._source_status.setdefault(source, {"label": self._label(source)})
            st["state"] = state
            if state == "capturing":
                st["device"], st["message"] = message, None
            else:
                st["message"] = message
            if self.state in ("listening", "paused"):
                self._emit_status()

        self._call(apply)

    def _maybe_emit_level(self, source: str, block: np.ndarray) -> None:
        now = time.monotonic()
        if now - self._last_level_emit.get(source, 0) < 0.1:
            return
        self._last_level_emit[source] = now
        from .audio.preprocess import rms_dbfs

        self.hub.publish_threadsafe("audio.level", {"source": source, "rms_db": rms_dbfs(block)}, self.listening_session)

    # ---------------------------------------------------------- periodic tasks
    async def _ticker(self) -> None:
        while True:
            await asyncio.sleep(0.1)
            sid = self.listening_session
            if sid and sid in self._engines and self.state in ("listening", "paused"):
                try:
                    evs = self._engines[sid].tick(self._audio_clock_ms())
                    self._publish_questions(sid, evs)
                except Exception:
                    log.exception("question engine tick failed")
                    self.hub.publish("question.error", {"message": "question engine error; see logs"}, sid)

    async def _telemetry(self) -> None:
        while True:
            await asyncio.sleep(2.0)
            if self.state in ("listening", "paused", "loading_model"):
                info = await asyncio.to_thread(self.gpu.info)
                self.hub.publish("gpu.stats", info.to_dict(), self.listening_session)
                self._emit_status()

    def _apply_retention(self) -> None:
        days = self.settings.privacy.retention_days
        if not days:
            return
        cutoff = now_ms() - days * 86_400_000
        for sid in self.db.sessions_older_than(cutoff):
            self._delete_screenshot_files(self.db.delete_session(sid))
            log.info("retention: deleted session %s", sid)

    # ================================================================== settings
    def update_settings(self, patch: dict) -> EngineSettings:
        new = merge_settings(self.settings, patch)
        audio_patch = patch.get("audio") if isinstance(patch.get("audio"), dict) else {}
        if {"microphone_enabled", "system_enabled"} & set(audio_patch) and not (new.audio.microphone_enabled or new.audio.system_enabled):
            raise ValueError("Choose something to listen to: system audio, the microphone, or both.")
        self.settings = new
        self.db.set_setting("engine_settings", new.model_dump())
        for eng in self._engines.values():
            eng.cfg = self._qcfg()
        self.hub.publish("settings.updated", new.model_dump())
        return new

    def set_vocabulary(self, terms: list[dict]) -> None:
        for t in terms:
            if not str(t.get("canonical", "")).strip():
                raise EngineError("each term needs a canonical form")
            if not t.get("disabled") and not [a for a in t.get("aliases", []) if str(a).strip()]:
                raise EngineError(f"term {t['canonical']!r} needs at least one alias")
        self.db.replace_vocabulary(terms)
        self.vocab = self._load_vocabulary()
        for eng in self._engines.values():
            eng.vocab = self.vocab

    # ================================================================== models
    def models_status(self) -> dict:
        info = self.gpu.info()
        installed = installed_models(self.paths.models)
        total = info.vram_total_mb or 0
        if info.cuda_available and total >= 6000:
            recommended = "large-v3-turbo"
        elif info.cuda_available and total >= 3500:
            recommended = "medium"
        else:
            recommended = "small"
        return {
            "catalog": [m.to_dict() | {"installed": m.name in installed} for m in CATALOG.values()],
            "installed": installed,
            "recommended": recommended,
            "active_download": self.downloader.active,
            "downloads": {k: v.to_dict() for k, v in self.downloader.last.items()},
            "selected": self.settings.transcription.model,
            "gpu": info.to_dict(),
            "setup_required": not installed,
            "host_memory": (lambda m: m.to_dict() if m else None)(host_memory()),
            "memory_warning": load_memory_problem(self.settings.transcription.model if self.settings.transcription.model in installed else recommended),
        }

    async def remove_model(self, name: str) -> None:
        """Delete an installed speech model's files (it can be downloaded again).

        An installed model only occupies disk space; it uses GPU memory while it is loaded for
        listening. If this model is still loaded (ZHU keeps it for two minutes after Stop), it is
        unloaded first, so its memory is released at once.
        """
        if self.downloader.active == name:
            raise EngineError("Cancel the download before removing this model.", 409)
        if self.selection and self.selection.model == name:
            if self.state != "idle":
                raise EngineError("Stop listening before removing the model that is in use.", 409)
            if self.transcriber is not None:
                tr, self.transcriber, self.selection = self.transcriber, None, None
                await asyncio.to_thread(tr.stop)
        await asyncio.to_thread(delete_model, self.paths.models, name)
        self.downloader.last.pop(name, None)  # "completed" no longer describes it
        self._emit_status()

    def _on_download_progress(self, p) -> None:
        self._call(lambda: self.hub.publish("model.download", p.to_dict()))
        if p.state == "completed":
            def maybe_select() -> None:
                installed = installed_models(self.paths.models)
                if self.settings.transcription.model not in installed:
                    self.update_settings({"transcription": {"model": p.model}})
            self._call(maybe_select)

    # ================================================================== questions
    def question_action(self, session_id: str, fn: str, *args, editor: str = "user") -> list[dict]:
        eng = self.engine_for(session_id)
        try:
            evs = getattr(eng, fn)(*args)
        except KeyError as exc:
            raise EngineError(f"question {exc} not found", 404) from exc
        except ValueError as exc:
            raise EngineError(str(exc)) from exc
        self._publish_questions(session_id, evs, editor=editor)
        return [question_to_dict(e.question) for e in evs]

    def find_question_session(self, qid: str) -> str:
        for sid, eng in self._engines.items():
            if qid in eng.questions:
                return sid
        q = self.db.get_question(qid)
        if q is None:
            raise EngineError("question not found", 404)
        return q.session_id

    # ================================================================== capture
    async def capture(self, mode: str, monitor: Optional[int], session_id: Optional[str]) -> dict:
        def work():
            if mode == "monitor":
                img, _ = grab_monitor(monitor if monitor is not None else self.settings.capture.default_monitor)
            elif mode == "all":
                img, _ = grab_monitor(0)
            elif mode == "window":
                rect = active_window_rect()
                if rect is None:
                    raise EngineError("no active window to capture")
                img = _grab(rect)
            else:
                raise EngineError(f"unknown capture mode {mode!r}")
            return img

        img = await asyncio.to_thread(work)
        return await self._store_image(img, mode, monitor, session_id)

    async def _store_image(self, img, mode: str, monitor: Optional[int], session_id: Optional[str]) -> dict:
        sha = await asyncio.to_thread(self.screens.pixel_hash, img)
        existing = self.db.screenshot_by_hash(sha)
        if existing:
            return screenshot_to_dict(existing) | {"duplicate": True}
        cfg = self.settings.capture
        saved = await asyncio.to_thread(self.screens.save, img, cfg.image_format, cfg.jpeg_quality)
        sess = session_id if session_id and self.db.get_session(session_id) else None
        row = self.db.add_screenshot({**saved.__dict__, "session_id": sess, "mode": mode, "monitor": monitor, "created_at": now_ms()})
        data = screenshot_to_dict(row)
        self.hub.publish("screenshot.created", data, sess)
        return data | {"duplicate": False}

    def delete_screenshot(self, sid: str) -> None:
        row = self.db.delete_screenshot(sid)
        if row is None:
            raise EngineError("screenshot not found", 404)
        self._delete_screenshot_files([row])
        self.hub.publish("screenshot.deleted", {"id": sid}, row.get("session_id"))

    def _delete_screenshot_files(self, rows: list[dict]) -> None:
        for r in rows:
            (self.paths.screenshots / r["file_name"]).unlink(missing_ok=True)
            (self.paths.thumbnails / r["thumb_name"]).unlink(missing_ok=True)

    # ================================================================== providers
    def _provider_name(self, pid: str) -> str:
        """Display name for exports; a removed custom model falls back to its id."""
        if pid in self.providers.definitions:
            return self.providers.configs[pid].display_name or self.providers.definitions[pid].name
        return pid

    def save_provider_configs(self) -> None:
        self.db.set_setting("providers", self.providers.serialize_configs())

    async def _know_image_models(self, provider_id: str, images: list) -> None:
        """Before images go to a provider: make sure it is known which of its models read them (asked once per run)."""
        if images and await self.providers.learn_image_models(provider_id):
            self.save_provider_configs()
            self.hub.publish("provider.updated", self.providers.info(provider_id))

    async def submit_prompt(self, provider_id: str, session_id: Optional[str], prompt: str, screenshot_ids: list[str], model: Optional[str],
                            instructions: Optional[str] = None) -> dict:
        if provider_id not in self.providers.definitions:
            raise EngineError("unknown provider", 404)
        info = self.providers.info(provider_id)
        if info["status"] in ("not_configured", "disabled"):
            raise EngineError(f"{info['name']} is not connected. {info['status_message']}", 409)
        cfg = self.providers.configs[provider_id]
        model = model or info["model"]
        if not model:
            raise EngineError(f"{info['name']} has no model selected yet. Press Connect in Settings.", 409)
        adapter = self.providers.adapter(provider_id)
        images = await self._provider_images(screenshot_ids)
        history: list[ChatTurn] = []
        if session_id and cfg.include_history:
            for it in self.db.list_interactions(session_id)[-6:]:
                if it["provider_id"] == provider_id and it["status"] == "completed":
                    history += [ChatTurn("user", it["prompt"]), ChatTurn("assistant", it["response"])]
        system = "You are assisting with technical interview preparation. Answer clearly and accurately; say when you are unsure."
        if instructions and instructions.strip():
            system += "\n\nThe user asks that answers follow this guidance: " + instructions.strip()
        system = self._with_resume(system)
        request = PromptRequest(prompt=prompt, model=model, history=history, system=system)
        try:
            await self._know_image_models(provider_id, images)
            adapter.attach_images(request, images)
            rid = adapter.submit_prompt(request)
        except ProviderError as exc:
            raise EngineError(exc.message, 422) from exc
        iid = "pi_" + uuid.uuid4().hex[:14]
        sess = session_id if session_id and self.db.get_session(session_id) else None
        self.db.create_interaction({"id": iid, "session_id": sess, "provider_id": provider_id, "model": model, "prompt": prompt, "screenshot_ids": screenshot_ids})
        task = asyncio.create_task(self._run_request(adapter, rid, iid, provider_id, sess))
        self._requests[rid] = (provider_id, task)
        self.hub.publish("provider.started", {"request_id": rid, "interaction_id": iid, "provider_id": provider_id, "model": model}, sess)
        return {"request_id": rid, "interaction_id": iid, "model": model}

    async def _run_request(self, adapter, rid: str, iid: str, pid: str, sess: Optional[str]) -> None:
        parts: list[str] = []
        last_flush = time.monotonic()
        buffered = ""
        status = "failed"
        try:
            self.db.update_interaction(iid, status="streaming")
            async for ev in adapter.stream_response(rid):
                if ev.type == "delta":
                    parts.append(ev.text)
                    buffered += ev.text
                    if time.monotonic() - last_flush > 0.05:  # batch deltas (~20 Hz) to limit re-renders
                        self.hub.publish("provider.delta", {"request_id": rid, "interaction_id": iid, "provider_id": pid, "text": buffered}, sess)
                        buffered, last_flush = "", time.monotonic()
                elif ev.type == "completed":
                    if buffered:
                        self.hub.publish("provider.delta", {"request_id": rid, "interaction_id": iid, "provider_id": pid, "text": buffered}, sess)
                    status = "completed"
                    self.db.update_interaction(iid, status="completed", response="".join(parts), usage=ev.usage)
                    self.hub.publish("provider.completed", {"request_id": rid, "interaction_id": iid, "provider_id": pid, "usage": ev.usage, "model": ev.model}, sess)
                elif ev.type == "error" and ev.error is not None:
                    status = "cancelled" if ev.error.kind == "cancelled" else "failed"
                    self.db.update_interaction(iid, status=status, response="".join(parts), error=ev.error.message)
                    self.hub.publish("provider.error", {"request_id": rid, "interaction_id": iid, "provider_id": pid, "error": ev.error.to_dict()}, sess)
                    return
        except asyncio.CancelledError:
            self.db.update_interaction(iid, status="cancelled", response="".join(parts), error="cancelled")
            self.hub.publish("provider.error", {"request_id": rid, "interaction_id": iid, "provider_id": pid, "error": {"kind": "cancelled", "message": "Request cancelled."}}, sess)
            raise
        except Exception as exc:
            log.exception("provider request failed")
            self.db.update_interaction(iid, status="failed", response="".join(parts), error=str(exc))
            self.hub.publish("provider.error", {"request_id": rid, "interaction_id": iid, "provider_id": pid, "error": {"kind": "unavailable", "message": str(exc)}}, sess)
        finally:
            self._requests.pop(rid, None)

    def cancel_request(self, rid: str) -> bool:
        entry = self._requests.get(rid)
        if entry is None:
            return False
        pid, task = entry
        try:
            self.providers.adapter(pid).cancel_request(rid)
        except KeyError:
            pass
        task.cancel()
        return True

    # ================================================================== chat (the built-in chat tab)
    def chat_get(self, cid: str) -> dict:
        conv = self.db.get_chat(cid)
        if conv is None:
            raise EngineError("unknown conversation", 404)
        return {**conv, "streaming_request_id": self._chat_streams.get(cid)}

    def chat_create(self, title: Optional[str] = None) -> dict:
        conv = self.db.create_chat("ch_" + uuid.uuid4().hex[:14], _chat_title(title or ""))
        self.hub.publish("chat.updated", conv)
        return conv

    def chat_rename(self, cid: str, title: str) -> dict:
        self.chat_get(cid)
        self.db.update_chat(cid, title=_chat_title(title))
        conv = self.chat_get(cid)
        self.hub.publish("chat.updated", conv)
        return conv

    def chat_delete(self, cid: str) -> None:
        self.chat_get(cid)
        rid = self._chat_streams.get(cid)
        if rid:
            self.cancel_request(rid)
        self.db.delete_chat(cid)
        self.hub.publish("chat.deleted", {"id": cid})

    async def _provider_images(self, screenshot_ids: list[str], skip_missing: bool = False) -> list[ImageAttachment]:
        """Stored screenshots, re-encoded to fit provider limits."""
        images: list[ImageAttachment] = []
        for sid in screenshot_ids:
            row = self.db.get_screenshot(sid)
            if row is None:
                if skip_missing:
                    continue
                raise EngineError(f"screenshot {sid} no longer exists", 404)
            media, data = await asyncio.to_thread(encode_for_provider, self.paths.screenshots / row["file_name"])
            images.append(ImageAttachment(sid, media, data))
        return images

    async def chat_send(self, cid: str, provider_id: str, model: Optional[str], content: str, regenerate: bool = False,
                        screenshot_ids: Optional[list[str]] = None) -> dict:
        """Add the user's message to a conversation (or re-ask its last one) and start streaming the answer.

        The whole conversation is sent as context, so any model can be chosen for any turn. The
        answer arrives as ``chat.delta`` events and ends with ``chat.completed`` or ``chat.error``.
        """
        self.chat_get(cid)
        if cid in self._chat_streams:
            raise EngineError("An answer is still being written in this chat. Stop it first.", 409)
        if provider_id not in self.providers.definitions:
            raise EngineError("unknown provider", 404)
        info = self.providers.info(provider_id)
        if info["status"] in ("not_configured", "disabled"):
            raise EngineError(f"{info['name']} is not connected. {info['status_message']}", 409)
        model = (model or "").strip() or info["model"]
        if not model:
            raise EngineError(f"{info['name']} has no model selected yet.", 409)
        messages = self.db.list_chat_messages(cid)
        if regenerate:
            last_user = next((m for m in reversed(messages) if m["role"] == "user"), None)
            if last_user is None:
                raise EngineError("There is no message to answer again.", 409)
            content = last_user["content"]
            messages = [m for m in messages if m["seq"] < last_user["seq"]]
            # The screenshots of that message go along again (those that still exist).
            images = await self._provider_images(last_user["screenshot_ids"], skip_missing=True)
        else:
            if not content.strip() and not screenshot_ids:
                raise EngineError("The message is empty.", 422)
            images = await self._provider_images(list(dict.fromkeys(screenshot_ids or [])))
        request = PromptRequest(prompt=content, model=model, history=_chat_history(messages), system=self._with_resume(CHAT_SYSTEM_PROMPT))
        adapter = self.providers.adapter(provider_id)
        try:
            await self._know_image_models(provider_id, images)
            adapter.attach_images(request, images)
            rid = adapter.submit_prompt(request)
        except ProviderError as exc:
            raise EngineError(exc.message, 422) from exc
        # Nothing is written before this point, so a rejected request leaves the conversation as it was.
        if regenerate:
            self.db.delete_chat_messages_after(cid, last_user["seq"])  # type: ignore[index]
            user = last_user
        else:
            user = self.db.add_chat_message({"id": "cm_" + uuid.uuid4().hex[:14], "conversation_id": cid, "role": "user", "content": content, "status": "completed",
                                             "screenshot_ids": [i.screenshot_id for i in images]})
        assistant = self.db.add_chat_message({"id": "cm_" + uuid.uuid4().hex[:14], "conversation_id": cid, "role": "assistant", "provider_id": provider_id,
                                              "model": model, "status": "streaming"})
        titled = not self.db.get_chat(cid)["title"]  # type: ignore[index]
        self.db.update_chat(cid, title=_chat_title(content or "Screenshot") if titled else None, touch=True)
        self._chat_streams[cid] = rid
        task = asyncio.create_task(self._run_chat(adapter, rid, cid, assistant["id"], provider_id, model))
        self._requests[rid] = (provider_id, task)
        conv = self.chat_get(cid)
        self.hub.publish("chat.updated", conv)
        return {"request_id": rid, "conversation": conv, "user_message": user, "assistant_message": assistant}

    async def _run_chat(self, adapter, rid: str, cid: str, mid: str, pid: str, model: Optional[str] = None) -> None:
        parts: list[str] = []
        buffered = ""
        last_flush = time.monotonic()
        thinking = False  # inside the <think> block that holds a reasoning model's thinking
        ids = {"request_id": rid, "conversation_id": cid, "message_id": mid}

        def add(text: str) -> None:
            nonlocal buffered
            parts.append(text)
            buffered += text

        def flush() -> None:
            nonlocal buffered, last_flush
            if buffered:
                self.hub.publish("chat.delta", {**ids, "text": buffered})
            buffered, last_flush = "", time.monotonic()

        def end_thinking() -> None:
            nonlocal thinking
            if thinking:
                add(THINK_CLOSE + "\n\n")
            thinking = False

        def fail(error: dict) -> None:
            end_thinking()
            flush()
            status = "cancelled" if error.get("kind") == "cancelled" else "failed"
            self.db.update_chat_message(mid, status=status, content="".join(parts), error=None if status == "cancelled" else error)
            self.hub.publish("chat.error", {**ids, "status": status, "error": error})

        try:
            async for ev in adapter.stream_response(rid):
                if ev.type in ("delta", "reasoning"):
                    # Thinking is kept with the answer, in a <think> block the chat shows folded away.
                    if ev.type == "reasoning" and not thinking:
                        if parts:
                            continue  # thinking after the answer has begun is not shown
                        thinking = True
                        add(THINK_OPEN)
                    elif ev.type == "delta":
                        end_thinking()
                    add(ev.text)
                    if time.monotonic() - last_flush > 0.05:  # batch deltas (~20 Hz) to limit re-renders
                        flush()
                elif ev.type == "completed":
                    end_thinking()
                    flush()
                    self.db.update_chat_message(mid, status="completed", content="".join(parts), usage=ev.usage, model=ev.model)
                    self.hub.publish("chat.completed", {**ids, "usage": ev.usage, "model": ev.model})
                    # A resume without its short profile yet (uploaded with no model connected, or
                    # the first try failed): made now, with this model, after its answer.
                    self.condense_soon(pid, model)
                elif ev.type == "error" and ev.error is not None:
                    fail(ev.error.to_dict())
                    return
        except asyncio.CancelledError:
            fail({"kind": "cancelled", "message": "Stopped.", "retry_after_s": None, "status": None})
            raise
        except Exception as exc:
            log.exception("chat request failed")
            fail({"kind": "unavailable", "message": str(exc), "retry_after_s": None, "status": None})
        finally:
            self._requests.pop(rid, None)
            if self._chat_streams.get(cid) == rid:
                del self._chat_streams[cid]
            # A conversation deleted mid-answer has no row left to touch; the update is then a no-op.
            self.db.update_chat(cid, touch=True)

    # ================================================================== resume and job
    # The store is profile.py; these wrap it so its refusals reach the UI as ordinary messages.
    @staticmethod
    def _profile(action, *args):
        try:
            return action(*args)
        except resume_file.ResumeError as exc:
            raise EngineError(str(exc), 422) from exc
        except ProfileNotFound as exc:
            raise EngineError(str(exc), 404) from exc

    def resumes_info(self) -> dict:
        return self.profile.info()

    async def resume_add(self, file_name: str, data: bytes, provider_id: Optional[str] = None, model: Optional[str] = None) -> dict:
        # Reading a file (and recognizing the text of a scan) takes a moment: off the event loop.
        extracted = await asyncio.to_thread(self._profile, resume_file.extract_text, file_name, data)
        self._profile(self.profile.add, file_name, extracted, data)
        self.condense_soon(provider_id, model)  # read once, condensed once, right away
        return self.profile.info()

    def resume_file(self, rid: str) -> tuple[Path, str, str]:
        """The resume's file as it was uploaded (path, media type, name)."""
        return self._profile(self.profile.file, rid)

    def resume_open(self, rid: str) -> None:
        """Open the resume's file in the program Windows uses for it (Word for a .docx)."""
        path, _, _ = self.resume_file(rid)
        try:
            if sys.platform == "win32":
                os.startfile(path)  # noqa: S606 - our own file, in our own data folder
            else:
                subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])  # noqa: S603
        except OSError as exc:
            raise EngineError(f"The file could not be opened: {exc}", 500) from exc

    def resume_update(self, rid: str, label: Optional[str], text: Optional[str], revert: bool) -> dict:
        self._profile(self.profile.update, rid, label, text, revert)
        self.condense_soon()
        return self.profile.info()

    def resume_select(self, active_id: Optional[str], enabled: Optional[bool]) -> dict:
        return self._profile(self.profile.select, active_id, enabled)

    def resume_delete(self, rid: str) -> dict:
        return self._profile(self.profile.delete, rid)

    def job_set(self, title: Optional[str], text: str, provider_id: Optional[str] = None, model: Optional[str] = None) -> dict:
        self._profile(self.profile.set_job, title, text)
        self.condense_soon(provider_id, model)
        return self.profile.info()

    async def job_add_file(self, file_name: str, data: bytes, title: Optional[str], provider_id: Optional[str] = None, model: Optional[str] = None) -> dict:
        extracted = await asyncio.to_thread(self._profile, resume_file.extract_text, file_name, data, resume_file.MAX_JOB_CHARS)
        self._profile(self.profile.add_job_file, file_name, extracted, title)
        self.condense_soon(provider_id, model)
        return self.profile.info()

    def condense_again(self, provider_id: Optional[str] = None, model: Optional[str] = None) -> dict:
        """The user asked for the short profile now (after a failure)."""
        self.profile.forget_failures()
        self.condense_soon(provider_id, model)
        return self.profile.info()

    # ------------------------------------------------------------------ the short profile
    def condense_soon(self, provider_id: Optional[str] = None, model: Optional[str] = None) -> None:
        """Condense the resume (and the job) once, in the background, with the given model (the one
        the Custom chat uses) or the first connected one. Nothing waits for it: until it is made, the
        full text goes, and a failure is tried again after a while."""
        targets = self.profile.condense_targets()
        if not targets:
            return
        chosen = self._condense_model(provider_id, model)
        if chosen is None:
            return  # no model connected yet: made later, with the first Custom chat answer
        started = False
        for kind, text, source in targets:
            if self.profile.claim(source):
                task = asyncio.get_running_loop().create_task(self._condense(kind, text, source, *chosen))
                self._condensing.add(task)
                task.add_done_callback(self._condensing.discard)
                started = True
        if started:
            self.hub.publish("resume.updated", {})  # the card shows that it is being made

    def _condense_model(self, provider_id: Optional[str], model: Optional[str]) -> Optional[tuple[str, str]]:
        order = ([provider_id] if provider_id else []) + [pid for pid in self.providers.configs if pid != provider_id]
        for pid in order:
            if pid not in self.providers.configs:
                continue
            info = self.providers.info(pid)
            if info["status"] in ("not_configured", "disabled"):
                continue
            chosen = ((model or "").strip() if pid == provider_id else "") or info["model"]
            if chosen:
                return pid, chosen
        return None

    async def _condense(self, kind: str, text: str, source: str, provider_id: str, model: str) -> None:
        system, prompt = resume_file.condense_prompt(kind, text)
        try:
            adapter = self.providers.adapter(provider_id)
            out = await asyncio.wait_for(adapter.complete(PromptRequest(prompt=prompt, model=model, system=system, max_tokens=900)), CONDENSE_TIMEOUT_S)
            short = resume_file.clean_condensed(out)
            if short is None:
                raise ValueError("no usable profile in the answer")
            if self.profile.set_condensed(kind, source, short, provider_id, model):
                log.info("%s condensed with %s (%s): %d words to %d", kind, provider_id, model, len(text.split()), len(short.split()))
        except Exception as exc:  # noqa: BLE001 - any failure: the full text keeps going until it works
            reason = exc.kind if isinstance(exc, ProviderError) else type(exc).__name__
            log.warning("condensing the %s with %s (%s) failed: %s", kind, provider_id, model, reason)
            self.profile.condense_failed(source)

    def job_enable(self, enabled: bool) -> dict:
        return self._profile(self.profile.job_enable, enabled)

    def job_delete(self) -> dict:
        return self.profile.delete_job()

    def chat_context(self) -> Optional[dict]:
        """What goes into the first message of a new conversation on a chat website, or None."""
        return self.profile.chat_context()

    def _with_resume(self, system: str) -> str:
        """Add the resume and the job to a system prompt, each while it is there and switched on."""
        block = self.profile.prompt_block()
        return f"{system}\n\n{block}" if block else system

    # ================================================================== privacy
    async def purge_all(self) -> None:
        await self.stop_listening()
        self.profile.purge()
        shots = self.db.purge_all()
        self._delete_screenshot_files(shots)
        self._engines.clear()
        self.hub.publish("data.purged", {})


CHAT_SYSTEM_PROMPT = (
    "You are a helpful assistant in ZHU, a desktop app. Answer clearly and accurately, and say when you are unsure. "
    "Format answers in Markdown: fenced code blocks with a language tag for code, and LaTeX between $ or $$ for mathematics."
)
# Context sent with each chat turn: the most recent messages, within a size a small free model accepts.
# Condensing the resume is one request; a slow free model gets this long before it counts as failed.
CONDENSE_TIMEOUT_S = 120
CHAT_HISTORY_MESSAGES = 40
CHAT_HISTORY_CHARS = 120_000
THINK_OPEN, THINK_CLOSE = "<think>", "</think>"
_THINK_BLOCK = re.compile(r"^\s*<think(?:ing)?>.*?(?:</think(?:ing)?>|$)\s*", re.IGNORECASE | re.DOTALL)


def _chat_title(text: str) -> str:
    """A one-line conversation title from the user's text."""
    line = " ".join(text.split())
    return line if len(line) <= 60 else line[:59].rstrip() + "\u2026"


def _chat_history(messages: list[dict]) -> list[ChatTurn]:
    """Earlier turns of a conversation as model context, newest kept when it is too long.

    Answers that failed or were stopped before any text arrived are left out, and so is a
    question that never got an answer, so the context always alternates user and assistant.
    """
    turns: list[ChatTurn] = []
    for m in messages:
        # A model's thinking is not part of what it said: only the answer goes back as context.
        text = _THINK_BLOCK.sub("", m["content"], count=1) if m["role"] == "assistant" else m["content"]
        if not text.strip():
            continue
        if turns and turns[-1].role == m["role"]:
            turns[-1] = ChatTurn(m["role"], text)  # an unanswered question is replaced by the next one
        else:
            turns.append(ChatTurn(m["role"], text))
    if turns and turns[-1].role == "user":
        turns.pop()  # the new message follows; two user turns in a row are rejected by some providers
    turns = turns[-CHAT_HISTORY_MESSAGES:]
    total = 0
    for i in range(len(turns) - 1, -1, -1):
        total += len(turns[i].text)
        if total > CHAT_HISTORY_CHARS:
            turns = turns[i + 1:]
            break
    while turns and turns[0].role != "user":
        turns.pop(0)
    return turns


def _fmt_ts(ms: int) -> str:
    s = max(0, ms) // 1000
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"
