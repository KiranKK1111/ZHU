"""SQLite persistence layer. WAL mode with foreign keys; every write runs in a short transaction.

Provider credentials are **never** stored here; they live in Windows Credential
Manager (see providers/credentials.py).
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable, Optional

from ..questions.types import (
    AudioSource,
    Confidence,
    Question,
    QuestionCategory,
    QuestionKind,
    QuestionState,
    Span,
    Substitution,
    TranscriptSegment,
    WordInfo,
)
from .migrations import MIGRATIONS


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = str(path)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self.migrate()

    # --------------------------------------------------------------- plumbing
    def migrate(self) -> int:
        with self._lock:
            self._conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
            applied = {r[0] for r in self._conn.execute("SELECT version FROM schema_migrations")}
            for version, sql in MIGRATIONS:
                if version in applied:
                    continue
                self._conn.execute("BEGIN")
                try:
                    # executescript() would COMMIT implicitly; run statements inside our transaction instead.
                    for stmt in _split_sql(sql):
                        self._conn.execute(stmt)
                    self._conn.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (version, now_ms()))
                    self._conn.execute("COMMIT")
                except Exception:
                    self._conn.execute("ROLLBACK")
                    raise
            return max((v for v, _ in MIGRATIONS), default=0)

    def schema_version(self) -> int:
        row = self._conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
        return int(row[0] or 0)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _exec(self, sql: str, params: Iterable[Any] | dict = ()) -> sqlite3.Cursor:
        with self._lock:
            # Named parameters must stay a mapping; tuple(dict) would bind the keys.
            return self._conn.execute(sql, params if isinstance(params, dict) else tuple(params))

    def _tx(self, statements: list[tuple[str, tuple]]) -> None:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                for sql, params in statements:
                    self._conn.execute(sql, params)
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def _rows(self, sql: str, params: Iterable[Any] = ()) -> list[dict]:
        return [dict(r) for r in self._exec(sql, params).fetchall()]

    def _row(self, sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
        r = self._exec(sql, params).fetchone()
        return dict(r) if r else None

    # --------------------------------------------------------------- sessions
    def create_session(self, session_id: str, name: str) -> dict:
        t = now_ms()
        self._exec(
            "INSERT INTO sessions(id, name, status, started_at, last_activity_at) VALUES (?, ?, 'active', ?, ?)",
            (session_id, name, t, t),
        )
        return self.get_session(session_id)  # type: ignore[return-value]

    def get_session(self, session_id: str) -> Optional[dict]:
        return self._row(_SESSION_SUMMARY_SQL + " WHERE s.id = ?", (session_id,))

    def list_sessions(self, query: str = "", sort: str = "recent", limit: int = 500, offset: int = 0) -> list[dict]:
        order = {
            "recent": "s.last_activity_at DESC",
            "oldest": "s.started_at ASC",
            "name": "s.name COLLATE NOCASE ASC",
            "questions": "question_count DESC, s.last_activity_at DESC",
            "duration": "(COALESCE(s.ended_at, s.last_activity_at) - s.started_at) DESC",
        }.get(sort, "s.last_activity_at DESC")
        params: list[Any] = []
        where = ""
        if query:
            like = f"%{query}%"
            where = (
                " WHERE s.name LIKE ? OR s.notes LIKE ? OR EXISTS (SELECT 1 FROM questions q2 WHERE q2.session_id = s.id "
                "AND (q2.formatted_text LIKE ? OR q2.raw_text LIKE ?)) OR EXISTS (SELECT 1 FROM transcript_segments t2 "
                "WHERE t2.session_id = s.id AND t2.text LIKE ?)"
            )
            params += [like] * 5
        return self._rows(_SESSION_SUMMARY_SQL + where + f" ORDER BY {order} LIMIT ? OFFSET ?", params + [limit, offset])

    def update_session(self, session_id: str, name: Optional[str] = None, notes: Optional[str] = None) -> Optional[dict]:
        if name is not None:
            self._exec("UPDATE sessions SET name = ? WHERE id = ?", (name, session_id))
        if notes is not None:
            self._exec("UPDATE sessions SET notes = ? WHERE id = ?", (notes, session_id))
        return self.get_session(session_id)

    def touch_session(self, session_id: str) -> None:
        self._exec("UPDATE sessions SET last_activity_at = ? WHERE id = ?", (now_ms(), session_id))

    def end_session(self, session_id: str) -> Optional[dict]:
        t = now_ms()
        self._exec("UPDATE sessions SET status = 'ended', ended_at = COALESCE(ended_at, ?), last_activity_at = ? WHERE id = ?", (t, t, session_id))
        return self.get_session(session_id)

    def end_dangling_sessions(self) -> list[str]:
        """Crash recovery: sessions left 'active' by an unexpected termination are closed
        at their last recorded activity. Their data is preserved."""
        ids = [r["id"] for r in self._rows("SELECT id FROM sessions WHERE status = 'active'")]
        self._exec("UPDATE sessions SET status = 'ended', ended_at = last_activity_at WHERE status = 'active'")
        return ids

    def delete_session(self, session_id: str) -> list[dict]:
        shots = self._rows("SELECT * FROM screenshots WHERE session_id = ?", (session_id,))
        self._tx([
            ("DELETE FROM screenshots WHERE session_id = ?", (session_id,)),
            ("DELETE FROM processing_events WHERE session_id = ?", (session_id,)),
            ("DELETE FROM sessions WHERE id = ?", (session_id,)),
        ])
        return shots

    def sessions_older_than(self, cutoff_ms: int) -> list[str]:
        return [r["id"] for r in self._rows("SELECT id FROM sessions WHERE status = 'ended' AND last_activity_at < ?", (cutoff_ms,))]

    # --------------------------------------------------------------- transcript
    def upsert_segment(self, session_id: str, seg: TranscriptSegment) -> None:
        words = json.dumps([asdict(w) for w in seg.words])
        self._exec(
            """INSERT INTO transcript_segments(session_id, segment_id, revision, source, speaker, text, start_ms, end_ms,
                   is_final, confidence, language, words_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(session_id, segment_id) DO UPDATE SET revision = excluded.revision, text = excluded.text,
                   start_ms = excluded.start_ms, end_ms = excluded.end_ms, is_final = excluded.is_final,
                   confidence = excluded.confidence, language = excluded.language, words_json = excluded.words_json
               WHERE excluded.revision > transcript_segments.revision""",
            (session_id, seg.segment_id, seg.revision, seg.source.value, seg.speaker, seg.text, seg.start_ms, seg.end_ms,
             int(seg.is_final), seg.confidence, seg.language, words, now_ms()),
        )

    def list_segments(self, session_id: str, limit: int = 20_000) -> list[dict]:
        rows = self._rows("SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY start_ms LIMIT ?", (session_id, limit))
        for r in rows:
            r["words"] = json.loads(r.pop("words_json"))
            r["is_final"] = bool(r["is_final"])
        return rows

    def clear_transcript(self, session_id: str) -> int:
        """Delete a session's transcript. Its questions stay: they hold their own text."""
        return self._exec("DELETE FROM transcript_segments WHERE session_id = ?", (session_id,)).rowcount

    def correct_segment(self, row_id: int, text: str) -> Optional[dict]:
        self._exec("UPDATE transcript_segments SET corrected_text = ? WHERE id = ?", (text, row_id))
        r = self._row("SELECT * FROM transcript_segments WHERE id = ?", (row_id,))
        if r:
            r["words"] = json.loads(r.pop("words_json"))
            r["is_final"] = bool(r["is_final"])
        return r

    # --------------------------------------------------------------- questions
    def save_question(self, q: Question, editor: str = "engine") -> None:
        t = now_ms()
        stmts: list[tuple[str, tuple]] = [
            (
                """INSERT INTO questions(id, session_id, state, revision, raw_text, formatted_text, resolved_text, kind, category,
                       source, speaker, started_at_ms, ended_at_ms, confidence_json, subquestions_json, scenario, uncertain_json,
                       substitutions_json, math_latex, needs_review, review_reasons_json, parent_question_id, repeat_of, saved,
                       created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET state = excluded.state, revision = excluded.revision, raw_text = excluded.raw_text,
                       formatted_text = excluded.formatted_text, resolved_text = excluded.resolved_text, kind = excluded.kind,
                       category = excluded.category, ended_at_ms = excluded.ended_at_ms, confidence_json = excluded.confidence_json,
                       subquestions_json = excluded.subquestions_json, scenario = excluded.scenario,
                       uncertain_json = excluded.uncertain_json, substitutions_json = excluded.substitutions_json,
                       math_latex = excluded.math_latex, needs_review = excluded.needs_review,
                       review_reasons_json = excluded.review_reasons_json, parent_question_id = excluded.parent_question_id,
                       repeat_of = excluded.repeat_of, saved = excluded.saved, updated_at = excluded.updated_at
                   WHERE excluded.revision >= questions.revision""",
                (
                    q.question_id, q.session_id, q.state.value, q.revision, q.raw_text, q.formatted_text, q.resolved_text,
                    q.kind.value, q.category.value, q.source.value, q.speaker, q.started_at_ms, q.ended_at_ms,
                    json.dumps(asdict(q.confidence)), json.dumps(q.subquestions), q.scenario,
                    json.dumps([asdict(s) for s in q.uncertain_spans]), json.dumps([asdict(s) for s in q.substitutions]),
                    q.math_latex, int(q.needs_review), json.dumps(q.review_reasons), q.parent_question_id, q.repeat_of,
                    int(q.saved), t, t,
                ),
            ),
            ("DELETE FROM question_segments WHERE question_id = ?", (q.question_id,)),
        ]
        stmts += [("INSERT OR IGNORE INTO question_segments(question_id, segment_id) VALUES (?, ?)", (q.question_id, s)) for s in q.source_segment_ids]
        stmts.append((
            "INSERT INTO question_revisions(question_id, revision, state, formatted_text, resolved_text, editor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (q.question_id, q.revision, q.state.value, q.formatted_text, q.resolved_text, editor, t),
        ))
        self._tx(stmts)

    def save_relationship(self, from_id: str, to_id: str, rel_type: str) -> None:
        self._exec(
            "INSERT OR IGNORE INTO question_relationships(from_question_id, to_question_id, type, created_at) VALUES (?, ?, ?, ?)",
            (from_id, to_id, rel_type, now_ms()),
        )

    def list_questions(self, session_id: Optional[str] = None, include_discarded: bool = False, saved_only: bool = False,
                       query: str = "", limit: int = 5000) -> list[Question]:
        sql = "SELECT * FROM questions WHERE 1=1"
        params: list[Any] = []
        if session_id:
            sql += " AND session_id = ?"
            params.append(session_id)
        if not include_discarded:
            sql += " AND state != 'DISCARDED'"
        if saved_only:
            sql += " AND saved = 1"
        if query:
            sql += " AND (formatted_text LIKE ? OR raw_text LIKE ? OR resolved_text LIKE ?)"
            params += [f"%{query}%"] * 3
        sql += " ORDER BY started_at_ms LIMIT ?"
        params.append(limit)
        rows = self._rows(sql, params)
        seg_map: dict[str, list[str]] = {}
        if rows:
            ids = [r["id"] for r in rows]
            for chunk_start in range(0, len(ids), 500):
                chunk = ids[chunk_start : chunk_start + 500]
                for r in self._rows(f"SELECT question_id, segment_id FROM question_segments WHERE question_id IN ({','.join('?' * len(chunk))})", chunk):
                    seg_map.setdefault(r["question_id"], []).append(r["segment_id"])
        return [_question_from_row(r, seg_map.get(r["id"], [])) for r in rows]

    def get_question(self, qid: str) -> Optional[Question]:
        r = self._row("SELECT * FROM questions WHERE id = ?", (qid,))
        if not r:
            return None
        segs = [x["segment_id"] for x in self._rows("SELECT segment_id FROM question_segments WHERE question_id = ?", (qid,))]
        return _question_from_row(r, segs)

    def question_history(self, qid: str) -> list[dict]:
        return self._rows("SELECT revision, state, formatted_text, resolved_text, editor, created_at FROM question_revisions WHERE question_id = ? ORDER BY id", (qid,))

    def list_relationships(self, session_id: str) -> list[dict]:
        return self._rows(
            "SELECT r.* FROM question_relationships r JOIN questions q ON q.id = r.from_question_id WHERE q.session_id = ?",
            (session_id,),
        )

    # --------------------------------------------------------------- vocabulary
    def list_vocabulary(self) -> list[dict]:
        out = []
        for r in self._rows("SELECT * FROM technical_vocabulary ORDER BY canonical COLLATE NOCASE"):
            out.append({
                "canonical": r["canonical"],
                "aliases": json.loads(r["aliases_json"]),
                "domains": json.loads(r["domains_json"]),
                "context": json.loads(r["context_json"]) if r["context_json"] else None,
                "context_domains": json.loads(r["context_domains_json"]),
                "disabled": bool(r["disabled"]),
            })
        return out

    def replace_vocabulary(self, terms: list[dict]) -> None:
        t = now_ms()
        stmts: list[tuple[str, tuple]] = [("DELETE FROM technical_vocabulary", ())]
        for d in terms:
            stmts.append((
                "INSERT OR REPLACE INTO technical_vocabulary(canonical, aliases_json, domains_json, context_json, context_domains_json, disabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (d["canonical"], json.dumps(d.get("aliases", [])), json.dumps(d.get("domains", ["GENERAL"])),
                 json.dumps(d["context"]) if d.get("context") else None, json.dumps(d.get("context_domains", [])), int(bool(d.get("disabled"))), t),
            ))
        self._tx(stmts)

    # --------------------------------------------------------------- events
    def record_event(self, session_id: Optional[str], seq: int, event_type: str, entity_id: Optional[str]) -> None:
        self._exec("INSERT INTO processing_events(session_id, seq, event_type, entity_id, created_at) VALUES (?, ?, ?, ?, ?)",
                   (session_id, seq, event_type, entity_id, now_ms()))

    def prune_events(self, keep: int = 20_000) -> None:
        self._exec("DELETE FROM processing_events WHERE id <= (SELECT MAX(id) FROM processing_events) - ?", (keep,))

    # --------------------------------------------------------------- screenshots
    def add_screenshot(self, row: dict) -> dict:
        self._exec(
            "INSERT INTO screenshots(id, session_id, file_name, thumb_name, width, height, format, bytes, sha256, mode, monitor, created_at) "
            "VALUES (:id, :session_id, :file_name, :thumb_name, :width, :height, :format, :bytes, :sha256, :mode, :monitor, :created_at)",
            row,
        )
        return row

    def screenshot_by_hash(self, sha: str) -> Optional[dict]:
        return self._row("SELECT * FROM screenshots WHERE sha256 = ?", (sha,))

    def get_screenshot(self, sid: str) -> Optional[dict]:
        return self._row("SELECT * FROM screenshots WHERE id = ?", (sid,))

    def list_screenshots(self, session_id: Optional[str] = None, limit: int = 2000) -> list[dict]:
        if session_id:
            return self._rows("SELECT * FROM screenshots WHERE session_id = ? ORDER BY created_at DESC LIMIT ?", (session_id, limit))
        return self._rows("SELECT * FROM screenshots ORDER BY created_at DESC LIMIT ?", (limit,))

    def delete_screenshot(self, sid: str) -> Optional[dict]:
        row = self.get_screenshot(sid)
        if row:
            self._exec("DELETE FROM screenshots WHERE id = ?", (sid,))
        return row

    # --------------------------------------------------------------- provider interactions
    def create_interaction(self, row: dict) -> None:
        self._exec(
            "INSERT INTO provider_interactions(id, session_id, provider_id, model, prompt, screenshot_ids_json, status, started_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
            (row["id"], row.get("session_id"), row["provider_id"], row.get("model"), row["prompt"], json.dumps(row.get("screenshot_ids", [])), now_ms()),
        )

    def update_interaction(self, iid: str, *, status: str, response: Optional[str] = None, error: Optional[str] = None, usage: Optional[dict] = None) -> None:
        done = status in ("completed", "failed", "cancelled")
        self._exec(
            "UPDATE provider_interactions SET status = ?, response = COALESCE(?, response), error = ?, usage_json = COALESCE(?, usage_json), "
            "completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE id = ?",
            (status, response, error, json.dumps(usage) if usage else None, int(done), now_ms(), iid),
        )

    def list_interactions(self, session_id: str) -> list[dict]:
        rows = self._rows("SELECT * FROM provider_interactions WHERE session_id = ? ORDER BY started_at", (session_id,))
        for r in rows:
            r["screenshot_ids"] = json.loads(r.pop("screenshot_ids_json"))
            r["usage"] = json.loads(r.pop("usage_json")) if r.get("usage_json") else None
        return rows

    # --------------------------------------------------------------- chat (the built-in chat tab)
    def create_chat(self, cid: str, title: str = "") -> dict:
        t = now_ms()
        self._exec("INSERT INTO chat_conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", (cid, title, t, t))
        return self.get_chat(cid)  # type: ignore[return-value]

    def get_chat(self, cid: str) -> Optional[dict]:
        return self._row(_CHAT_SUMMARY_SQL + " WHERE c.id = ?", (cid,))

    def list_chats(self, limit: int = 100) -> list[dict]:
        return self._rows(_CHAT_SUMMARY_SQL + " ORDER BY c.updated_at DESC LIMIT ?", (limit,))

    def update_chat(self, cid: str, *, title: Optional[str] = None, touch: bool = False) -> None:
        self._exec("UPDATE chat_conversations SET title = COALESCE(?, title), updated_at = CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?",
                   (title, int(touch), now_ms(), cid))

    def delete_chat(self, cid: str) -> None:
        self._exec("DELETE FROM chat_conversations WHERE id = ?", (cid,))

    def add_chat_message(self, row: dict) -> dict:
        t = now_ms()
        done = row["status"] != "streaming"
        self._exec(
            "INSERT INTO chat_messages(id, conversation_id, role, content, provider_id, model, status, screenshot_ids_json, created_at, completed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (row["id"], row["conversation_id"], row["role"], row.get("content", ""), row.get("provider_id"), row.get("model"), row["status"],
             json.dumps(row.get("screenshot_ids", [])), t, t if done else None),
        )
        return self.get_chat_message(row["id"])  # type: ignore[return-value]

    def get_chat_message(self, mid: str) -> Optional[dict]:
        r = self._row("SELECT * FROM chat_messages WHERE id = ?", (mid,))
        return _chat_message(r) if r else None

    def update_chat_message(self, mid: str, *, status: str, content: Optional[str] = None, error: Optional[dict] = None, usage: Optional[dict] = None,
                            model: Optional[str] = None) -> None:
        self._exec(
            "UPDATE chat_messages SET status = ?, content = COALESCE(?, content), error_json = ?, usage_json = COALESCE(?, usage_json), "
            "model = COALESCE(?, model), completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE id = ?",
            (status, content, json.dumps(error) if error else None, json.dumps(usage) if usage else None, model, int(status != "streaming"), now_ms(), mid),
        )

    def list_chat_messages(self, cid: str) -> list[dict]:
        return [_chat_message(r) for r in self._rows("SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY seq", (cid,))]

    def delete_chat_messages_after(self, cid: str, seq: int) -> None:
        self._exec("DELETE FROM chat_messages WHERE conversation_id = ? AND seq > ?", (cid, seq))

    def interrupt_streaming_chat_messages(self) -> None:
        """Answers that were still streaming when the engine stopped can never finish: mark them cancelled."""
        self._exec("UPDATE chat_messages SET status = 'cancelled', completed_at = ? WHERE status = 'streaming'", (now_ms(),))

    # --------------------------------------------------------------- settings
    def get_setting(self, key: str, default: Any = None) -> Any:
        r = self._row("SELECT value_json FROM settings WHERE key = ?", (key,))
        return json.loads(r["value_json"]) if r else default

    def set_setting(self, key: str, value: Any) -> None:
        self._exec("INSERT OR REPLACE INTO settings(key, value_json) VALUES (?, ?)", (key, json.dumps(value)))

    # --------------------------------------------------------------- purge
    def purge_all(self) -> list[dict]:
        shots = self._rows("SELECT * FROM screenshots")
        self._tx([
            ("DELETE FROM provider_interactions", ()),
            ("DELETE FROM chat_conversations", ()),
            ("DELETE FROM screenshots", ()),
            ("DELETE FROM processing_events", ()),
            ("DELETE FROM sessions", ()),
        ])
        with self._lock:
            self._conn.execute("VACUUM")
        return shots


_SESSION_SUMMARY_SQL = """
SELECT s.id, s.name, s.status, s.started_at, s.ended_at, s.last_activity_at, s.notes,
       (SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id AND q.state != 'DISCARDED') AS question_count,
       (SELECT COUNT(*) FROM screenshots x WHERE x.session_id = s.id) AS screenshot_count,
       (SELECT COUNT(*) FROM transcript_segments t WHERE t.session_id = s.id) AS segment_count
FROM sessions s"""


_CHAT_SUMMARY_SQL = """
SELECT c.id, c.title, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
FROM chat_conversations c"""


def _chat_message(r: dict) -> dict:
    error, usage = r.pop("error_json"), r.pop("usage_json")
    r["screenshot_ids"] = json.loads(r.pop("screenshot_ids_json", None) or "[]")
    r["error"] = json.loads(error) if error else None
    r["usage"] = json.loads(usage) if usage else None
    return r


def _split_sql(script: str) -> list[str]:
    return [s.strip() for s in script.split(";") if s.strip()]


def _question_from_row(r: dict, seg_ids: list[str]) -> Question:
    conf = json.loads(r["confidence_json"])
    return Question(
        question_id=r["id"],
        session_id=r["session_id"],
        state=QuestionState(r["state"]),
        revision=r["revision"],
        raw_text=r["raw_text"],
        formatted_text=r["formatted_text"],
        resolved_text=r["resolved_text"],
        kind=QuestionKind(r["kind"]),
        category=QuestionCategory(r["category"]),
        source_segment_ids=seg_ids,
        started_at_ms=r["started_at_ms"],
        ended_at_ms=r["ended_at_ms"],
        source=AudioSource(r["source"]),
        speaker=r["speaker"],
        confidence=Confidence(**conf),
        subquestions=json.loads(r["subquestions_json"]),
        scenario=r["scenario"],
        uncertain_spans=[Span(**s) for s in json.loads(r["uncertain_json"])],
        substitutions=[Substitution(**s) for s in json.loads(r["substitutions_json"])],
        math_latex=r["math_latex"],
        needs_review=bool(r["needs_review"]),
        review_reasons=json.loads(r["review_reasons_json"]),
        parent_question_id=r["parent_question_id"],
        repeat_of=r["repeat_of"],
        saved=bool(r["saved"]),
    )


def segment_from_row(r: dict) -> TranscriptSegment:
    return TranscriptSegment(
        segment_id=r["segment_id"], revision=r["revision"], text=r["text"], start_ms=r["start_ms"], end_ms=r["end_ms"],
        is_final=bool(r["is_final"]), source=AudioSource(r["source"]), speaker=r["speaker"], confidence=r["confidence"],
        words=tuple(WordInfo(**w) for w in r.get("words", [])), language=r.get("language"),
    )
