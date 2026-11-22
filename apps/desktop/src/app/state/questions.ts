/**
 * Question store for the current session. Upserts are revision-guarded, so a stale
 * or replayed event can never overwrite newer state.
 */
import { create } from "zustand";
import type { Question } from "@/types/engine";

export interface QuestionsState {
  sessionId: string | null;
  byId: Record<string, Question>;
  version: number;
}

/** Pure: apply one question snapshot. Returns the same object when nothing changed. */
export function upsertQuestion(state: QuestionsState, q: Question): QuestionsState {
  if (state.sessionId && q.session_id !== state.sessionId) return state;
  const existing = state.byId[q.question_id];
  if (existing && existing.revision >= q.revision) return state;
  return { ...state, sessionId: state.sessionId ?? q.session_id, byId: { ...state.byId, [q.question_id]: q }, version: state.version + 1 };
}

export function sortedQuestions(state: Pick<QuestionsState, "byId">, includeDiscarded = false): Question[] {
  return Object.values(state.byId)
    .filter((q) => includeDiscarded || q.state !== "DISCARDED")
    .sort((a, b) => a.started_at_ms - b.started_at_ms);
}

export function latestQuestion(state: Pick<QuestionsState, "byId">): Question | null {
  let best: Question | null = null;
  for (const q of Object.values(state.byId)) {
    if (q.state === "DISCARDED") continue;
    if (!best || q.started_at_ms > best.started_at_ms) best = q;
  }
  return best;
}

interface QuestionsStore extends QuestionsState {
  reset: (sessionId: string | null) => void;
  load: (sessionId: string, list: Question[]) => void;
  upsertMany: (list: Question[]) => void;
}

export const useQuestions = create<QuestionsStore>((set) => ({
  sessionId: null,
  byId: {},
  version: 0,
  reset: (sessionId) => set({ sessionId, byId: {}, version: 0 }),
  load: (sessionId, list) =>
    set((st) => {
      let s: QuestionsState = st.sessionId === sessionId ? st : { sessionId, byId: {}, version: 0 };
      for (const q of list) s = upsertQuestion(s, q);
      return { ...s, version: s.version + 1 };
    }),
  upsertMany: (list) =>
    set((st) => {
      let s: QuestionsState = st;
      for (const q of list) s = upsertQuestion(s, q);
      return s;
    }),
}));
