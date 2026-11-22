/** Current session and live listening state. */
import { create } from "zustand";
import { broadcast } from "@/services/shell";
import type { GpuInfo, ListeningStatus } from "@/types/engine";

export const CURRENT_SESSION_KEY = "zhu.currentSession";
const KEY = CURRENT_SESSION_KEY;

function loadCurrent(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

interface SessionStore {
  currentSessionId: string | null;
  listening: ListeningStatus | null;
  listeningUpdatedAt: number;
  speech: Record<string, boolean>;
  levels: Record<string, number>;
  gpu: GpuInfo | null;
  streamStatus: "connecting" | "open" | "closed";
  setCurrentSession: (id: string | null) => void;
  /** Apply a session switch made in another window (no re-broadcast). */
  applyRemoteSession: (id: string | null) => void;
  setListening: (s: ListeningStatus) => void;
  setSpeech: (source: string, active: boolean) => void;
  setLevel: (source: string, db: number) => void;
  setGpu: (g: GpuInfo) => void;
  setStreamStatus: (s: "connecting" | "open" | "closed") => void;
}

export const useSession = create<SessionStore>((set) => ({
  currentSessionId: loadCurrent(),
  listening: null,
  listeningUpdatedAt: 0,
  speech: {},
  levels: {},
  gpu: null,
  streamStatus: "connecting",
  setCurrentSession: (id) => {
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ currentSessionId: id });
    void broadcast("zhu://session", { id });
  },
  applyRemoteSession: (id) => set((st) => (st.currentSessionId === id ? st : { currentSessionId: id })),
  setListening: (s) => set({ listening: s, listeningUpdatedAt: performance.now() }),
  setSpeech: (source, active) => set((st) => (st.speech[source] === active ? st : { speech: { ...st.speech, [source]: active } })),
  setLevel: (source, db) => set((st) => ({ levels: { ...st.levels, [source]: db } })),
  setGpu: (g) => set({ gpu: g }),
  setStreamStatus: (s) => set({ streamStatus: s }),
}));

/** Derived: is recording active (listening or paused) for display purposes. */
export function isRecording(s: ListeningStatus | null): boolean {
  return !!s && (s.state === "listening" || s.state === "paused" || s.state === "loading_model");
}
