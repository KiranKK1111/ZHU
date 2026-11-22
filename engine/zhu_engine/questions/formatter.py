"""Question formatting and multi-part decomposition (Master Prompt 01, sections 5.5 and 10).

The formatter only restructures what was said: discourse markers, casing,
punctuation, and embedded-question word order. It never adds technical content.
"""

from __future__ import annotations

import re

from .candidate import CandidateSignal, detect_candidate, strip_discourse
from .text import AUXILIARIES, IMPERATIVE_VERBS, WH_WORDS, capitalize_first, collapse_ws, strip_terminal_punct, words

_EMBED_VERBS = r"(?:explain|tell\s+(?:me|us)|describe|know|understand|show\s+(?:me|us)|wondering|ask\s+you|clarify|elaborate\s+on)"
_NP_STOP = r"(?=\s+(?:and|or|but|in|on|for|with|within|inside|when|if|compared|versus|vs)\b|\s*[,?.!;]|\s*$)"
_EMBEDDED_INVERSION = re.compile(
    rf"\b({_EMBED_VERBS})\s+(what|who|where|how|why|which)\s+(is|are|was|were)\s+((?:(?!\s(?:and|or|but)\b)[^,?.!;]){{1,60}}?){_NP_STOP}",
    re.IGNORECASE,
)


def fix_embedded_question(text: str) -> str:
    """'explain what is dependency injection and how' -> 'explain what dependency injection is and how'."""

    def repl(m: re.Match[str]) -> str:
        np = m.group(4).strip()
        if len(np.split()) > 6 or np.lower().split()[0] in AUXILIARIES:
            return m.group(0)
        return f"{m.group(1)} {m.group(2)} {np} {m.group(3)}"

    return _EMBEDDED_INVERSION.sub(repl, text)


def _is_interrogative_form(text: str) -> bool:
    ws = words(text)
    if not ws:
        return False
    if ws[0] in WH_WORDS:
        return True
    if ws[0] in AUXILIARIES and len(ws) > 1:
        return True
    return False


def format_question(text: str, signal: CandidateSignal | None = None) -> str:
    t = strip_discourse(collapse_ws(text))
    t = re.sub(r"^(?:so|and|okay|now)\b[,\s]*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"(?:\.\.\.|…)\s+(?=\S)", " ", t)  # spoken pauses inside a question
    t = fix_embedded_question(t)
    t = re.sub(r"\bi\b", "I", t)
    t = re.sub(r"\bi'(m|ve|d|ll)\b", lambda m: "I'" + m.group(1), t)
    t = t.rstrip()
    trailing_ellipsis = t.endswith(("...", "…"))
    core = strip_terminal_punct(t)
    core = capitalize_first(core)
    if not core:
        return ""
    if trailing_ellipsis:
        return core + "..."
    interrogative = _is_interrogative_form(core) or (signal is not None and signal.interrogative_form and not _is_imperative(core))
    return core + ("?" if interrogative else ".")


def _is_imperative(text: str) -> bool:
    ws = words(text)
    return bool(ws) and ws[0] in IMPERATIVE_VERBS


# ---------------------------------------------------------------- multi-part

_SPLIT_RE = re.compile(r"\s*(?:;|,\s*(?:and\s+(?:also\s+)?|also\s+|then\s+|and\s+then\s+)?|\s+and\s+(?:also\s+|then\s+)?)\s*", re.IGNORECASE)


def _clause_starts_question(clause: str, after_comma: bool) -> bool:
    ws = words(clause)
    if not ws:
        return False
    w0 = ws[0]
    w1 = ws[1] if len(ws) > 1 else ""
    if w0 in WH_WORDS:
        # "how would you ..." is a question clause; "how spring manages beans" is embedded.
        return w1 in AUXILIARIES or after_comma and w1 in {"to"}
    if w0 in AUXILIARIES and w1 in {"you", "we", "it", "there", "they", "i"}:
        return True
    if w0 in IMPERATIVE_VERBS and after_comma:
        if w0 in {"tell", "give", "show", "walk"}:
            return w1 in {"me", "us"}
        return True
    return False


def split_multipart(text: str) -> list[str]:
    """Split a combined question into parts. Returns [] if it is a single question."""
    core = strip_terminal_punct(strip_discourse(text))
    pieces: list[tuple[str, bool]] = []
    pos = 0
    pending_after_comma = False
    for m in _SPLIT_RE.finditer(core):
        clause = core[m.end() :]
        sep = m.group(0)
        after_comma = "," in sep or ";" in sep
        if _clause_starts_question(clause, after_comma):
            pieces.append((core[pos : m.start()], pending_after_comma))
            pos = m.end()
            pending_after_comma = after_comma
    pieces.append((core[pos:], pending_after_comma))
    parts = [p.strip() for p, _ in pieces if p.strip()]
    if len(parts) < 2:
        return []
    if not detect_candidate(parts[0]).is_candidate:
        return []
    return parts


_SUB_REWRITES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^(?:explain|describe|tell\s+me)\s+(the\s+differences?\s+between\s+.+)$", re.IGNORECASE), r"What is \1"),
    (re.compile(r"^tell\s+(?:me|us)\s+when\s+to\s+use\s+(each(?:\s+one)?|them|it|both)$", re.IGNORECASE), r"When should \1 be used"),
    (re.compile(r"^tell\s+(?:me|us)\s+when\s+to\s+use\s+(.+)$", re.IGNORECASE), r"When should you use \1"),
]


def format_subquestion(part: str) -> str:
    p = strip_terminal_punct(part.strip())
    for rx, repl in _SUB_REWRITES:
        if rx.match(p):
            p = rx.sub(repl, p)
            q = capitalize_first(p)
            return q + "?"
    return format_question(p)
