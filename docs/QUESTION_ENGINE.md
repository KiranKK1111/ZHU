# Question Detection Engine

Package: `engine/zhu_engine/questions/`. It is pure Python with no audio, GPU, network, or database dependency, and it runs deterministically on the CPU.

## 1. Pipeline and contracts

| Stage | Module | Input → Output |
|---|---|---|
| Segment idempotency | `dedupe.SegmentTracker` | `TranscriptSegment` → accept / ignore (same or older `revision`) |
| Transcript normalization | `normalize.py` | raw segment text → `NormalizedText` (fillers, stutters, self-corrections; every change recorded as a `Substitution`) |
| Utterance boundaries | `boundary.py` | normalized text → `Utterance[]` with offsets (protects `Node.js`, `3.14`, `e.g.`, and similar; also splits at discourse markers such as "okay, next question") |
| Candidate detection | `candidate.py` | `Utterance` → `CandidateSignal` (score, kind hint, reasons). Recognizes wh-words, auxiliary inversion, imperatives, coding tasks, indirect and behavioral requests, scenario context, and acknowledgements / answer-like statements |
| Grouping | `engine._analyze` | utterances → groups: scenario context + question + continuations ("…and give me an example") |
| Vocabulary | `vocabulary.py` + `data/vocabulary.json` | text → canonical technical terms, **context-gated** |
| Programming syntax | `syntax.py` | `==`/`===`, `&&`, Big-O, generics (Java/C#/TS context only), `arr[i]`, SQL fragments, compound adjectives |
| Math | `mathexpr.py` | spoken arithmetic → symbols + LaTeX; ambiguous grouping is flagged |
| Multi-part | `formatter.split_multipart` | question → sub-questions (only at real clause boundaries; embedded "how X works" is not split) |
| Formatting | `formatter.format_question` | casing, punctuation, embedded-question word order ("explain what is X" → "explain what X is") |
| Classification | `classify.py` | text + kind + entities → `QuestionCategory` + heuristic confidence |
| Context resolution | `context.py` | "it", "them", "what about X" → `resolved_text` (only when the referent is unambiguous) |
| Completion | `completion.py` | text + silence + finalization + VAD + speaker change → in progress / awaiting / complete |
| State machine | `state.py` | explicit allowed transitions; invalid ones raise |
| Orchestration | `engine.QuestionEngine` | `ingest_segment`, `on_speech_start/end`, `tick`, plus manual edit, discard, merge, split, save, and create |

**Raw text is never overwritten.** Each `Question` keeps `raw_text` (verbatim STT), `formatted_text`, and `resolved_text` (or `None`), plus `substitutions[]`, `uncertain_spans[]`, `review_reasons[]`, and `edit_history[]`.

## 2. Lifecycle state machine

```text
IDLE → SPEECH_DETECTED → CANDIDATE → QUESTION_IN_PROGRESS ⇄ AWAITING_COMPLETION → COMPLETE
                                                                        │              │
                                                                        └→ REVISED ←───┘ (late STT revision or "…and also" continuation)
any open/complete state → MANUALLY_EDITED (locked against STT updates) · any → DISCARDED
```

`IDLE` and `SPEECH_DETECTED` are per-source window states (`QuestionEngine.window_state`). A `Question` object exists from `CANDIDATE` on. Partial transcripts update **one** evolving question with a stable `question_id` and a monotonically increasing `revision`.

## 3. Completion strategy

Silence alone never completes a question.

| Condition | Required pause (default) |
|---|---|
| VAD says speech is active | never complete |
| Final transcript not yet received | wait, bounded by `max_completion_timeout_ms` (9000) → completed and flagged *may be incomplete* |
| Another audio source starts speaking | complete if linguistically complete (≥ 350 ms pause) |
| Ends with `?` and the transcript is final | `short_pause_ms` (800) |
| Linguistically complete | `base_pause_ms` (1400) |
| Dangling ending (`and`, `the`, `between`, `explain`, `…`, comma) | `extended_pause_ms` (3500) → completed and flagged |
| A new question starts in the same window | the previous one completes immediately |
| "and …" / "explain with an example" within 4 s of completion | the previous question is reopened (`REVISED`) and extended |

| A new question in the same stretch of speech that **refers back** ("…microservice? Why would you use it, and…") | joined into one multi-part question. STT can turn a spoken comma into "?" when VAD splits at the pause |

Every pause above also gets `onset_guard_ms` (300 ms) added. VAD confirms resumed speech only after `min_speech_ms`, and the real-time benchmark showed that a comma pause could otherwise complete the first clause before the resumption was confirmed. Completions are evaluated on the **audio clock**, the same clock segments are stamped with, never on wall time.

All thresholds are in `QuestionEngineConfig`. The app uses the defaults; they can be changed through the settings API (`questions.*`).

## 4. Duplicates versus intentional repeats

* Same `(segment_id, revision)` or an older revision → ignored. This makes replays after a WebSocket reconnect or worker restart idempotent.
* A new question that is similar (token similarity ≥ 0.88) to a recent one **and overlaps it in time** → treated as the same question. This covers overlapping windows and re-transcription after a restart under new segment IDs.
* A similar question that does **not** overlap in time → kept as a new question with `repeat_of` and a `REPEAT_OF` relationship. Legitimate repeats are never deleted.

## 5. Context resolution rules

* Uses the most recent completed question within `follow_up_window_ms` (3 min).
* Singular pronoun + previous question with one clear subject → substitution. The previous language qualifier is carried over ("in Java") when the new question names no language.
* Plural pronoun + previous question with 2–3 subjects (language qualifiers excluded) → "X and Y".
* "What about X?" → the previous question with its subject replaced.
* An antecedent inside the same question ("What is a microservice, and why use it?") → no external resolution.
* Mixed or ambiguous references, or no previous question → **no rewrite**, `needs_review` with a reason.
* Follow-ups get a `parent_question_id` and a `FOLLOW_UP` relationship, and inherit the parent's topic when their own is `GENERAL`.

## 6. Vocabulary

`data/vocabulary.json` contains about 150 entries across the Java, Spring, JS/TS/React/Node, Python, C#/.NET, C++, SQL and databases, cloud, DevOps, microservices, and DS/A domains. Entries without `context` are distinctive ("spring boot", "c sharp"). Entries with `context` are replaced only if a context word occurs in the same utterance, or if one of their `context_domains` is active in the conversation:

* "how would you **react** if…" → unchanged; "how does **react** handle state in a component" → React
* "how does a **hash map** work" → unchanged; "…hash map work in **java**" → HashMap

Your own terms (`PUT /api/vocabulary`) override built-ins with the same canonical form. `disabled: true` removes a built-in.

## 7. Confidence

`Confidence` holds separate scores for **transcription** (mean word probability), **classification**, **boundary**, **context_resolution**, and **normalization**, with `calibrated: false`. These are heuristic scores, not probabilities. `evaluation/evaluate.py` prints a reliability table (accuracy per score bucket) against the labeled set. Words with STT probability < 0.45 become `uncertain_spans`. A transcription score < 0.6 sets `needs_review`.

## 8. Measured quality

See [BENCHMARKS.md](BENCHMARKS.md#question-engine) for the development and held-out results, and for detection measured on real STT output.

## 9. Known limitations

* The rules are designed for English. Code-switched speech keeps its foreign words verbatim; the engine never translates or removes them.
* Speaker attribution comes from the **audio source** only (microphone or system). There is no diarization, and `speaker` stays `"unknown"`.
* Article insertion ("abstract class" → "an abstract class") is deliberately not done, to avoid inventing words.
* Scenario questions without explicit system-design vocabulary can be classified `GENERAL` (one held-out miss, left unfixed on purpose).
