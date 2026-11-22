from __future__ import annotations

import itertools
from dataclasses import dataclass, field

from zhu_engine.questions import AudioSource, QuestionEngine, QuestionEngineConfig, TechnicalVocabulary, TranscriptSegment, WordInfo

VOCAB = TechnicalVocabulary.load()


@dataclass
class Feeder:
    """Feeds timestamped segments into a QuestionEngine on a simulated audio clock."""

    engine: QuestionEngine
    t: int = 0
    events: list = field(default_factory=list)
    _ids: itertools.count = field(default_factory=itertools.count)

    def say(self, text: str, duration_ms: int = 2000, source: AudioSource = AudioSource.SYSTEM, pause_ms: int = 3000,
            confidence: float | None = 0.9, words: tuple[WordInfo, ...] = (), segment_id: str | None = None, revision: int = 1,
            final: bool = True) -> list:
        sid = segment_id or f"{getattr(self, 'prefix', '')}seg{next(self._ids)}"
        seg = TranscriptSegment(sid, revision, text, self.t, self.t + duration_ms, final, source, confidence=confidence, words=words)
        evs = self.engine.ingest_segment(seg)
        self.t += duration_ms
        evs += self.pause(pause_ms)
        self.events += evs
        return evs

    def pause(self, ms: int) -> list:
        evs = []
        step = 100
        for _ in range(ms // step):
            self.t += step
            evs += self.engine.tick(self.t)
        self.events += evs
        return evs

    @property
    def questions(self):
        return [q for q in self.engine.questions.values() if q.state.value != "DISCARDED"]


def make_feeder(prefix: str = "", **cfg) -> Feeder:
    counter = itertools.count()
    engine = QuestionEngine("session-test", VOCAB, QuestionEngineConfig(**cfg), id_factory=lambda: f"{prefix}q{next(counter)}")
    f = Feeder(engine)
    f.prefix = prefix
    return f
