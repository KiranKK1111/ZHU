"""The user's resume and the job they are applying for, as stored in the settings table.

One resume is kept: uploading another replaces it. Its text (read from the file) goes into answers,
and the file itself is kept too, in the data folder's `resume` directory, so it can be shown as it
was uploaded. The job is separate: a title and the job description, pasted or read from a file.
Each has its own switch, so either can be left out of answers without deleting it.

Stored under the `resumes` and `job` keys (a list, from the versions that kept several resumes: only
the one in use is kept now). The single resume of earlier versions (`resume`) is moved into the
list the first time it is read.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path, PurePath
from typing import Any, Callable, Optional

from . import resume as rf
from .storage.db import Database

MAX_RESUMES = 1
_KEY, _JOB, _LEGACY = "resumes", "job", "resume"

# What a kept file is served as. Only the kinds a resume can be read from (resume.EXTENSIONS).
MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


class ProfileNotFound(LookupError):
    """No resume (or no job) of that kind is stored; the message is shown to the user."""


def _now() -> int:
    return int(time.time() * 1000)


def _file_name(name: str) -> str:
    """Only the file's own name: a path the browser may send is not kept."""
    return " ".join((name or "").replace("\\", "/").split("/")[-1].split())[:120] or "Resume"


def _label(file_name: str) -> str:
    return rf.clean_title(PurePath(file_name).stem.replace("_", " ")) or "Resume"


class ProfileStore:
    def __init__(self, db: Database, changed: Callable[[], None], files: Optional[Path] = None) -> None:
        self.db = db
        self._changed = changed
        # Where uploaded resume files are kept; None keeps only their text.
        self.files = files
        # Condensing in progress, and condensing that failed, by the source text's key (in memory:
        # after a restart a missing profile is simply made again).
        self._making: dict[str, float] = {}
        self._failed: dict[str, float] = {}

    # ------------------------------------------------------------------ storage
    def _state(self) -> dict:
        state = self.db.get_setting(_KEY)
        if isinstance(state, dict) and isinstance(state.get("items"), list):
            return state
        state = {"items": [], "active_id": None, "enabled": True}
        legacy = self.db.get_setting(_LEGACY)
        if isinstance(legacy, dict) and legacy.get("text"):
            item = {
                "id": "rs_" + uuid.uuid4().hex[:12],
                "label": _label(legacy.get("file_name") or "Resume"),
                "file_name": legacy.get("file_name") or "Resume",
                "text": legacy["text"],
                "file_text": None,
                "truncated": bool(legacy.get("truncated")),
                "ocr": False,
                "uploaded_at": legacy.get("uploaded_at") or _now(),
                "edited_at": None,
            }
            state = {"items": [item], "active_id": item["id"], "enabled": bool(legacy.get("enabled", True))}
            self.db.set_setting(_KEY, state)
            self.db.set_setting(_LEGACY, None)
        return state

    def _single(self, state: dict) -> dict:
        """Earlier versions kept several resumes: only the one in use stays (or the newest)."""
        if len(state["items"]) <= 1:
            return state
        keep = self._active(state) or state["items"][-1]
        for item in state["items"]:
            if item is not keep:
                self._remove_file(item)
        state = {**state, "items": [keep], "active_id": keep["id"]}
        self.db.set_setting(_KEY, state)
        return state

    # ------------------------------------------------------------------ the kept file
    def _file_path(self, item: dict) -> Optional[Path]:
        stored = item.get("stored_file")
        if not stored or self.files is None:
            return None
        path = self.files / PurePath(stored).name  # never anything outside the folder
        return path if path.is_file() else None

    def _keep_file(self, rid: str, file_name: str, data: Optional[bytes]) -> Optional[str]:
        suffix = PurePath(file_name).suffix.lower()
        if not data or self.files is None or suffix not in MEDIA_TYPES:
            return None
        self.files.mkdir(parents=True, exist_ok=True)
        stored = f"{rid}{suffix}"
        partial = self.files / f"{stored}.partial"
        partial.write_bytes(data)
        partial.replace(self.files / stored)
        return stored

    def _remove_file(self, item: dict) -> None:
        path = self._file_path(item)
        if path is not None:
            path.unlink(missing_ok=True)

    def file(self, rid: str) -> tuple[Path, str, str]:
        """The resume's file as it was uploaded: where it is, its media type, and its name."""
        item = self._find(self._state(), rid)
        path = self._file_path(item)
        if path is None:
            raise ProfileNotFound("This resume was uploaded before ZHU kept the files themselves. Upload it again to see it here.")
        return path, MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"), item["file_name"]

    def _save(self, state: dict) -> dict:
        self.db.set_setting(_KEY, state)
        self._changed()
        return self.info()

    @staticmethod
    def _find(state: dict, rid: str) -> dict:
        for item in state["items"]:
            if item["id"] == rid:
                return item
        raise ProfileNotFound("That resume is no longer stored.")

    def _active(self, state: dict) -> Optional[dict]:
        rid = state.get("active_id")
        return next((i for i in state["items"] if i["id"] == rid), None)

    # ------------------------------------------------------------------ the short profile
    @staticmethod
    def _condensed(entry: Optional[dict], field: str) -> Optional[str]:
        """The condensed text kept with a resume ("profile") or the job ("brief"), while it still
        matches the text it was made from."""
        made = (entry or {}).get(field)
        if isinstance(made, dict) and made.get("text") and made.get("source") == rf.source_key((entry or {}).get("text") or ""):
            return made["text"]
        return None

    def condense_targets(self) -> list[tuple[str, str, str]]:
        """(kind, text, source key) of what is worth condensing and has no profile yet."""
        out: list[tuple[str, str, str]] = []
        active = self._active(self._state())
        if active and rf.worth_condensing("resume", active["text"]) and not self._condensed(active, "profile"):
            out.append(("resume", active["text"], rf.source_key(active["text"])))
        job = self.db.get_setting(_JOB)
        if isinstance(job, dict) and (job.get("text") or "").strip() and rf.worth_condensing("job", job["text"]) and not self._condensed(job, "brief"):
            out.append(("job", job["text"], rf.source_key(job["text"])))
        return out

    def claim(self, source: str, retry_after_s: float = 600) -> bool:
        """Start condensing this text, unless it is under way or failed a short while ago."""
        now = time.monotonic()
        if source in self._making:
            return False
        failed = self._failed.get(source)
        if failed is not None and now - failed < retry_after_s:
            return False
        self._failed.pop(source, None)
        self._making[source] = now
        return True

    def set_condensed(self, kind: str, source: str, text: str, provider_id: str, model: str) -> bool:
        """Keep a condensed profile, if what it was made from is still the text in use."""
        self._making.pop(source, None)
        made = {"text": text, "source": source, "provider_id": provider_id, "model": model, "created_at": _now()}
        if kind == "resume":
            state = self._state()
            for item in state["items"]:
                if rf.source_key(item["text"]) == source:
                    item["profile"] = made
                    self._save(state)
                    return True
        else:
            job = self.db.get_setting(_JOB)
            if isinstance(job, dict) and rf.source_key(job.get("text") or "") == source:
                self.db.set_setting(_JOB, {**job, "brief": made})
                self._changed()
                return True
        self._changed()
        return False

    def condense_failed(self, source: str) -> None:
        self._making.pop(source, None)
        self._failed[source] = time.monotonic()
        self._changed()

    def forget_failures(self) -> None:
        """Try again now (the user asked to), not only after the wait."""
        self._failed.clear()

    def _condense_info(self, entry: dict, field: str, kind: str) -> dict:
        text = entry.get("text") or ""
        source = rf.source_key(text)
        short = self._condensed(entry, field)
        if short:
            state = "ready"
        elif not rf.worth_condensing(kind, text):
            state = "short"  # small already: it goes as it is
        elif source in self._making:
            state = "making"
        elif source in self._failed:
            state = "failed"
        else:
            state = "waiting"  # made with the next Custom chat answer, or when a model is connected
        made = entry.get(field) if short else None
        return {"state": state, "text": short, "words": len(short.split()) if short else 0, "model": (made or {}).get("model")}

    # ------------------------------------------------------------------ what the UI shows
    def _item_info(self, item: dict) -> dict:
        text = item["text"]
        return {
            "id": item["id"],
            "label": item.get("label") or _label(item["file_name"]),
            "file_name": item["file_name"],
            "text": text,
            "characters": len(text),
            "words": len(text.split()),
            "truncated": bool(item.get("truncated")),
            "ocr": bool(item.get("ocr")),
            "uploaded_at": item.get("uploaded_at"),
            "edited_at": item.get("edited_at"),
            "can_revert": item.get("file_text") is not None,
            "has_file": bool(item.get("stored_file")),
            "media_type": MEDIA_TYPES.get(PurePath(item["file_name"]).suffix.lower()),
            "profile": self._condense_info(item, "profile", "resume"),
        }

    def _job_info(self) -> Optional[dict]:
        job = self.db.get_setting(_JOB)
        if not isinstance(job, dict) or not (job.get("text") or "").strip():
            return None
        text = job["text"]
        return {
            "title": job.get("title") or "",
            "text": text,
            "characters": len(text),
            "words": len(text.split()),
            "enabled": bool(job.get("enabled", True)),
            "truncated": bool(job.get("truncated")),
            "ocr": bool(job.get("ocr")),
            "source": job.get("source"),
            "updated_at": job.get("updated_at"),
            "brief": self._condense_info(job, "brief", "job"),
        }

    def info(self) -> dict:
        state = self._single(self._state())
        active = self._active(state)
        return {
            "items": [self._item_info(i) for i in state["items"]],
            "active_id": active["id"] if active else None,
            "enabled": bool(state.get("enabled", True)),
            "job": self._job_info(),
            "limits": {"resume_chars": rf.MAX_CHARS, "job_chars": rf.MAX_JOB_CHARS, "resumes": MAX_RESUMES},
        }

    # ------------------------------------------------------------------ resumes
    def add(self, file_name: str, extracted: rf.Extracted, data: Optional[bytes] = None) -> dict:
        """Keep a newly read resume, and its file, in place of the one there was."""
        state = self._state()
        name = _file_name(file_name)
        rid = "rs_" + uuid.uuid4().hex[:12]
        stored = self._keep_file(rid, name, data)
        for old in state["items"]:
            self._remove_file(old)
        item = {
            "id": rid,
            "stored_file": stored,
            "label": _label(name),
            "file_name": name,
            "text": extracted.text,
            "file_text": None,
            "truncated": extracted.truncated,
            "ocr": extracted.ocr,
            "uploaded_at": _now(),
            "edited_at": None,
        }
        state["items"] = [item]
        state["active_id"] = item["id"]
        state["enabled"] = True
        return self._save(state)

    def update(self, rid: str, label: Optional[str] = None, text: Optional[str] = None, revert: bool = False) -> dict:
        """Rename a resume, correct its text, or bring back the text read from its file."""
        state = self._state()
        item = self._find(state, rid)
        if label is not None:
            item["label"] = rf.clean_title(label) or _label(item["file_name"])
        if revert:
            if item.get("file_text") is not None:
                item["text"], item["file_text"], item["edited_at"] = item["file_text"], None, None
        elif text is not None:
            new = rf.clean_text(text, rf.MAX_CHARS, "The resume")
            if len(new) < 1:
                raise rf.ResumeError("The resume cannot be empty. Remove it instead.")
            if new != item["text"]:
                original = item["file_text"] if item.get("file_text") is not None else item["text"]
                item["text"] = new
                item["file_text"] = None if new == original else original
                item["edited_at"] = None if new == original else _now()
        return self._save(state)

    def select(self, active_id: Optional[str] = None, enabled: Optional[bool] = None) -> dict:
        state = self._state()
        if active_id is not None:
            self._find(state, active_id)
            state["active_id"] = active_id
        if enabled is not None:
            if not state["items"]:
                raise ProfileNotFound("No resume has been uploaded.")
            state["enabled"] = bool(enabled)
        return self._save(state)

    def delete(self, rid: str) -> dict:
        state = self._state()
        self._remove_file(self._find(state, rid))
        state["items"] = [i for i in state["items"] if i["id"] != rid]
        if state.get("active_id") == rid:
            # The most recently added of the others takes its place.
            state["active_id"] = state["items"][-1]["id"] if state["items"] else None
        return self._save(state)

    # ------------------------------------------------------------------ the job
    def set_job(self, title: Optional[str], text: str) -> dict:
        body = rf.clean_text(text, rf.MAX_JOB_CHARS, "The job description")
        if not body:
            raise rf.ResumeError("Paste the job description, or upload it as a file.")
        old = self.db.get_setting(_JOB) or {}
        same = old.get("text") == body  # only the title changed: what is known about the text still holds
        self.db.set_setting(_JOB, {"title": rf.clean_title(title), "text": body, "enabled": bool(old.get("enabled", True)),
                                   "truncated": bool(old.get("truncated")) and same, "ocr": bool(old.get("ocr")) and same,
                                   "source": old.get("source") if same else None, "updated_at": _now(),
                                   "brief": old.get("brief") if same else None})
        self._changed()
        return self.info()

    def add_job_file(self, file_name: str, extracted: rf.Extracted, title: Optional[str] = None) -> dict:
        name = _file_name(file_name)
        self.db.set_setting(_JOB, {"title": rf.clean_title(title) or _label(name), "text": extracted.text, "enabled": True,
                                   "truncated": extracted.truncated, "ocr": extracted.ocr, "source": name, "updated_at": _now()})
        self._changed()
        return self.info()

    def job_enable(self, enabled: bool) -> dict:
        job = self.db.get_setting(_JOB)
        if not isinstance(job, dict) or not job.get("text"):
            raise ProfileNotFound("No job has been added.")
        self.db.set_setting(_JOB, {**job, "enabled": bool(enabled)})
        self._changed()
        return self.info()

    def delete_job(self) -> dict:
        self.db.set_setting(_JOB, None)
        self._changed()
        return self.info()

    # ------------------------------------------------------------------ what models and chat sites get
    def _in_use(self, condensed: bool) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """The resume text, the job title and the job text that go out (each only while switched
        on). Condensed: the short profile and brief where they are made, the full texts otherwise."""
        state = self._state()
        active = self._active(state) if state.get("enabled", True) else None
        job = self.db.get_setting(_JOB)
        job = job if isinstance(job, dict) and (job.get("text") or "").strip() and job.get("enabled", True) else None
        resume = ((condensed and self._condensed(active, "profile")) or active["text"]) if active else None
        if job is None:
            return resume, None, None
        if condensed and self._condensed(job, "brief"):
            return resume, None, self._condensed(job, "brief")  # the brief names the title itself
        return resume, job.get("title") or "", job["text"]

    def prompt_block(self) -> str:
        """What models get with every question: the short profile and brief, once made."""
        return rf.prompt_block(*self._in_use(condensed=True))

    def chat_context(self) -> Optional[dict[str, Any]]:
        """What a chat website gets once per new chat: the full texts."""
        return rf.chat_context(*self._in_use(condensed=False))

    def purge(self) -> None:
        for key in (_KEY, _JOB, _LEGACY):
            self.db.set_setting(key, None)
        if self.files is not None and self.files.is_dir():
            for path in self.files.iterdir():
                if path.is_file():
                    path.unlink(missing_ok=True)
        self._changed()
