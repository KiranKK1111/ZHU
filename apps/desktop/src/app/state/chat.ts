/**
 * The built-in chat tab: the messages of the conversations that are open, the answers that are
 * streaming in, and the text waiting in each tab's message box. Conversations themselves live in
 * the engine's database; this store holds what is on screen.
 */
import { create } from "zustand";
import type { ChatMessage, ProviderErrorInfo } from "@/types/engine";

/** How an answer ended, as the engine reports it. */
export interface ChatEnding {
  status: "completed" | "failed" | "cancelled";
  model?: string | null;
  usage?: Record<string, unknown> | null;
  error?: ProviderErrorInfo | null;
}

/** Events for an answer that arrived before the request that started it returned. */
interface Early {
  text: string;
  ending: ChatEnding | null;
}

interface ChatStore {
  /** Messages of the loaded conversations, oldest first. */
  messages: Record<string, ChatMessage[]>;
  /** Conversation id -> the request writing an answer there. */
  streaming: Record<string, string>;
  /** Conversations with a send in flight (between pressing Send and the engine's reply). */
  sending: Record<string, true>;
  /** Conversations loaded while an answer was already streaming: their text is incomplete until it ends. */
  joinedLate: Record<string, true>;
  early: Record<string, Early>;
  /** Tab id -> text in its message box. */
  drafts: Record<string, string>;
  /** Tab id -> screenshots waiting in its message box, in order. */
  attachments: Record<string, string[]>;
  /** Tabs whose message box received a question while they were not on screen. */
  unread: Record<string, true>;

  load: (conversationId: string, messages: ChatMessage[], streamingRequestId: string | null) => void;
  beginSend: (conversationId: string) => void;
  endSend: (conversationId: string) => void;
  /** The engine accepted a message: show the question and the (empty) answer that will stream in. */
  appendTurn: (conversationId: string, user: ChatMessage, assistant: ChatMessage, requestId: string) => void;
  delta: (conversationId: string, messageId: string, text: string) => void;
  finish: (conversationId: string, messageId: string, ending: ChatEnding) => void;
  forget: (conversationId: string) => void;
  setDraft: (tabId: string, text: string) => void;
  /** Put a detected question into a tab's message box, below whatever is being typed there. */
  offerDraft: (tabId: string, text: string, onScreen: boolean) => void;
  markRead: (tabId: string) => void;
  attach: (tabId: string, ids: string[]) => void;
  detach: (tabId: string, id: string) => void;
  clearAttachments: (tabId: string) => void;
  /** A screenshot was deleted: it leaves every message box. */
  forgetScreenshot: (id: string) => void;
  closeTab: (tabId: string) => void;
  /** The engine restarted: nothing is streaming any more and conversations are read again. */
  reset: () => void;
}

/** The engine accepts at most this many screenshots with one message. */
export const MAX_ATTACHMENTS = 10;

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
}

function applyEnding(m: ChatMessage, ending: ChatEnding): ChatMessage {
  return { ...m, status: ending.status, model: ending.model ?? m.model, usage: ending.usage ?? m.usage, error: ending.status === "failed" ? (ending.error ?? null) : null, completed_at: Date.now() };
}

export const useChat = create<ChatStore>((set) => ({
  messages: {},
  streaming: {},
  sending: {},
  joinedLate: {},
  early: {},
  drafts: {},
  attachments: {},
  unread: {},

  load: (cid, messages, rid) =>
    set((st) => ({
      messages: { ...st.messages, [cid]: messages },
      streaming: rid ? { ...st.streaming, [cid]: rid } : without(st.streaming, cid),
      joinedLate: rid ? { ...st.joinedLate, [cid]: true } : without(st.joinedLate, cid),
    })),

  beginSend: (cid) => set((st) => ({ sending: { ...st.sending, [cid]: true } })),
  endSend: (cid) => set((st) => ({ sending: without(st.sending, cid) })),

  appendTurn: (cid, user, assistant, rid) =>
    set((st) => {
      // Asking again replaces everything after the question; a new question is added at the end.
      const kept = (st.messages[cid] ?? []).filter((m) => m.seq < user.seq);
      const early = st.early[assistant.id];
      let answer: ChatMessage = early ? { ...assistant, content: assistant.content + early.text } : assistant;
      if (early?.ending) answer = applyEnding(answer, early.ending);
      return {
        messages: { ...st.messages, [cid]: [...kept, user, answer] },
        streaming: early?.ending ? without(st.streaming, cid) : { ...st.streaming, [cid]: rid },
        early: without(st.early, assistant.id),
        sending: without(st.sending, cid),
      };
    }),

  delta: (cid, mid, text) =>
    set((st) => {
      const list = st.messages[cid];
      const index = list ? list.findIndex((m) => m.id === mid) : -1;
      if (!list || index < 0) {
        if (!st.sending[cid]) return st; // a conversation that is not open here
        const e = st.early[mid] ?? { text: "", ending: null };
        return { early: { ...st.early, [mid]: { ...e, text: e.text + text } } };
      }
      const next = list.slice();
      next[index] = { ...list[index], content: list[index].content + text };
      return { messages: { ...st.messages, [cid]: next } };
    }),

  finish: (cid, mid, ending) =>
    set((st) => {
      const list = st.messages[cid];
      const index = list ? list.findIndex((m) => m.id === mid) : -1;
      if (!list || index < 0) {
        if (!st.sending[cid]) return st;
        const e = st.early[mid] ?? { text: "", ending: null };
        return { early: { ...st.early, [mid]: { ...e, ending } } };
      }
      const next = list.slice();
      next[index] = applyEnding(list[index], ending);
      return { messages: { ...st.messages, [cid]: next }, streaming: without(st.streaming, cid) };
    }),

  forget: (cid) => set((st) => ({ messages: without(st.messages, cid), streaming: without(st.streaming, cid), sending: without(st.sending, cid), joinedLate: without(st.joinedLate, cid) })),

  setDraft: (tabId, text) => set((st) => ({ drafts: { ...st.drafts, [tabId]: text } })),
  offerDraft: (tabId, text, onScreen) =>
    set((st) => {
      const current = st.drafts[tabId] ?? "";
      if (current.includes(text)) return st;
      const draft = current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
      return { drafts: { ...st.drafts, [tabId]: draft }, unread: onScreen ? st.unread : { ...st.unread, [tabId]: true } };
    }),
  markRead: (tabId) => set((st) => ({ unread: without(st.unread, tabId) })),
  attach: (tabId, ids) =>
    set((st) => {
      const current = st.attachments[tabId] ?? [];
      const added = ids.filter((id, i) => !current.includes(id) && ids.indexOf(id) === i);
      return added.length ? { attachments: { ...st.attachments, [tabId]: [...current, ...added].slice(0, MAX_ATTACHMENTS) } } : st;
    }),
  detach: (tabId, id) => set((st) => ({ attachments: { ...st.attachments, [tabId]: (st.attachments[tabId] ?? []).filter((x) => x !== id) } })),
  clearAttachments: (tabId) => set((st) => ({ attachments: without(st.attachments, tabId) })),
  forgetScreenshot: (id) =>
    set((st) => {
      if (!Object.values(st.attachments).some((list) => list.includes(id))) return st;
      return { attachments: Object.fromEntries(Object.entries(st.attachments).map(([tab, list]) => [tab, list.filter((x) => x !== id)])) };
    }),
  closeTab: (tabId) => set((st) => ({ drafts: without(st.drafts, tabId), unread: without(st.unread, tabId), attachments: without(st.attachments, tabId) })),

  reset: () => set({ messages: {}, streaming: {}, sending: {}, joinedLate: {}, early: {} }),
}));
