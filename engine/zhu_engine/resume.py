"""The user's resume and the job they are applying for: text read from a file, and how it is given to
a model (the system prompt) or to a chat website (a file or a block of text in the first message).

Nothing about the resume is interpreted here. There are no keyword lists and no prepared answers:
the text is given to the model with one instruction, and the model decides for each question
whether it is about the user and what in the resume answers it.

Files are not kept. Only their text is stored (profile.py), so it can be shown, corrected,
switched off and deleted.
"""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from pathlib import PurePath
from typing import NamedTuple, Optional
from xml.etree import ElementTree

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 40
# Recognizing text in a picture takes about a second per page; a resume is one to three pages.
MAX_OCR_PAGES = 10
MAX_DOCX_XML_BYTES = 30 * 1024 * 1024
# A long resume is about 10,000 characters. More than this is cut, so every question stays small
# enough for free models; the user is told when that happens.
MAX_CHARS = 24_000
# A job description is a page or two.
MAX_JOB_CHARS = 12_000
MAX_TITLE_CHARS = 120
MIN_TEXT_CHARS = 40
TEXT_EXTENSIONS = (".pdf", ".docx", ".txt", ".md")
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")
EXTENSIONS = TEXT_EXTENSIONS + IMAGE_EXTENSIONS

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
_PART = re.compile(r"word/(header|footer)\d*\.xml")

INSTRUCTION = (
    "The user's resume is given below, between <resume> tags (the full text, or a condensed profile of it "
    "with its facts kept exactly). Whenever a question is about the user "
    "(their background, experience, projects, skills, education, achievements, strengths, motivation, "
    "or anything else about them as a person or a candidate), answer it from the resume, in the first "
    "person, the way the user would say it themself. Choose what is relevant to the question that was "
    "asked. Use only facts the resume states; where it does not cover something, say what is missing "
    "instead of inventing it. For questions that are not about the user, answer as usual and do not "
    "bring the resume up."
)
JOB_INSTRUCTION = (
    "The job the user is applying for is described between <job> tags. When a question is about the user, "
    "connect their experience to what this role asks for where it fits, without claiming anything the resume "
    "does not state. For other questions, use the job description only where it is relevant."
)
JOB_ONLY_INSTRUCTION = (
    "The job the user is applying for is described below, between <job> tags. Where it is relevant to a "
    "question, shape the answer to what this role asks for. Do not invent facts about the user."
)


# ------------------------------------------------------------------ read once, condensed once
# The resume is read from its file once, at upload. Models keep nothing between requests, so it has
# to go with every question; what goes is a short profile made from it once, by one model call, and
# kept with the resume until its text changes. It sits at the same place at the start of every
# request, where providers that cache a repeated beginning (Claude, OpenAI, DeepSeek, Gemini) serve
# it from their cache. The job is condensed the same way. Chat websites get the full text, once per
# chat (chat_context below).

#: Below this many words the text is about as small as a profile of it would be: it goes as it is.
CONDENSE_FROM_WORDS = {"resume": 400, "job": 250}
#: The longest condensed text kept (a model that ignores the length asked for is cut here).
MAX_CONDENSED_CHARS = 4_000
CONDENSE_SYSTEM = {
    "resume": (
        "Condense the resume below into a compact profile that an assistant will use to answer interview "
        "questions in the candidate's own voice. Write plain lines only, with no introduction, no headings in "
        "bold and no commentary. Include: the name; the current or most recent role and the total years of "
        "experience; every role (company, title, dates) with its one or two most important results, keeping "
        "their numbers; notable projects; skills, grouped; education and certifications; anything else about "
        "the person the resume states. Copy names, numbers, dates and technologies exactly. Do not add, guess "
        "or embellish anything. At most 300 words."
    ),
    "job": (
        "Condense the job description below into a compact brief that an assistant will use to tailor "
        "interview answers. Write plain lines only, with no introduction and no commentary. Include: the job "
        "title and company; what the role does; the required skills and experience; the nice-to-haves; "
        "anything the employer stresses. Copy names and technologies exactly. Do not add or guess anything. "
        "At most 150 words."
    ),
}
_THINKING = re.compile(r"<think>.*?</think>", re.S | re.I)


def source_key(text: str) -> str:
    """Which text a condensed profile was made from: it is used only while that text is unchanged."""
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()[:16]


def worth_condensing(kind: str, text: str) -> bool:
    return len((text or "").split()) >= CONDENSE_FROM_WORDS[kind]


def condense_prompt(kind: str, text: str) -> tuple[str, str]:
    """The system prompt and the message of the one call that condenses the resume (or the job)."""
    tag = "resume" if kind == "resume" else "job"
    return CONDENSE_SYSTEM[kind], f"<{tag}>\n{_guard(text.strip())}\n</{tag}>"


def clean_condensed(text: str) -> Optional[str]:
    """The model's profile as it is kept, or None when it gave nothing usable."""
    out = _THINKING.sub("", text or "").strip()
    out = re.sub(r"^```[a-z]*\n|\n?```$", "", out).strip()
    out = _tidy(out)
    if len(out) < MIN_TEXT_CHARS:
        return None
    return _cut(out, MAX_CONDENSED_CHARS)[0]


class ResumeError(ValueError):
    """The file or text cannot be used; the message is shown to the user."""


class Extracted(NamedTuple):
    text: str
    truncated: bool
    #: The text was recognized in a picture (a scan or a photo), so it may contain misread words.
    ocr: bool


# ------------------------------------------------------------------ PDF
def _page_pictures(page) -> list:
    """The pictures on a PDF page that can hold its text: the largest, and any others nearly as large."""
    found = []
    try:
        for item in page.images:
            try:
                img = item.image
                if img is not None:
                    found.append(img)
            except Exception:  # noqa: BLE001 - an image pypdf cannot decode is skipped, not fatal
                continue
    except Exception:  # noqa: BLE001
        return []
    if not found:
        return []
    largest = max(i.width * i.height for i in found)
    return [i for i in found if i.width * i.height >= largest * 0.1 and min(i.size) >= 64][:4]


def _from_pdf(data: bytes) -> tuple[str, bool]:
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ResumeError("This PDF is password-protected. Save a copy without a password and upload that.")
        pages = list(reader.pages[:MAX_PDF_PAGES])
        text = "\n\n".join(page.extract_text() or "" for page in pages)
        if len(_tidy(text)) >= MIN_TEXT_CHARS:
            return text, False
        # No text layer: a scan. Read the text in the page pictures.
        pictures = [p for page in pages[:MAX_OCR_PAGES] for p in _page_pictures(page)]
    except ResumeError:
        raise
    except (PyPdfError, ValueError, KeyError, OSError, RecursionError) as exc:
        raise ResumeError("This PDF could not be read. Try exporting it again, or upload a Word or text file.") from exc
    if not pictures:
        return text, False
    return "\n\n".join(_recognize(pictures)), True


# ------------------------------------------------------------------ Word
def _alternate(node):
    """Word saves some content twice: a modern form (Choice) and an older copy (Fallback). Read one."""
    choice = node.find(_MC + "Choice")
    return choice if choice is not None else node.find(_MC + "Fallback")


def _block(node, out: list[str]) -> None:
    """Paragraphs in document order. A text box's paragraphs follow the paragraph it is anchored in."""
    for child in node:
        if child.tag == _W + "p":
            nested: list[str] = []
            out.append("".join(_inline(child, nested)))
            out.extend(nested)
        elif child.tag == _MC + "AlternateContent":
            pick = _alternate(child)
            if pick is not None:
                _block(pick, out)
        else:
            _block(child, out)


def _inline(node, nested: list[str]) -> list[str]:
    parts: list[str] = []
    for child in node:
        tag = child.tag
        if tag == _W + "t":
            parts.append(child.text or "")
        elif tag == _W + "tab":
            parts.append("\t")
        elif tag in (_W + "br", _W + "cr"):
            parts.append("\n")
        elif tag == _W + "noBreakHyphen":
            parts.append("-")
        elif tag == _W + "txbxContent":
            _block(child, nested)  # not part of this paragraph's own line
        elif tag == _MC + "AlternateContent":
            pick = _alternate(child)
            if pick is not None:
                parts += _inline(pick, nested)
        else:
            parts += _inline(child, nested)  # runs, hyperlinks, fields, drawings; deleted text (w:delText) is skipped
    return parts


def _lines(xml: bytes) -> list[str]:
    out: list[str] = []
    _block(ElementTree.fromstring(xml), out)
    return out


def _from_docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            body = archive.getinfo("word/document.xml")
            extra = sorted((i for i in archive.infolist() if _PART.fullmatch(i.filename)), key=lambda i: i.filename)
            if body.file_size + sum(i.file_size for i in extra) > MAX_DOCX_XML_BYTES:
                raise ResumeError("This document is too large.")
            lines = _lines(archive.read(body))
            headers = [ln for i in extra if "/header" in i.filename for ln in _lines(archive.read(i))]
            footers = [ln for i in extra if "/footer" in i.filename for ln in _lines(archive.read(i))]
    except ResumeError:
        raise
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError, OSError, RecursionError) as exc:
        raise ResumeError("This Word file could not be read. Save it as .docx (not .doc) or as a PDF and upload that.") from exc
    # Page headers often hold the name and the contact details; footers, a line of links. Word keeps
    # a header per kind of page (first, odd, even), often with the same text, so each line is kept once.
    seen = {ln.strip() for ln in lines if ln.strip()}
    top = _unique(headers, seen)
    bottom = _unique(footers, seen)
    return "\n".join(top + lines + bottom)


def _unique(lines: list[str], seen: set[str]) -> list[str]:
    out = []
    for ln in lines:
        key = ln.strip()
        if key and key not in seen:
            seen.add(key)
            out.append(ln)
    return out


# ------------------------------------------------------------------ text and pictures
def _from_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeError:
            continue
    raise ResumeError("This text file could not be read.")


def _from_image(data: bytes) -> str:
    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ResumeError("This picture could not be opened. Upload a PNG or JPEG, a PDF, a Word or a text file.") from exc
    return _recognize([img])[0]


def _recognize(pictures: list) -> list[str]:
    from . import ocr

    try:
        return ocr.recognize(pictures)
    except ocr.OcrUnavailable as exc:
        raise ResumeError(f"This file is a picture of text, which ZHU reads with Windows text recognition: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - any failure inside Windows' recognizer
        raise ResumeError("The text in this picture could not be read. Upload a PDF with selectable text, a Word or a text file.") from exc


def _tidy(text: str) -> str:
    """Plain text with blank runs collapsed, as a model (and the preview) reads it best."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t\f\v ]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _cut(text: str, limit: int) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    cut = text[:limit]
    return (cut[: cut.rfind("\n")].rstrip() if "\n" in cut[limit // 2:] else cut.rstrip()), True


def extract_text(file_name: str, data: bytes, limit: int = MAX_CHARS) -> Extracted:
    """The text of an uploaded file, or ResumeError with a message for the user."""
    suffix = PurePath(file_name or "").suffix.lower()
    if suffix not in EXTENSIONS:
        raise ResumeError("Upload a PDF, a Word document (.docx), a text file, or a picture of the page (PNG or JPEG).")
    if not data:
        raise ResumeError("The file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise ResumeError("The file is larger than 10 MB.")
    ocr = suffix in IMAGE_EXTENSIONS
    if suffix == ".pdf":
        raw, ocr = _from_pdf(data)
    elif suffix == ".docx":
        raw = _from_docx(data)
    elif ocr:
        raw = _from_image(data)
    else:
        raw = _from_text(data)
    text = _tidy(raw)
    if len(text) < MIN_TEXT_CHARS:
        if ocr:
            raise ResumeError("No text could be read from this picture. Use a sharper, straight scan, or upload a PDF with selectable text.")
        if suffix == ".pdf":
            raise ResumeError("No text was found in this PDF. Upload a PDF with selectable text, a Word or a text file.")
        raise ResumeError("No text was found in this file.")
    text, truncated = _cut(text, limit)
    return Extracted(text, truncated, ocr)


def clean_text(text: str, limit: int, what: str = "The text") -> str:
    """Text the user typed or pasted: line endings unified, blank runs shortened, within the limit."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) > limit:
        raise ResumeError(f"{what} is {len(text):,} characters long; at most {limit:,} are used. Shorten it.")
    return text


def clean_title(title: Optional[str]) -> str:
    return " ".join((title or "").split())[:MAX_TITLE_CHARS]


# ------------------------------------------------------------------ for a model
def _guard(text: str) -> str:
    """The text cannot close its own block (or the other one) and so step outside it."""
    return re.sub(r"</\s*(resume|job)\s*>", r"< /\1>", text, flags=re.IGNORECASE)


def _job_body(title: Optional[str], text: Optional[str]) -> str:
    parts = [p for p in (clean_title(title), (text or "").strip()) if p]
    return "\n".join(parts)


def prompt_block(resume: Optional[str], job_title: Optional[str] = None, job_text: Optional[str] = None) -> str:
    """The part of a system prompt that carries the resume and the job; empty when there is neither."""
    resume = (resume or "").strip()
    job = _job_body(job_title, job_text) if (job_text or "").strip() else ""
    if not resume and not job:
        return ""
    parts: list[str] = []
    if resume:
        parts.append(INSTRUCTION if not job else f"{INSTRUCTION} {JOB_INSTRUCTION}")
        parts.append(f"<resume>\n{_guard(resume)}\n</resume>")
    else:
        parts.append(JOB_ONLY_INSTRUCTION)
    if job:
        parts.append(f"<job>\n{_guard(job)}\n</job>")
    return "\n".join(parts)


# ------------------------------------------------------------------ for a chat website
CHAT_QUESTION_HEADING = "=== QUESTION ==="


def chat_context(resume: Optional[str], job_title: Optional[str] = None, job_text: Optional[str] = None) -> Optional[dict]:
    """
    What ZHU adds to the first message of a new conversation on a chat website: the resume and the
    job, with the same instruction a model gets, written as the user. Either as a text file (with a
    one-line note in the message) or as a block of text before the question.

    `marker` is in the file name and in the first line of the text, so the page helper can tell
    whether this exact text is already in the conversation or in the draft.
    """
    resume = (resume or "").strip()
    job = _job_body(job_title, job_text) if (job_text or "").strip() else ""
    if not resume and not job:
        return None
    ref = hashlib.sha256(f"{resume}\n\x00\n{job}".encode("utf-8")).hexdigest()[:8]
    marker = f"zhu-{ref}"
    if resume:
        what = "my resume and the job I am applying for" if job else "my resume"
        rules = (
            "When a question in this chat is about me (my background, experience, projects, skills, education, "
            "achievements, strengths, motivation, or anything else about me as a person or a candidate), answer it "
            "from my resume, in the first person, the way I would say it myself. Choose what is relevant to the "
            "question. Use only facts my resume states; where it does not cover something, say what is missing "
            "instead of inventing it."
        )
        if job:
            rules += " Where it fits, connect my experience to what the job asks for, without claiming anything my resume does not state."
        rules += " For questions that are not about me, answer as usual and do not bring this up."
    else:
        what = "the job I am applying for"
        rules = "Where it is relevant to a question in this chat, shape your answer to what this role asks for. Do not invent facts about me."
    lines = [f"About me, for this whole chat ({marker})", "", f"Below is {what}. {rules} You do not need to reply to this part on its own."]
    if resume:
        lines += ["", "=== MY RESUME ===", resume]
    if job:
        lines += ["", "=== THE JOB ===", job]
    file_name = f"{'resume-and-job' if resume and job else 'resume' if resume else 'job'}-{marker}.txt"
    attached = "My resume and the job I am applying for are" if resume and job else "My resume is" if resume else "The job I am applying for is"
    return {
        "marker": marker,
        "file_name": file_name,
        "text": "\n".join(lines),
        "note": f"{attached} attached ({file_name}). Use it for this whole chat, as the file says.",
        "question_heading": CHAT_QUESTION_HEADING,
    }
