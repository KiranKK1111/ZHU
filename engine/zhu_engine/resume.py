"""The user's résumé: text extracted from an uploaded file, and how it is handed to a model.

Nothing about the résumé is interpreted here. There are no keyword lists and no prepared answers:
the text is given to the model with one instruction, and the model decides for each question
whether it is about the user and what in the résumé answers it.

The file itself is not kept. Only its text is stored (in the settings table), so it can be shown,
switched off, and deleted.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import PurePath
from typing import Optional
from xml.etree import ElementTree

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 40
MAX_DOCX_XML_BYTES = 30 * 1024 * 1024
# A long résumé is about 10,000 characters. More than this is cut, so every question stays small
# enough for free models; the user is told when that happens.
MAX_CHARS = 24_000
EXTENSIONS = (".pdf", ".docx", ".txt", ".md")

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

INSTRUCTION = (
    "The user's résumé is given below, between <resume> tags. Whenever a question is about the user "
    "(their background, experience, projects, skills, education, achievements, strengths, motivation, "
    "or anything else about them as a person or a candidate), answer it from the résumé, in the first "
    "person, the way the user would say it themself. Choose what is relevant to the question that was "
    "asked. Use only facts the résumé states; where it does not cover something, say what is missing "
    "instead of inventing it. For questions that are not about the user, answer as usual and do not "
    "bring the résumé up."
)


class ResumeError(ValueError):
    """The file cannot be used; the message is shown to the user."""


def _from_pdf(data: bytes) -> str:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ResumeError("This PDF is password-protected. Save a copy without a password and upload that.")
        pages = [page.extract_text() or "" for page in reader.pages[:MAX_PDF_PAGES]]
    except ResumeError:
        raise
    except (PyPdfError, ValueError, KeyError, OSError, RecursionError) as exc:
        raise ResumeError("This PDF could not be read. Try exporting it again, or upload a Word or text file.") from exc
    return "\n\n".join(pages)


def _from_docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > MAX_DOCX_XML_BYTES:
                raise ResumeError("This document is too large.")
            root = ElementTree.fromstring(archive.read(info))
    except ResumeError:
        raise
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError) as exc:
        raise ResumeError("This Word file could not be read. Save it as .docx (not .doc) or as a PDF and upload that.") from exc
    lines: list[str] = []
    for paragraph in root.iter(_W + "p"):
        parts: list[str] = []
        for node in paragraph.iter():
            if node.tag == _W + "t":
                parts.append(node.text or "")
            elif node.tag == _W + "tab":
                parts.append("\t")
            elif node.tag in (_W + "br", _W + "cr"):
                parts.append("\n")
        lines.append("".join(parts))
    return "\n".join(lines)


def _from_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeError:
            continue
    raise ResumeError("This text file could not be read.")


def _tidy(text: str) -> str:
    """Plain text with blank runs collapsed, as a model (and the preview) reads it best."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t\f\v ]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_text(file_name: str, data: bytes) -> tuple[str, bool]:
    """Return ``(text, truncated)`` for an uploaded résumé, or raise ResumeError with a message for the user."""
    suffix = PurePath(file_name or "").suffix.lower()
    if suffix not in EXTENSIONS:
        raise ResumeError("Upload a PDF, a Word document (.docx) or a text file.")
    if not data:
        raise ResumeError("The file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ResumeError("The file is larger than 10 MB.")
    raw = _from_pdf(data) if suffix == ".pdf" else _from_docx(data) if suffix == ".docx" else _from_text(data)
    text = _tidy(raw)
    if len(text) < 40:
        if suffix == ".pdf":
            raise ResumeError("No text was found in this PDF. It may be a scan; upload a PDF with selectable text, or a Word or text file.")
        raise ResumeError("No text was found in this file.")
    if len(text) <= MAX_CHARS:
        return text, False
    cut = text[:MAX_CHARS]
    return cut[: cut.rfind("\n")].rstrip() if "\n" in cut[MAX_CHARS // 2:] else cut.rstrip(), True


def prompt_block(text: Optional[str]) -> str:
    """The part of a system prompt that carries the résumé; empty when there is none."""
    if not text or not text.strip():
        return ""
    # The closing tag cannot be forged from inside the résumé text.
    body = text.replace("</resume>", "< /resume>")
    return f"{INSTRUCTION}\n<resume>\n{body}\n</resume>"
