"""Question lifecycle state machine (Master Prompt 01, section 4).

The allowed transitions are explicit. Any other transition raises
``InvalidTransition``, so the engine can never move a question into an
inconsistent state without that being noticed.
"""

from __future__ import annotations

from .types import QuestionState as S

ALLOWED_TRANSITIONS: dict[S, frozenset[S]] = {
    S.IDLE: frozenset({S.SPEECH_DETECTED}),
    S.SPEECH_DETECTED: frozenset({S.CANDIDATE, S.IDLE, S.DISCARDED}),
    S.CANDIDATE: frozenset({S.QUESTION_IN_PROGRESS, S.DISCARDED, S.MANUALLY_EDITED}),
    S.QUESTION_IN_PROGRESS: frozenset(
        {S.AWAITING_COMPLETION, S.COMPLETE, S.DISCARDED, S.MANUALLY_EDITED}
    ),
    S.AWAITING_COMPLETION: frozenset(
        {S.QUESTION_IN_PROGRESS, S.COMPLETE, S.REVISED, S.DISCARDED, S.MANUALLY_EDITED}
    ),
    # A completed question can still be revised by a late STT revision of one of
    # its segments, or by the speaker correcting themselves.
    S.COMPLETE: frozenset({S.REVISED, S.MANUALLY_EDITED, S.DISCARDED}),
    S.REVISED: frozenset({S.COMPLETE, S.REVISED, S.MANUALLY_EDITED, S.DISCARDED}),
    S.MANUALLY_EDITED: frozenset({S.MANUALLY_EDITED, S.DISCARDED}),
    S.DISCARDED: frozenset(),
}

# States in which a question is still being built from incoming speech.
OPEN_STATES = frozenset({S.CANDIDATE, S.QUESTION_IN_PROGRESS, S.AWAITING_COMPLETION})
# States in which automatic STT updates must no longer overwrite the text.
LOCKED_STATES = frozenset({S.MANUALLY_EDITED, S.DISCARDED})


class InvalidTransition(ValueError):
    def __init__(self, current: S, target: S) -> None:
        super().__init__(f"invalid question state transition {current.value} -> {target.value}")
        self.current = current
        self.target = target


def can_transition(current: S, target: S) -> bool:
    return target in ALLOWED_TRANSITIONS[current]


def transition(current: S, target: S) -> S:
    if not can_transition(current, target):
        raise InvalidTransition(current, target)
    return target
