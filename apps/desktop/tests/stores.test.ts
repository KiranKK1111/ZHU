import { describe, expect, it } from "vitest";
import { latestQuestion, sortedQuestions, upsertQuestion, type QuestionsState } from "@/app/state/questions";
import { applySegment, emptyTranscript, MAX_LIVE_SEGMENTS, type TranscriptState } from "@/app/state/transcript";
import type { Question, TranscriptSegmentEvent } from "@/types/engine";

function q(id: string, revision: number, patch: Partial<Question> = {}): Question {
  return {
    question_id: id,
    session_id: "s1",
    state: "COMPLETE",
    revision,
    raw_text: "raw",
    formatted_text: `text r${revision}`,
    resolved_text: null,
    kind: "DIRECT",
    category: "GENERAL",
    source_segment_ids: [],
    started_at_ms: 0,
    ended_at_ms: null,
    source: "system",
    speaker: "unknown",
    confidence: { transcription: null, classification: null, boundary: null, context_resolution: null, normalization: null, calibrated: false },
    subquestions: [],
    scenario: null,
    uncertain_spans: [],
    substitutions: [],
    math_latex: null,
    needs_review: false,
    review_reasons: [],
    parent_question_id: null,
    repeat_of: null,
    saved: false,
    edit_history: [],
    display_text: `text r${revision}`,
    ...patch,
  };
}

describe("question store upsert (revision-guarded)", () => {
  const empty: QuestionsState = { sessionId: "s1", byId: {}, version: 0 };

  it("inserts and replaces with newer revisions only", () => {
    let s = upsertQuestion(empty, q("a", 1));
    s = upsertQuestion(s, q("a", 3));
    expect(s.byId.a.revision).toBe(3);
    const stale = upsertQuestion(s, q("a", 2));
    expect(stale).toBe(s); // unchanged object: no re-render
    const same = upsertQuestion(s, q("a", 3));
    expect(same).toBe(s); // replayed duplicate
  });

  it("ignores questions from another session", () => {
    const s = upsertQuestion(empty, q("x", 1, { session_id: "other" }));
    expect(s.byId.x).toBeUndefined();
  });

  it("sorts by start time and finds the latest non-discarded question", () => {
    let s = upsertQuestion(empty, q("a", 1, { started_at_ms: 10 }));
    s = upsertQuestion(s, q("b", 1, { started_at_ms: 30, state: "DISCARDED" }));
    s = upsertQuestion(s, q("c", 1, { started_at_ms: 20 }));
    expect(sortedQuestions(s).map((x) => x.question_id)).toEqual(["a", "c"]);
    expect(sortedQuestions(s, true).map((x) => x.question_id)).toEqual(["a", "c", "b"]);
    expect(latestQuestion(s)?.question_id).toBe("c");
  });
});

function seg(id: string, revision: number, text: string, isFinal: boolean, start = 0): TranscriptSegmentEvent {
  return { segment_id: id, revision, text, start_ms: start, end_ms: start + 1000, is_final: isFinal, source: "system", speaker: "unknown", confidence: null, words: [], language: "en", source_label: "System audio" };
}

describe("transcript store", () => {
  const base: TranscriptState = { ...emptyTranscript, sessionId: "s1" };

  it("replaces provisional text with the final revision in place", () => {
    let s = applySegment(base, seg("g1", 1, "what is the", false));
    s = applySegment(s, seg("g1", 2, "what is the difference", false));
    s = applySegment(s, seg("g1", 1002, "What is the difference?", true));
    expect(s.order).toEqual(["g1"]);
    expect(s.byId.g1).toMatchObject({ text: "What is the difference?", is_final: true, revision: 1002 });
  });

  it("ignores stale revisions and never regresses a final to provisional", () => {
    let s = applySegment(base, seg("g1", 5, "final text", true));
    const stale = applySegment(s, seg("g1", 3, "older", false));
    expect(stale).toBe(s);
    s = applySegment(s, seg("g1", 9, "late partial", false));
    expect(s.byId.g1.text).toBe("final text");
  });

  it("removes a provisional segment whose final transcript is empty (noise)", () => {
    let s = applySegment(base, seg("g1", 1, "thank you", false));
    s = applySegment(s, seg("g1", 1001, "", true));
    expect(s.order).toEqual([]);
    expect(s.byId.g1).toBeUndefined();
  });

  it("keeps segments in time order even when they arrive out of order", () => {
    let s = applySegment(base, seg("b", 1, "second", true, 5000));
    s = applySegment(s, seg("a", 1, "first", true, 1000));
    s = applySegment(s, seg("c", 1, "third", true, 9000));
    expect(s.order).toEqual(["a", "b", "c"]);
  });

  it("is bounded", () => {
    let s = base;
    for (let i = 0; i < MAX_LIVE_SEGMENTS + 25; i++) s = applySegment(s, seg(`s${i}`, 1, "x", true, i * 10));
    expect(s.order.length).toBe(MAX_LIVE_SEGMENTS);
    expect(Object.keys(s.byId).length).toBe(MAX_LIVE_SEGMENTS);
    expect(s.order[0]).toBe("s25");
  });
});

describe("clearing the transcript", () => {
  it("empties the view of that session only, and lines said afterwards appear again", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { useTranscript } = await import("@/app/state/transcript");
    const { dispatchEnvelopes } = await import("@/services/dispatch");
    const { qk } = await import("@/app/providers/queryKeys");
    const qc = new QueryClient();
    const line = (seq: number, id: string, text: string) => ({ seq, event_type: "transcript.final", session_id: "s1", ts_ms: seq, data: seg(id, 1, text, true, seq * 1000) }) as never;
    const cleared = (seq: number, sid: string) => ({ seq, event_type: "transcript.cleared", session_id: sid, ts_ms: seq, data: { session_id: sid, removed: 2 } }) as never;

    useTranscript.getState().reset("s1");
    qc.setQueryData(qk.transcript("s1"), [{ id: 1 }]);
    dispatchEnvelopes([line(1, "a", "first"), line(2, "b", "second")], qc, "main");
    expect(useTranscript.getState().order).toEqual(["a", "b"]);

    dispatchEnvelopes([cleared(3, "other")], qc, "main"); // another session's transcript: not ours
    expect(useTranscript.getState().order).toEqual(["a", "b"]);

    // One batch: a line said before the clear, the clear, and a line said after it.
    dispatchEnvelopes([line(4, "c", "before the clear"), cleared(5, "s1"), line(6, "d", "after the clear")], qc, "main");
    expect(useTranscript.getState().order).toEqual(["d"]);
    expect(useTranscript.getState().sessionId).toBe("s1");
    expect(qc.getQueryData(qk.transcript("s1"))).toEqual([]); // a later reload cannot bring the old lines back
  });
});
