"""Question candidate detection.

Input:  one ``Utterance`` (text).
Output: ``CandidateSignal`` with a heuristic score, a form hint, and its reasons.

Questions are recognized without requiring an interrogative word: imperative
requests ("Explain dependency injection."), coding tasks, indirect requests
("I want you to tell me ..."), and behavioral prompts are all candidates.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .text import AUXILIARIES, CODING_OBJECTS, CODING_VERBS, IMPERATIVE_VERBS, LEADING_DISCOURSE, SUBJECT_STARTERS, WH_WORDS, words
from .types import QuestionKind

INDIRECT_RE = re.compile(
    r"^(?:so\s+)?(?:i\s+(?:want|need)\s+(?:you\s+)?to|i(?:'d| would)\s+like\s+(?:you\s+)?to|"
    r"i(?:'d| would)\s+(?:love|like)\s+to\s+(?:hear|know|understand)|i\s+want\s+to\s+(?:know|understand|hear)|"
    r"i\s+was\s+wondering|i(?:'m| am)\s+(?:curious|wondering)|let\s+me\s+know|help\s+me\s+understand|"
    r"i(?:'d| would)\s+be\s+interested|can\s+you\s+tell\s+me|could\s+you\s+tell\s+me|do\s+you\s+know|"
    r"please\s+(?:tell|explain|describe))\b",
    re.IGNORECASE,
)
BEHAVIORAL_RE = re.compile(
    r"\b(?:tell\s+me\s+about\s+(?:a|the)\s+time|tell\s+me\s+about\s+yourself|give\s+me\s+an\s+example\s+of\s+(?:a\s+)?(?:time|situation)|"
    r"describe\s+a\s+(?:time|situation)|walk\s+me\s+through\s+your\s+(?:resume|background|experience|career)|"
    r"have\s+you\s+(?:ever|worked|used|built|implemented|led|managed|designed|deployed)\b|how\s+did\s+you\s+(?:handle|deal|manage|resolve)|what\s+was\s+your\s+role|"
    r"your\s+(?:biggest|greatest)\s+(?:strength|weakness|achievement|challenge|failure|accomplishment)|"
    r"why\s+do\s+you\s+want|where\s+do\s+you\s+see\s+yourself|why\s+should\s+we\s+hire|"
    r"(?:a|any)\s+(?:conflict|disagreement)\s+with|time\s+(?:when|that)\s+you)\b",
    re.IGNORECASE,
)
SCENARIO_RE = re.compile(
    r"^(?:so\s+|now\s+|okay\s+|ok\s+)?(?:suppose|supposing|imagine|let's\s+say|lets\s+say|let\s+us\s+say|assume|assuming|"
    r"consider|given|say\s+you\s+have|if\s+you\s+have|you\s+have|you\s+are\s+given|you're\s+given|"
    r"in\s+a\s+scenario|think\s+of|picture|we\s+have|there\s+is|there\s+are|your\s+(?:application|system|service|team|company))\b",
    re.IGNORECASE,
)
NON_QUESTION_RE = re.compile(
    r"^(?:okay|ok|great|good|cool|nice|perfect|thank you|thanks|right|sure|yes|yeah|yep|no|nope|"
    r"sounds good|that's (?:good|great|right|correct|fine|it)|i see|got it|makes sense|"
    r"let's move on|moving on|alright|all right|hmm|correct|exactly|awesome|excellent|wonderful)"
    r"[\s,.!]*$",
    re.IGNORECASE,
)
ANSWER_LIKE_RE = re.compile(
    r"^(?:i\s+(?:think|believe|have|had|worked|used|was|am|did|would\s+say|guess)|my\s+name|"
    r"so\s+basically|basically|in\s+my\s+(?:experience|project|previous)|we\s+(?:used|had|were))\b",
    re.IGNORECASE,
)
POLITE_PREFIX = re.compile(r"^(?:please|kindly|maybe|now|just|quickly|briefly|so|then)\s+", re.IGNORECASE)


@dataclass
class CandidateSignal:
    score: float
    kind: QuestionKind
    reasons: list[str] = field(default_factory=list)
    is_scenario_context: bool = False
    interrogative_form: bool = False  # ends with "?" when formatted

    @property
    def is_candidate(self) -> bool:
        return self.score >= 0.5


def strip_discourse(text: str) -> str:
    return LEADING_DISCOURSE.sub("", text).strip()


def _first_verb_after_prefixes(ws: list[str]) -> tuple[str, int]:
    i = 0
    while i < len(ws) and ws[i] in {"please", "kindly", "now", "just", "quickly", "briefly", "so", "then", "also", "first", "next", "and", "lastly", "finally", "maybe"}:
        i += 1
    if i + 1 < len(ws) and ws[i] in {"can", "could", "would", "will"} and ws[i + 1] == "you":
        i += 2
        if i < len(ws) and ws[i] == "please":
            i += 1
    return (ws[i], i) if i < len(ws) else ("", i)


def detect_candidate(text: str) -> CandidateSignal:
    core = strip_discourse(text)
    ws = words(core)
    reasons: list[str] = []
    if not ws:
        return CandidateSignal(0.0, QuestionKind.DIRECT, ["empty"])
    if NON_QUESTION_RE.match(core):
        return CandidateSignal(0.05, QuestionKind.DIRECT, ["acknowledgement"])

    score = 0.0
    kind = QuestionKind.DIRECT
    interrogative = False
    ends_q = core.rstrip().endswith("?")
    if ends_q:
        score += 0.6
        interrogative = True
        reasons.append("question mark")

    first = ws[0]
    if first in WH_WORDS and not (len(ws) > 1 and ws[1] == "a" and not ends_q and first == "what"):
        score += 0.55
        interrogative = True
        reasons.append("wh-word")
    elif first in AUXILIARIES and len(ws) > 1 and (ws[1] in SUBJECT_STARTERS or ws[1] not in AUXILIARIES):
        score += 0.5
        interrogative = True
        reasons.append("auxiliary inversion")

    verb, vi = _first_verb_after_prefixes(ws)
    if verb in IMPERATIVE_VERBS:
        rest = set(ws[vi + 1 :])
        if verb in {"tell", "give", "show", "walk"} and not rest & {"me", "us", "about", "an", "a", "the", "your", "how", "what", "why"}:
            pass
        else:
            score += 0.55
            reasons.append(f"imperative '{verb}'")
            if not interrogative:
                kind = QuestionKind.IMPERATIVE
            if verb in CODING_VERBS and rest & CODING_OBJECTS:
                kind = QuestionKind.CODING_TASK
                reasons.append("coding task")

    if score < 0.5 and not ANSWER_LIKE_RE.match(core):
        # Code-switching or a vocative before the question ("bhai explain karo what is ...").
        if any(w in IMPERATIVE_VERBS and w not in {"tell", "give", "show", "walk", "state", "name", "list", "code", "model", "check"} for w in ws[1:3]):
            score += 0.5
            kind = QuestionKind.IMPERATIVE
            reasons.append("imperative after leading words")
        elif any(ws[i] in WH_WORDS and ws[i + 1] in AUXILIARIES for i in range(1, min(len(ws) - 2, 5))):
            score += 0.5
            interrogative = True
            reasons.append("question clause after leading words")

    if INDIRECT_RE.match(core):
        score += 0.55
        if kind not in (QuestionKind.CODING_TASK,):
            kind = QuestionKind.INDIRECT
        reasons.append("indirect request")
        if re.match(r"^(?:can|could)\s+you\s+tell|^do\s+you\s+know", core, re.IGNORECASE):
            interrogative = True

    if BEHAVIORAL_RE.search(core):
        score += 0.4
        kind = QuestionKind.BEHAVIORAL
        reasons.append("behavioral prompt")

    scenario = bool(SCENARIO_RE.match(core)) and not interrogative and kind not in (QuestionKind.IMPERATIVE, QuestionKind.CODING_TASK)
    if scenario:
        reasons.append("scenario context")
        if score < 0.5:
            return CandidateSignal(0.3, QuestionKind.SCENARIO, reasons, is_scenario_context=True)

    if ANSWER_LIKE_RE.match(core) and not ends_q and "indirect request" not in reasons:
        score -= 0.4
        reasons.append("answer-like statement")

    return CandidateSignal(max(0.0, min(1.0, score)), kind, reasons, False, interrogative)


_BACK_REF = re.compile(r"(?<![\w'])(?:it|them|they|that|this|those|these|each|both)(?![\w'])", re.IGNORECASE)
_CLAUSE = re.compile(r"[,;]|(?<![\w'])(?:and|or|but|then)(?![\w'])", re.IGNORECASE)


def refers_back(text: str) -> bool:
    """True if a question depends on the preceding sentence: it contains a back-reference
    ("why would you use it") with no antecedent of its own before the pronoun.

    Measured case: STT transcribes "What is a microservice, | why would you use it" as two
    sentences when the speaker pauses at the comma. Within one stretch of continuous speech,
    such a sentence belongs to the same multi-part question."""
    m = _BACK_REF.search(text)
    if not m:
        return False
    before = text[: m.start()]
    clause = _CLAUSE.search(before)
    # An antecedent inside the sentence ("What is Redis, and why use it") makes it self-contained.
    return not (clause and len(before[: clause.start()].split()) >= 2)


def is_continuation(text: str) -> bool:
    """True if an utterance continues the previous question rather than starting a new one."""
    core = text.strip()
    if re.match(r"^(?:and|also|or|plus|as well as|along with|but)\b", core, re.IGNORECASE):
        return True
    if re.match(
        r"^(?:(?:please\s+)?(?:explain|illustrate|show|give|provide)(?:\s+(?:me|us))?(?:\s+(?:it|this|that))?\s+"
        r"(?:with\s+)?(?:an?\s+|some\s+)?(?:example|examples|code|diagram|use\s+case)s?\b|"
        r"(?:for\s+example|with\s+(?:an?\s+)?examples?|why|and\s+why|in\s+detail|briefly)[\s?.!]*$)",
        core,
        re.IGNORECASE,
    ):
        return True
    return False
