/**
 * Live transcript store. Segments are keyed by segment_id. A newer revision replaces
 * an older one (a partial is replaced by its final). The ring is bounded so very
 * long sessions do not grow memory without limit; the full transcript stays in the
 * engine database.
 */
import { create } from "zustand";
import type { AudioSource, TranscriptRow, TranscriptSegmentEvent, WordInfo } from "@/types/engine";

export const MAX_LIVE_SEGMENTS = 1500;

export interface TranscriptItem {
  segment_id: string;
  row_id: number | null;
  revision: number;
  text: string;
  corrected_text: string | null;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
  source: AudioSource;
  source_label: string;
  confidence: number | null;
  words: WordInfo[];
}

export interface TranscriptState {
  sessionId: string | null;
  order: string[];
  byId: Record<string, TranscriptItem>;
  version: number;
}

export const emptyTranscript: TranscriptState = { sessionId: null, order: [], byId: {}, version: 0 };

/** Pure reducer: apply one segment event. */
export function applySegment(state: TranscriptState, seg: TranscriptSegmentEvent): TranscriptState {
  const existing = state.byId[seg.segment_id];
  if (existing && existing.revision > seg.revision) return state;
  if (existing && existing.is_final && !seg.is_final) return state; // never regress a final to provisional
  if (seg.is_final && !seg.text.trim()) {
    // Empty final: the provisional text was noise. Remove it.
    if (!existing) return state;
    const { [seg.segment_id]: _removed, ...rest } = state.byId;
    return { ...state, byId: rest, order: state.order.filter((id) => id !== seg.segment_id), version: state.version + 1 };
  }
  const item: TranscriptItem = {
    segment_id: seg.segment_id,
    row_id: existing?.row_id ?? null,
    revision: seg.revision,
    text: seg.text,
    corrected_text: existing?.corrected_text ?? null,
    start_ms: seg.start_ms,
    end_ms: seg.end_ms,
    is_final: seg.is_final,
    source: seg.source,
    source_label: seg.source_label,
    confidence: seg.confidence,
    words: seg.words ?? [],
  };
  const byId = { ...state.byId, [seg.segment_id]: item };
  let order = state.order;
  if (!existing) {
    order = insertSorted(state.order, seg.segment_id, seg.start_ms, byId);
    if (order.length > MAX_LIVE_SEGMENTS) {
      const drop = order.slice(0, order.length - MAX_LIVE_SEGMENTS);
      order = order.slice(order.length - MAX_LIVE_SEGMENTS);
      for (const id of drop) delete byId[id];
    }
  }
  return { ...state, byId, order, version: state.version + 1 };
}

function insertSorted(order: string[], id: string, start: number, byId: Record<string, TranscriptItem>): string[] {
  // Segments almost always arrive in time order; walk back from the end.
  let i = order.length;
  while (i > 0 && byId[order[i - 1]] && byId[order[i - 1]].start_ms > start) i--;
  const next = order.slice();
  next.splice(i, 0, id);
  return next;
}

export function fromRows(sessionId: string, rows: TranscriptRow[], labels: Record<string, string>): TranscriptState {
  const sorted = rows.slice().sort((a, b) => a.start_ms - b.start_ms).slice(-MAX_LIVE_SEGMENTS);
  const byId: Record<string, TranscriptItem> = {};
  for (const r of sorted) {
    byId[r.segment_id] = {
      segment_id: r.segment_id,
      row_id: r.id,
      revision: r.revision,
      text: r.text,
      corrected_text: r.corrected_text,
      start_ms: r.start_ms,
      end_ms: r.end_ms,
      is_final: true,
      source: r.source,
      source_label: labels[r.source] ?? r.source,
      confidence: r.confidence,
      words: r.words ?? [],
    };
  }
  return { sessionId, order: sorted.map((r) => r.segment_id), byId, version: 1 };
}

interface TranscriptStore extends TranscriptState {
  reset: (sessionId: string | null) => void;
  load: (sessionId: string, rows: TranscriptRow[], labels: Record<string, string>) => void;
  apply: (sessionId: string, segs: TranscriptSegmentEvent[]) => void;
  applyCorrection: (row: TranscriptRow) => void;
  /** The session's transcript was deleted: nothing of it stays on screen. */
  clear: (sessionId: string) => void;
}

export const useTranscript = create<TranscriptStore>((set) => ({
  ...emptyTranscript,
  reset: (sessionId) => set({ ...emptyTranscript, sessionId }),
  clear: (sessionId) => set((st) => (st.sessionId === sessionId ? { ...emptyTranscript, sessionId, version: st.version + 1 } : st)),
  load: (sessionId, rows, labels) =>
    set((st) => {
      const loaded = fromRows(sessionId, rows, labels);
      if (st.sessionId !== sessionId) return loaded;
      // Merge: keep live provisional segments the database does not have yet.
      let merged: TranscriptState = loaded;
      for (const id of st.order) {
        const it = st.byId[id];
        if (!loaded.byId[id] && it) {
          merged = applySegment(merged, { ...it, speaker: "unknown", language: null });
        } else if (loaded.byId[id] && it) {
          merged.byId[id].source_label = it.source_label;
        }
      }
      return merged;
    }),
  apply: (sessionId, segs) =>
    set((st) => {
      let s: TranscriptState = st.sessionId === sessionId ? st : { ...emptyTranscript, sessionId };
      for (const seg of segs) s = applySegment(s, seg);
      return s;
    }),
  applyCorrection: (row) =>
    set((st) => {
      if (st.sessionId !== row.session_id) return st;
      const it = st.byId[row.segment_id];
      if (!it) return st;
      return { ...st, byId: { ...st.byId, [row.segment_id]: { ...it, corrected_text: row.corrected_text, row_id: row.id } }, version: st.version + 1 };
    }),
}));
