"""The 20 evaluation scenarios required by Master Prompt 01, section 18, plus the spec's worked examples."""

from __future__ import annotations

from zhu_engine.questions import AudioSource, QuestionCategory as C, QuestionKind as K, QuestionState as S, WordInfo
from zhu_engine.questions.types import QuestionEventType as ET

from .helpers import make_feeder


def only(f):
    qs = f.questions
    assert len(qs) == 1, [q.formatted_text for q in qs]
    return qs[0]


# 1
def test_short_direct_question():
    f = make_feeder()
    f.say("What is polymorphism?")
    q = only(f)
    assert q.state is S.COMPLETE and q.kind is K.DIRECT
    assert q.formatted_text == "What is polymorphism?"
    assert q.category is C.JAVA


# 2
def test_long_technical_question():
    f = make_feeder()
    text = ("can you explain how garbage collection works in the jvm including the difference between the young generation "
            "and the old generation and how the g1 collector decides when to run a full collection")
    f.say(text, duration_ms=9000)
    q = only(f)
    assert q.formatted_text.startswith("Can you explain how garbage collection works in the JVM")
    assert q.formatted_text.endswith("?")
    assert q.category is C.JAVA


# 3
def test_multi_part_question():
    f = make_feeder()
    f.say("What is a microservice, why would you use it, and how would you handle distributed transactions?")
    q = only(f)
    assert q.kind is K.MULTI_PART
    assert q.subquestions == ["What is a microservice?", "Why would you use it?", "How would you handle distributed transactions?"]
    assert q.category is C.MICROSERVICES


def test_multi_part_keeps_qualifiers():
    f = make_feeder()
    f.say("Explain the difference between abstract class and interface, tell me when to use each, and provide a real-time example.")
    q = only(f)
    assert q.kind is K.MULTI_PART
    assert q.subquestions == [
        "What is the difference between abstract class and interface?",
        "When should each be used?",
        "Provide a real-time example.",
    ]
    assert "real-time example" in q.formatted_text  # combined question preserved


# 4
def test_follow_up_question_resolution():
    f = make_feeder()
    f.say("What is HashMap in Java?")
    f.say("How is it different from ConcurrentHashMap?")
    first, second = f.questions
    assert second.formatted_text == "How is it different from ConcurrentHashMap?"  # original wording kept
    assert second.resolved_text == "How is HashMap different from ConcurrentHashMap in Java?"
    assert second.parent_question_id == first.question_id
    assert any(r.type.value == "FOLLOW_UP" for r in f.engine.relationships)


def test_follow_up_spring_boot():
    f = make_feeder()
    f.say("What is dependency injection?")
    f.say("How does Spring Boot implement it?")
    assert f.questions[1].resolved_text == "How does Spring Boot implement dependency injection?"


# 5
def test_interrupted_question_by_other_source():
    f = make_feeder()
    f.say("How would you scale a relational database", pause_ms=200)
    f.engine.on_speech_start(AudioSource.MICROPHONE, f.t)
    f.say("Sorry, could you repeat?", source=AudioSource.MICROPHONE, pause_ms=600)
    q = f.questions[0]
    assert q.state is S.COMPLETE  # other source speaking completes the interviewer's question
    assert q.formatted_text == "How would you scale a relational database?"
    assert q.source is AudioSource.SYSTEM


# 6
def test_self_correction():
    f = make_feeder()
    f.say("what is the difference between hash map, sorry, hash set and tree set in java")
    q = only(f)
    assert q.formatted_text == "What is the difference between HashSet and TreeSet in Java?"
    assert "hash map" in q.raw_text  # raw transcript untouched
    assert any(s.rule == "self_correction" for s in q.substitutions)


# 7
def test_java_code_terminology():
    f = make_feeder()
    f.say("why is string builder faster than string concatenation in java and when would you use completable future")
    q = only(f)
    assert "StringBuilder" in q.formatted_text and "CompletableFuture" in q.formatted_text
    assert q.category is C.JAVA


# 8
def test_sql_question():
    f = make_feeder()
    f.say("how would you write select star from employees where salary greater than 5000 in sql")
    q = only(f)
    assert "`SELECT * FROM employees WHERE salary > 5000`" in q.formatted_text
    assert q.category is C.SQL


# 9
def test_math_notation():
    f = make_feeder()
    f.say("what is one divided by seven multiplied by hundred")
    q = only(f)
    assert q.formatted_text == "What is 1 / 7 × 100?"
    assert q.kind is K.MATH and q.category is C.MATH
    assert q.math_latex == r"1 \div 7 \times 100"
    assert not q.needs_review  # same-precedence chain is unambiguous


def test_math_mixed_precedence_is_flagged():
    f = make_feeder()
    f.say("what is two plus three times four")
    q = only(f)
    assert q.formatted_text == "What is 2 + 3 × 4?"
    assert q.needs_review and any("ambiguous" in r for r in q.review_reasons)


def test_math_explicit_grouping():
    f = make_feeder()
    f.say("what is two plus three, all times four")
    assert only(f).formatted_text == "What is (2 + 3) × 4?"


# 10
def test_background_noise_low_confidence_preserved():
    f = make_feeder()
    words = (WordInfo("What", 0, 200, 0.9), WordInfo("is", 200, 300, 0.9), WordInfo("kubernetes", 300, 900, 0.31))
    f.say("What is kubernetes?", confidence=0.52, words=words)
    q = only(f)
    assert q.formatted_text == "What is Kubernetes?"
    assert q.needs_review and any("low transcription confidence" in r for r in q.review_reasons)
    assert q.uncertain_spans and q.raw_text[q.uncertain_spans[0].start : q.uncertain_spans[0].end] == "kubernetes"


# 11
def test_accented_english_misrecognitions():
    f = make_feeder()
    f.say("what is the use of post gress in a database and how do you create index")
    q = only(f)
    assert "PostgreSQL" in q.formatted_text


# 12
def test_code_switching_keeps_unknown_words():
    f = make_feeder()
    f.say("bhai explain karo what is dependency injection in spring boot")
    q = only(f)
    assert "dependency injection" in q.formatted_text and "Spring Boot" in q.formatted_text
    assert "bhai" in q.formatted_text.lower()  # nothing silently removed or invented


# 13
def test_question_repeated_intentionally():
    f = make_feeder()
    f.say("What is polymorphism?")
    f.say("Okay let me ask again.", pause_ms=2000)
    f.say("What is polymorphism?")
    qs = f.questions
    assert len(qs) == 2
    assert qs[1].repeat_of == qs[0].question_id


# 14
def test_duplicate_stt_segment_retransmission():
    f = make_feeder()
    f.say("What is polymorphism?", segment_id="segX", pause_ms=0)
    f.t -= 2000  # replay of the identical segment (reconnect / worker restart)
    f.say("What is polymorphism?", segment_id="segX")
    assert len(f.questions) == 1


def test_duplicate_overlapping_window_new_segment_id():
    f = make_feeder()
    f.say("What is polymorphism?")
    f.t -= 5000  # same audio re-transcribed after a worker restart, new segment id
    f.say("What is polymorphism?", segment_id="restart-1")
    assert len(f.questions) == 1


# 15
def test_question_spread_across_pauses():
    f = make_feeder()
    f.say("Can you explain...", duration_ms=1200, pause_ms=2500)
    f.say("how dependency injection works...", duration_ms=1500, pause_ms=2500)
    f.say("and give me a practical example?", duration_ms=1500)
    q = only(f)
    assert q.formatted_text == "Can you explain how dependency injection works and give me a practical example?"
    assert len(q.source_segment_ids) == 3


def test_two_second_pause_does_not_finalize_dangling_question():
    f = make_feeder()
    f.say("What is the difference between", pause_ms=2000)
    assert f.questions[0].state in (S.QUESTION_IN_PROGRESS, S.AWAITING_COMPLETION, S.CANDIDATE)


# 16
def test_scenario_based_question_preserves_scenario():
    f = make_feeder()
    f.say("Suppose your application receives one million requests per second. How would you design the architecture?")
    q = only(f)
    assert q.kind is K.SCENARIO
    assert q.formatted_text == "Suppose your application receives one million requests per second. How would you design the architecture?"
    assert q.scenario == "Suppose your application receives one million requests per second."
    assert q.category is C.SYSTEM_DESIGN


# 17
def test_behavioral_question():
    f = make_feeder()
    f.say("Tell me about a time you handled a production incident.")
    q = only(f)
    assert q.kind is K.BEHAVIORAL and q.category is C.BEHAVIORAL
    assert q.formatted_text == "Tell me about a time you handled a production incident."


# 18
def test_statement_is_not_a_question():
    f = make_feeder()
    f.say("Okay, that's great.")
    f.say("I worked on a payments platform for three years.")
    assert f.questions == []


# 19
def test_ambiguous_term_is_not_substituted_without_context():
    f = make_feeder()
    f.say("How would you react if a teammate disagreed with you?")
    q = only(f)
    assert "React" not in q.formatted_text
    f2 = make_feeder()
    f2.say("How does react handle state in a component?")
    assert "React" in only(f2).formatted_text


# 20
def test_unknown_context_is_flagged_not_rewritten():
    f = make_feeder()
    f.say("How is it different from the other one?")
    q = only(f)
    assert q.resolved_text is None
    assert q.needs_review and any("unresolved reference" in r for r in q.review_reasons)


# ------------------------------------------------------- spec worked examples

def test_spec_example_dependency_injection_formatting():
    f = make_feeder()
    f.say("can you explain what is dependency injection and how spring boot manages beans")
    q = only(f)
    assert q.formatted_text == "Can you explain what dependency injection is and how Spring Boot manages beans?"
    assert q.raw_text == "can you explain what is dependency injection and how spring boot manages beans"
    assert q.category is C.SPRING_BOOT


def test_partials_update_one_question():
    f = make_feeder()
    texts = ["what is the difference", "what is the difference between", "what is the difference between abstract class",
             "What is the difference between an abstract class and an interface in Java?"]
    evs = []
    for rev, text in enumerate(texts, 1):
        evs += f.say(text, segment_id="segP", revision=rev, final=rev == 4, pause_ms=0)
        f.t -= 2000
    f.t += 2000
    evs += f.pause(2000)
    assert len(f.engine.questions) == 1
    assert [e.event_type for e in evs].count(ET.CREATED) == 1
    assert evs[-1].event_type is ET.COMPLETED
    revisions = [e.question.revision for e in evs]
    assert revisions == sorted(revisions)  # monotonic revisions


def test_imperative_and_coding_recognized_without_wh_words():
    f = make_feeder()
    f.say("Explain dependency injection.")
    f.say("Write a program to reverse a linked list.")
    f.say("Find two numbers whose sum equals the target.")
    f.say("Implement an LRU cache.")
    kinds = [q.kind for q in f.questions]
    assert kinds == [K.IMPERATIVE, K.CODING_TASK, K.CODING_TASK, K.CODING_TASK]


def test_indirect_question():
    f = make_feeder()
    f.say("I want you to tell me how your application handles authentication.")
    q = only(f)
    assert q.kind is K.INDIRECT


def test_programming_operator_symbols():
    f = make_feeder()
    f.say("what is the difference between double equals and triple equals in javascript")
    assert only(f).formatted_text == "What is the difference between == and === in JavaScript?"


def test_second_largest_hyphenation():
    f = make_feeder()
    f.say("write a function that accepts an integer array and returns the second largest element")
    assert only(f).formatted_text == "Write a function that accepts an integer array and returns the second-largest element."


def test_two_questions_in_one_segment():
    f = make_feeder()
    f.say("What is polymorphism? And what is encapsulation?")
    # "And what is …" continues the first utterance only when it is a continuation cue + not a new question.
    texts = [q.formatted_text for q in f.questions]
    assert texts in (["What is polymorphism? And what is encapsulation?"], ["What is polymorphism?", "What is encapsulation?"])


# ------------------------------------------------- regressions from the real-time benchmark

def test_comma_pause_split_by_stt_stays_one_question():
    """STT transcribes 'What is a microservice, | why would you use it, ...' as two sentences when the
    speaker pauses at the comma. The back-referring second sentence must join the first."""
    f = make_feeder()
    f.say("What is a microservice?", duration_ms=1500, pause_ms=600)
    f.say("Why would you use it, and how would you handle distributed transactions?", duration_ms=3400)
    q = only(f)
    assert q.kind is K.MULTI_PART
    assert q.subquestions == ["What is a microservice?", "Why would you use it?", "How would you handle distributed transactions?"]


def test_follow_up_after_long_pause_is_separate_question():
    f = make_feeder()
    f.say("What is a microservice?", pause_ms=3000)
    f.say("Why would you use it?")
    first, second = f.questions
    assert second.parent_question_id == first.question_id
    assert second.resolved_text == "Why would you use a microservice?"


def test_spoken_pauses_are_not_subquestions():
    f = make_feeder()
    f.say("Can you explain...", duration_ms=1200, pause_ms=2500)
    f.say("how dependency injection works...", duration_ms=1500, pause_ms=2500)
    f.say("and give me a practical example?", duration_ms=1500)
    assert only(f).kind is K.DIRECT
