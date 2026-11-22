"""Ordered, append-only schema migrations. Never edit an applied migration; add a new one."""

MIGRATIONS: list[tuple[int, str]] = [
    (
        1,
        """
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            last_activity_at INTEGER NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE transcript_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            segment_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            source TEXT NOT NULL,
            speaker TEXT NOT NULL DEFAULT 'unknown',
            text TEXT NOT NULL,
            corrected_text TEXT,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            is_final INTEGER NOT NULL,
            confidence REAL,
            language TEXT,
            words_json TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL,
            UNIQUE (session_id, segment_id)
        );
        CREATE INDEX ix_segments_session_time ON transcript_segments(session_id, start_ms);

        CREATE TABLE questions (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            state TEXT NOT NULL,
            revision INTEGER NOT NULL,
            raw_text TEXT NOT NULL,
            formatted_text TEXT NOT NULL,
            resolved_text TEXT,
            kind TEXT NOT NULL,
            category TEXT NOT NULL,
            source TEXT NOT NULL,
            speaker TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER,
            confidence_json TEXT NOT NULL,
            subquestions_json TEXT NOT NULL DEFAULT '[]',
            scenario TEXT,
            uncertain_json TEXT NOT NULL DEFAULT '[]',
            substitutions_json TEXT NOT NULL DEFAULT '[]',
            math_latex TEXT,
            needs_review INTEGER NOT NULL DEFAULT 0,
            review_reasons_json TEXT NOT NULL DEFAULT '[]',
            parent_question_id TEXT,
            repeat_of TEXT,
            saved INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX ix_questions_session ON questions(session_id, started_at_ms);

        CREATE TABLE question_segments (
            question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            segment_id TEXT NOT NULL,
            PRIMARY KEY (question_id, segment_id)
        );

        CREATE TABLE question_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            state TEXT NOT NULL,
            formatted_text TEXT NOT NULL,
            resolved_text TEXT,
            editor TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX ix_revisions_question ON question_revisions(question_id, revision);

        CREATE TABLE question_relationships (
            from_question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
            to_question_id TEXT NOT NULL,
            type TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (from_question_id, to_question_id, type)
        );

        CREATE TABLE technical_vocabulary (
            canonical TEXT PRIMARY KEY,
            aliases_json TEXT NOT NULL,
            domains_json TEXT NOT NULL,
            context_json TEXT,
            context_domains_json TEXT NOT NULL DEFAULT '[]',
            disabled INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE processing_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            seq INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            entity_id TEXT,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX ix_events_session ON processing_events(session_id, id);

        CREATE TABLE screenshots (
            id TEXT PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            file_name TEXT NOT NULL,
            thumb_name TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            format TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            sha256 TEXT NOT NULL UNIQUE,
            mode TEXT NOT NULL,
            monitor INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX ix_screenshots_created ON screenshots(created_at);

        CREATE TABLE provider_interactions (
            id TEXT PRIMARY KEY,
            session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            provider_id TEXT NOT NULL,
            model TEXT,
            prompt TEXT NOT NULL,
            screenshot_ids_json TEXT NOT NULL DEFAULT '[]',
            response TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK (status IN ('pending','streaming','completed','failed','cancelled')),
            error TEXT,
            usage_json TEXT,
            started_at INTEGER NOT NULL,
            completed_at INTEGER
        );
        CREATE INDEX ix_interactions_session ON provider_interactions(session_id, started_at);

        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL
        );
        """,
    ),
    (
        2,
        """
        CREATE TABLE chat_conversations (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE chat_messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user','assistant')),
            content TEXT NOT NULL DEFAULT '',
            provider_id TEXT,
            model TEXT,
            status TEXT NOT NULL CHECK (status IN ('streaming','completed','failed','cancelled')),
            error_json TEXT,
            usage_json TEXT,
            created_at INTEGER NOT NULL,
            completed_at INTEGER
        );
        CREATE INDEX ix_chat_messages_conversation ON chat_messages(conversation_id, seq);
        """,
    ),
    (
        3,
        """
        ALTER TABLE chat_messages ADD COLUMN screenshot_ids_json TEXT NOT NULL DEFAULT '[]';
        """,
    ),
]
