/** The ask box and the answers that are streaming in. */
import { create } from "zustand";
import type { ProviderErrorInfo } from "@/types/engine";

export interface ResponseState {
  requestId: string;
  interactionId: string;
  providerId: string;
  model: string | null;
  prompt: string;
  screenshotIds: string[];
  text: string;
  status: "streaming" | "completed" | "failed" | "cancelled";
  error: ProviderErrorInfo | null;
  startedAt: number;
}

interface ComposerStore {
  draft: string;
  attachments: string[]; // screenshot ids, in order
  responses: Record<string, ResponseState>;
  responseOrder: string[];
  focusNonce: number;
  setDraft: (text: string) => void;
  attach: (ids: string[]) => void;
  detach: (id: string) => void;
  clearAttachments: () => void;
  started: (r: Omit<ResponseState, "text" | "status" | "error" | "startedAt">) => void;
  delta: (requestId: string, text: string) => void;
  completed: (requestId: string, model: string | null) => void;
  failed: (requestId: string, error: ProviderErrorInfo) => void;
  dismiss: (requestId: string) => void;
}

const MAX_RESPONSES = 40;

export const useComposer = create<ComposerStore>((set) => ({
  draft: "",
  attachments: [],
  responses: {},
  responseOrder: [],
  focusNonce: 0,
  setDraft: (draft) => set({ draft }),
  attach: (ids) => set((st) => ({ attachments: [...st.attachments, ...ids.filter((i) => !st.attachments.includes(i))] })),
  detach: (id) => set((st) => ({ attachments: st.attachments.filter((x) => x !== id) })),
  clearAttachments: () => set({ attachments: [] }),
  started: (r) =>
    set((st) => {
      if (st.responses[r.requestId]) return st;
      const order = [...st.responseOrder, r.requestId].slice(-MAX_RESPONSES);
      const responses: Record<string, ResponseState> = {};
      for (const id of order) responses[id] = st.responses[id] ?? { ...r, text: "", status: "streaming", error: null, startedAt: Date.now() };
      return { responses, responseOrder: order };
    }),
  delta: (requestId, text) =>
    set((st) => {
      const r = st.responses[requestId];
      if (!r) return st;
      return { responses: { ...st.responses, [requestId]: { ...r, text: r.text + text } } };
    }),
  completed: (requestId, model) =>
    set((st) => {
      const r = st.responses[requestId];
      if (!r) return st;
      return { responses: { ...st.responses, [requestId]: { ...r, status: "completed", model: model ?? r.model } } };
    }),
  failed: (requestId, error) =>
    set((st) => {
      const r = st.responses[requestId];
      if (!r) return st;
      return { responses: { ...st.responses, [requestId]: { ...r, status: error.kind === "cancelled" ? "cancelled" : "failed", error } } };
    }),
  dismiss: (requestId) =>
    set((st) => {
      const { [requestId]: _gone, ...rest } = st.responses;
      return { responses: rest, responseOrder: st.responseOrder.filter((id) => id !== requestId) };
    }),
}));
