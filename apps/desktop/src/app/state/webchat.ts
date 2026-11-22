/**
 * Runtime state of the embedded web chat tabs (the tab list itself is a preference, see prefs.ts).
 * The shell reports page loads and titles through the "zhu://webchat" event.
 */
import { create } from "zustand";

export interface DeliveryNote {
  ok: boolean;
  message: string;
  at: number;
}

export interface TabRuntime {
  /** The shell has created this tab's webview. */
  loaded: boolean;
  loading: boolean;
  url: string | null;
  title: string | null;
  /** A draft was delivered while the tab was not on screen. */
  unread: boolean;
  delivering: boolean;
  last: DeliveryNote | null;
}

const EMPTY: TabRuntime = { loaded: false, loading: false, url: null, title: null, unread: false, delivering: false, last: null };

interface WebChatStore {
  tabs: Record<string, TabRuntime>;
  /** The tab whose webview is on screen right now (null on other screens or behind a dialog). */
  onScreen: string | null;
  /** The AI chats screen is open on a built-in chat tab (which has no webview). */
  nativeOnScreen: boolean;
  patch: (id: string, p: Partial<TabRuntime>) => void;
  remove: (id: string) => void;
  setOnScreen: (id: string | null) => void;
  setNativeOnScreen: (on: boolean) => void;
}

export const useWebChat = create<WebChatStore>((set) => ({
  tabs: {},
  onScreen: null,
  nativeOnScreen: false,
  patch: (id, p) => set((st) => ({ tabs: { ...st.tabs, [id]: { ...(st.tabs[id] ?? EMPTY), ...p } } })),
  remove: (id) =>
    set((st) => {
      const { [id]: _gone, ...rest } = st.tabs;
      return { tabs: rest, onScreen: st.onScreen === id ? null : st.onScreen };
    }),
  setOnScreen: (onScreen) =>
    set((st) => {
      if (!onScreen || !st.tabs[onScreen]?.unread) return { onScreen };
      return { onScreen, tabs: { ...st.tabs, [onScreen]: { ...st.tabs[onScreen], unread: false } } };
    }),
  setNativeOnScreen: (nativeOnScreen) => set({ nativeOnScreen }),
}));

export function tabRuntime(tabs: Record<string, TabRuntime>, id: string): TabRuntime {
  return tabs[id] ?? EMPTY;
}
