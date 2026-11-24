# Database Schema

SQLite at `%LOCALAPPDATA%\app.zhu.desktop\data\zhu.db` with WAL journaling, `foreign_keys=ON`, and `synchronous=NORMAL`. Migrations are append-only (`engine/zhu_engine/storage/migrations.py`) and recorded in `schema_migrations`. Each one runs in a single transaction. Never edit an applied migration; add version N+1. Additive changes keep older data readable.

```text
sessions ─┬─< transcript_segments            (UNIQUE session_id+segment_id; newest revision wins)
          ├─< questions ─┬─< question_segments   (source segment references)
          │              ├─< question_revisions  (every saved revision + editor: engine|user|merge|split)
          │              └─< question_relationships (FOLLOW_UP | REPEAT_OF | MERGED_FROM | SPLIT_FROM)
          ├─< screenshots (ON DELETE SET NULL; sha256 UNIQUE = pixel-level dedupe)
          └─< provider_interactions (status pending|streaming|completed|failed|cancelled)
chat_conversations ──< chat_messages (the Custom chat; migration 2; status streaming|completed|failed|cancelled)
technical_vocabulary   (user terms; built-ins ship in vocabulary.json)
processing_events      (event audit trail: seq, type, entity id; bounded by prune_events)
settings               (key → JSON: engine_settings, providers, resumes, job)
schema_migrations
```

| Table | Key columns |
|---|---|
| `sessions` | `id`, `name`, `status` (active / ended), `started_at`, `ended_at`, `last_activity_at`, `notes`, `metadata_json` |
| `transcript_segments` | `segment_id`, `revision`, `source`, `speaker`, `text` (raw STT), `corrected_text` (user correction; raw kept), `start_ms`/`end_ms` (session clock), `is_final`, `confidence`, `language`, `words_json` |
| `questions` | `id`, `state`, `revision`, `raw_text`, `formatted_text`, `resolved_text`, `kind`, `category`, `source`, `speaker`, `started_at_ms`, `ended_at_ms`, `confidence_json`, `subquestions_json`, `scenario`, `uncertain_json`, `substitutions_json`, `math_latex`, `needs_review`, `review_reasons_json`, `parent_question_id`, `repeat_of`, `saved` |
| `screenshots` | `file_name`, `thumb_name` (files in `screenshots/`), `width`, `height`, `format`, `bytes`, `sha256`, `mode` (monitor / all / window / region), `monitor` |
| `provider_interactions` | `provider_id`, `model`, `prompt`, `screenshot_ids_json`, `response`, `status`, `error`, `usage_json` |
| `chat_conversations` | `id`, `title` (from the first message), `created_at`, `updated_at` |
| `chat_messages` | `seq` (order), `id`, `conversation_id`, `role` (user / assistant), `content` (an answer may start with a `<think>` block), `provider_id`, `model`, `status`, `error_json`, `usage_json`, `screenshot_ids_json` (migration 3: screenshots sent with a user's message) |
| `settings` → `resumes` | `items` (at most 10: `id`, `label`, `file_name`, `text` (what models receive, at most 24,000 characters), `file_text` (the text read from the file, kept only while the user's edits differ from it), `truncated`, `ocr`, `uploaded_at`, `edited_at`), `active_id`, `enabled`. The single `resume` of earlier versions is moved into `items` the first time it is read (`engine/zhu_engine/profile.py`) |
| `settings` → `job` | `title`, `text` (at most 12,000 characters), `enabled`, `truncated`, `ocr`, `source` (the file it was read from; null when typed), `updated_at` |

## Crash recovery

Sessions still marked `active` after an unexpected termination (an engine crash or a killed process) stay **active and resumable**. The user can press Start listening to continue recording into the same session. Recording never resumes on its own. Verified: when the engine process was killed during a test run, the shell restarted it within about 1 s and both windows reconnected. Question upserts are guarded by `revision`, so a stale write can never overwrite a newer one. After a restart the engine restores each session's questions into a new `QuestionEngine` (`restore()`), so context resolution and duplicate detection keep working.

## Credentials

Credentials are never stored in this database. See SECURITY_PRIVACY.md §5.
