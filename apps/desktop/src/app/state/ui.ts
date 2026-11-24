/** Navigation, toasts and transient UI state. */
import { create } from "zustand";
import type { DownloadProgress } from "@/types/engine";
import type { RouteId } from "@/app/routing/routes";

interface NavStore {
  route: RouteId;
  /** The speech-model setup screen is open (first run, or "Change" in Settings). */
  setupOpen: boolean;
  navigate: (r: RouteId) => void;
  setSetupOpen: (o: boolean) => void;
}

export const useNav = create<NavStore>((set) => ({
  route: "webchats",
  setupOpen: false,
  navigate: (route) => set({ route }),
  setSetupOpen: (setupOpen) => set({ setupOpen }),
}));

/** Toasts: restrained, at most three visible. */
export interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  description?: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let toastId = 1;
export const useToasts = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (t) => {
    // Collapse identical consecutive toasts instead of stacking duplicates.
    const last = get().toasts[get().toasts.length - 1];
    if (last && last.title === t.title && last.description === t.description) return;
    const id = toastId++;
    set((st) => ({ toasts: [...st.toasts, { ...t, id }].slice(-3) }));
    setTimeout(() => get().dismiss(id), t.kind === "error" ? 6000 : 3200);
  },
  dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((x) => x.id !== id) })),
}));

export const toast = {
  success: (title: string, description?: string) => useToasts.getState().push({ kind: "success", title, description }),
  error: (title: string, description?: string) => useToasts.getState().push({ kind: "error", title, description }),
  info: (title: string, description?: string) => useToasts.getState().push({ kind: "info", title, description }),
};

/** Model download progress (from model.download events). */
interface DownloadStore {
  progress: Record<string, DownloadProgress>;
  update: (p: DownloadProgress) => void;
  /** A model was removed: its finished download no longer says anything. */
  clear: (model: string) => void;
}

export const useDownloads = create<DownloadStore>((set) => ({
  progress: {},
  update: (p) => set((st) => ({ progress: { ...st.progress, [p.model]: p } })),
  clear: (model) =>
    set((st) => {
      const { [model]: _gone, ...rest } = st.progress;
      return { progress: rest };
    }),
}));
