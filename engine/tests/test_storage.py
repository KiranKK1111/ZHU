from __future__ import annotations

from zhu_engine.questions import AudioSource, TranscriptSegment
from zhu_engine.storage.db import Database, segment_from_row
from zhu_engine.storage.migrations import MIGRATIONS

from .helpers import make_feeder


def test_migrations_idempotent(tmp_path):
    db = Database(tmp_path / "a.db")
    v = db.schema_version()
    db.migrate()
    assert db.schema_version() == v == MIGRATIONS[-1][0]
    db.close()
    db2 = Database(tmp_path / "a.db")  # reopen: no re-application
    assert db2.schema_version() == v


def test_session_lifecycle_and_crash_recovery(tmp_path):
    db = Database(tmp_path / "a.db")
    db.create_session("s1", "Mock interview")
    db.update_session("s1", name="Renamed", notes="notes")
    assert db.get_session("s1")["name"] == "Renamed"
    # Simulate an unexpected termination: the session stays active (resumable) after reopening.
    db.close()
    db = Database(tmp_path / "a.db")
    assert db.get_session("s1")["status"] == "active"
    # end_dangling_sessions remains available for an explicit "close stale sessions" action.
    assert db.end_dangling_sessions() == ["s1"]
    row = db.get_session("s1")
    assert row["status"] == "ended" and row["ended_at"] == row["last_activity_at"]


def test_segment_upsert_keeps_newest_revision(tmp_path):
    db = Database(tmp_path / "a.db")
    db.create_session("s1", "x")
    db.upsert_segment("s1", TranscriptSegment("seg", 3, "final text", 0, 1000, True, AudioSource.SYSTEM))
    db.upsert_segment("s1", TranscriptSegment("seg", 2, "older", 0, 1000, False, AudioSource.SYSTEM))
    rows = db.list_segments("s1")
    assert len(rows) == 1 and rows[0]["text"] == "final text"
    corrected = db.correct_segment(rows[0]["id"], "corrected")
    assert corrected["corrected_text"] == "corrected" and corrected["text"] == "final text"  # raw preserved
    assert segment_from_row(rows[0]).text == "final text"


def test_question_roundtrip_revisions_and_cascade(tmp_path):
    db = Database(tmp_path / "a.db")
    db.create_session("session-test", "x")
    f = make_feeder()
    f.say("What is HashMap in Java?")
    f.say("How is it different from TreeMap?")
    for q in f.engine.questions.values():
        db.save_question(q)
    for r in f.engine.relationships:
        db.save_relationship(r.from_question_id, r.to_question_id, r.type.value)
    loaded = db.list_questions("session-test")
    assert [q.formatted_text for q in loaded] == ["What is HashMap in Java?", "How is it different from TreeMap?"]
    assert loaded[1].resolved_text == "How is HashMap different from TreeMap in Java?"
    assert loaded[1].source_segment_ids
    assert db.list_relationships("session-test")[0]["type"] == "FOLLOW_UP"
    # stale revision does not overwrite
    q = f.engine.questions[loaded[0].question_id]
    stale = type(q)(**{**q.__dict__, "revision": 0, "formatted_text": "stale"})
    db.save_question(stale)
    assert db.get_question(q.question_id).formatted_text == "What is HashMap in Java?"
    assert len(db.question_history(q.question_id)) >= 1
    db.delete_session("session-test")
    assert db.list_questions("session-test") == []


def test_screenshot_named_params_and_dedupe(tmp_path):
    db = Database(tmp_path / "a.db")
    db.create_session("s1", "x")
    row = {"id": "s_a", "session_id": "s1", "file_name": "f.png", "thumb_name": "t.webp", "width": 10, "height": 10, "format": "png",
           "bytes": 1, "sha256": "abc", "mode": "monitor", "monitor": 1, "created_at": 1}
    db.add_screenshot(row)
    assert db.screenshot_by_hash("abc")["session_id"] == "s1"
    db.delete_session("s1")
    assert db.get_screenshot("s_a") is None


def test_purge_all(tmp_path):
    db = Database(tmp_path / "a.db")
    db.create_session("s1", "x")
    db.purge_all()
    assert db.list_sessions() == []
