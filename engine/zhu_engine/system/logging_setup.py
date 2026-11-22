"""Logging with redaction. API keys, bearer tokens, and transcript content never reach log files."""

from __future__ import annotations

import logging
import logging.handlers
import re
import sys
from pathlib import Path

_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_\-]{12,}"),  # OpenAI / DeepSeek style
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"xai-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{16,}"),
    re.compile(r"(?i)(x-api-key[\"']?\s*[:=]\s*[\"']?)[A-Za-z0-9._\-]{8,}"),
    re.compile(r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?)[^\s\"',]{8,}"),
    re.compile(r"(?i)(token=)[A-Za-z0-9._\-]{16,}"),
]


def redact(text: str) -> str:
    for p in _SECRET_PATTERNS:
        text = p.sub(lambda m: (m.group(1) if m.groups() else "") + "[REDACTED]", text)
    return text


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        record.msg = redact(msg)
        record.args = ()
        return True


def configure_logging(log_dir: Path, level: str = "INFO") -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    file_handler = logging.handlers.RotatingFileHandler(log_dir / "engine.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(fmt)
    file_handler.addFilter(RedactingFilter())
    handlers: list[logging.Handler] = [file_handler]
    if sys.stderr is not None:  # None in a frozen windowed build
        console = logging.StreamHandler()
        console.setFormatter(fmt)
        console.addFilter(RedactingFilter())
        handlers.append(console)
    root = logging.getLogger()
    # The engine can be started more than once in one process (embedded.py): the handlers of the
    # run before are closed, or two of them would hold the log file and it could not be rotated.
    for old in root.handlers:
        try:
            old.close()
        except Exception:  # noqa: BLE001 - a handler that cannot close must not stop the engine
            pass
    root.handlers[:] = handlers
    root.setLevel(level)
    for noisy in ("httpx", "httpcore", "uvicorn.access", "faster_whisper"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
