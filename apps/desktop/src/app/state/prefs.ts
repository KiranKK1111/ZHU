/**
 * UI preferences, separate from engine settings. Persisted in localStorage and
 * broadcast to the other windows through the "zhu://prefs" Tauri event.
 */
import { create } from "zustand";
import { broadcast } from "@/services/shell";
import { DEFAULT_HOTKEYS, type HotkeyAction } from "@/types/shell";
import type { WebChatTab } from "@/features/webchat/services";

export interface Prefs {
  theme: "dark" | "light" | "system";
  closeToTray: boolean;
  /** Show a small floating ZHU icon while the main window is minimized. */
  minimizeToBubble: boolean;
  /** Show ZHU's own pointer while the mouse is over a ZHU window. */
  customCursor: boolean;
  hotkeys: Record<HotkeyAction, string>;
  /** How see-through ZHU's windows are, from 0.4 to 1 (see state/opacity.ts; hidden ZHU has its own level). */
  windowOpacity: number;
  modelSetupSkipped: boolean;
  /** Show the live transcript under the questions on the Home screen. */
  showTranscript: boolean;
  /** Home: the share of the width the questions take (the answers have the rest). */
  homeSplit: number;
  /** Home: the share of the questions column's height the transcript takes. */
  transcriptSplit: number;
  /** The connected AI model (provider id) that answers questions on the Home screen. */
  answerProvider: string | null;
  /** Ask the selected model as soon as a question is detected. */
  autoAnswer: boolean;
  /** Optional guidance for every answer ("Answer briefly, as in an interview"); also prefixed to questions sent to chat tabs. */
  instructions: string;
  /** Embedded web chat tabs (ChatGPT, Claude, …) and how detected questions reach them. */
  webChatTabs: WebChatTab[];
  webChatActive: string | null;
  webChatAutoQuestions: boolean;
  webChatAutoScreenshots: boolean;
  /** Which tabs receive questions and screenshots. */
  webChatTarget: "all" | "active";
  /** The provider and model the built-in chat answers with (null: the first free model). */
  chatProvider: string | null;
  chatModel: string | null;
  /** The chat's model list shows only models that cost nothing. */
  chatFreeOnly: boolean;
  /** The panel on the right (screenshots and résumé) is open. */
  sidePanelOpen: boolean;
  /** Which screenshots the panel lists. */
  sidePanelScope: "session" | "all";
}

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  closeToTray: true,
  minimizeToBubble: true,
  customCursor: true,
  hotkeys: { ...DEFAULT_HOTKEYS },
  windowOpacity: 1,
  modelSetupSkipped: false,
  showTranscript: true,
  homeSplit: 0.5,
  transcriptSplit: 0.34,
  answerProvider: null,
  autoAnswer: false,
  instructions: "",
  webChatTabs: [],
  webChatActive: null,
  webChatAutoQuestions: true,
  webChatAutoScreenshots: true,
  webChatTarget: "all",
  chatProvider: null,
  chatModel: null,
  chatFreeOnly: true,
  sidePanelOpen: true,
  sidePanelScope: "all",
};

/** Keep only known, well-typed preferences (older versions stored many more). */
function pick(raw: Partial<Prefs>): Prefs {
  const out: Record<string, unknown> = { ...DEFAULT_PREFS };
  const nullable = new Set(["answerProvider", "webChatActive", "chatProvider", "chatModel"]);
  for (const [key, fallback] of Object.entries(DEFAULT_PREFS)) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const ok = nullable.has(key) ? v === null || typeof v === "string" : v !== null && typeof v === typeof fallback;
    if (ok) out[key] = v;
  }
  const prefs = out as unknown as Prefs;
  // Only the shortcuts that exist: one saved for a feature that was removed (area capture) is dropped.
  prefs.hotkeys = { ...DEFAULT_HOTKEYS };
  for (const action of Object.keys(DEFAULT_HOTKEYS) as (keyof typeof DEFAULT_HOTKEYS)[]) {
    const saved = (raw.hotkeys as Record<string, unknown> | undefined)?.[action];
    if (typeof saved === "string" && saved) prefs.hotkeys[action] = saved;
  }
  if (!Array.isArray(prefs.webChatTabs)) prefs.webChatTabs = [];
  return prefs;
}

const KEY = "zhu.prefs.v1";
// One-time migration: the floating icon on minimize is on by default. An earlier build briefly
// saved `minimizeToBubble: false`; restore it to on once so the icon comes back. The Settings
// toggle still controls it afterwards.
const BUBBLE_RESTORE_MIGRATION = "zhu.prefs.bubbleRestore.v1";

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    const prefs = raw ? pick(JSON.parse(raw) as Partial<Prefs>) : { ...DEFAULT_PREFS };
    if (!localStorage.getItem(BUBBLE_RESTORE_MIGRATION)) {
      prefs.minimizeToBubble = true;
      localStorage.setItem(BUBBLE_RESTORE_MIGRATION, "1");
      save(prefs);
    }
    return prefs;
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function save(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable; prefs stay in memory */
  }
}

interface PrefsStore extends Prefs {
  set: (patch: Partial<Prefs>) => void;
  /** Apply prefs received from another window (no re-broadcast). */
  applyRemote: (p: Prefs) => void;
}

export const usePrefs = create<PrefsStore>((setState, get) => ({
  ...load(),
  set: (patch) => {
    setState(patch);
    const { set: _s, applyRemote: _a, ...prefs } = { ...get() };
    save(prefs);
    void broadcast("zhu://prefs", prefs);
  },
  applyRemote: (p) => {
    setState(pick(p));
  },
}));

export function currentPrefs(): Prefs {
  const { set: _s, applyRemote: _a, ...prefs } = usePrefs.getState();
  return prefs;
}
