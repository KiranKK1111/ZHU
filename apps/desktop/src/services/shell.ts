/**
 * Thin wrapper over the Rust shell commands and events. Every function degrades
 * gracefully outside Tauri (plain-browser development), so the UI never crashes
 * there, though shell-only features are unavailable.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { EngineInfo, HotkeyAction, WebChatBounds, WebChatDeliverPayload, WebChatDeliverResult, WebChatTabSnapshot, WindowKind } from "@/types/shell";

export const inTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function windowKind(): WindowKind {
  if (inTauri) {
    try {
      const label = getCurrentWindow().label;
      if (label === "sidecar" || label === "bubble" || label === "main") return label;
    } catch {
      /* fall through to query parameter */
    }
  }
  const q = new URLSearchParams(window.location.search).get("window");
  return q === "sidecar" || q === "bubble" ? q : "main";
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error(`"${cmd}" is only available in the ZHU desktop app`);
  return invoke<T>(cmd, args);
}

export const shell = {
  engineInfo: () => call<EngineInfo>("engine_info"),
  restartEngine: () => call<EngineInfo>("restart_engine"),
  showMain: () => call<void>("show_main"),
  showSidecar: () => call<void>("show_sidecar"),
  hideSidecar: () => call<void>("hide_sidecar"),
  toggleSidecar: () => call<void>("toggle_sidecar"),
  setClickThrough: (enabled: boolean) => call<void>("set_click_through", { enabled }),
  /** Take ZHU out of the taskbar, Alt+Tab and screen captures, or put it back (see bars.rs). Off at every start. */
  setHiddenFromBars: (hidden: boolean) => call<void>("set_hidden_from_bars", { hidden }),
  hiddenFromBars: () => call<boolean>("hidden_from_bars"),
  setSidecarAlwaysOnTop: (enabled: boolean) => call<void>("set_sidecar_always_on_top", { enabled }),
  setTrayState: (recording: boolean, paused: boolean) => call<void>("set_tray_state", { recording, paused }),
  /** Leave ZHU's own windows out of a capture that is about to be taken (see lib.rs). */
  captureShield: (on: boolean) => call<void>("capture_shield", { on }),
  setMinimizeBubble: (enabled: boolean) => call<void>("set_minimize_bubble", { enabled }),
  setCustomCursor: (enabled: boolean) => call<void>("set_custom_cursor", { enabled }),
  bubbleAlive: () => call<void>("bubble_alive"),
  recordingState: () => call<{ recording: boolean; paused: boolean }>("recording_state"),
  setCloseToTray: (enabled: boolean) => call<void>("set_close_to_tray", { enabled }),
  setHotkeys: (map: Record<HotkeyAction, string>) => call<Record<HotkeyAction, string | null>>("set_hotkeys", { map }),
  exportFile: (defaultName: string, contents: string) => call<string | null>("export_file", { defaultName, contents }),
  // Embedded web chat tabs (child webviews of the main window).
  webchatOpen: (id: string, url: string) => call<boolean>("webchat_open", { id, url }),
  webchatShow: (id: string, bounds: WebChatBounds) => call<void>("webchat_show", { id, bounds }),
  webchatHide: () => call<void>("webchat_hide"),
  webchatClose: (id: string) => call<void>("webchat_close", { id }),
  webchatNavigate: (id: string, action: "back" | "forward" | "reload" | "goto", url?: string) => call<void>("webchat_navigate", { id, action, url: url ?? null }),
  webchatTabs: () => call<WebChatTabSnapshot[]>("webchat_tabs"),
  webchatClearData: () => call<void>("webchat_clear_data"),
  webchatDeliver: (id: string, payload: WebChatDeliverPayload) => call<WebChatDeliverResult>("webchat_deliver", { id, payload }),
};

export async function onShellEvent<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => undefined;
  return listen<T>(name, (e) => handler(e.payload));
}

export async function broadcast<T>(name: string, payload: T): Promise<void> {
  if (!inTauri) return;
  try {
    await emit(name, payload);
  } catch {
    /* another window may be closing; not fatal */
  }
}

export async function copyText(text: string): Promise<void> {
  if (inTauri) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) links can be opened");
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export const autostart = {
  async isEnabled(): Promise<boolean | null> {
    if (!inTauri) return null;
    const m = await import("@tauri-apps/plugin-autostart");
    return m.isEnabled();
  },
  async set(enabled: boolean): Promise<void> {
    const m = await import("@tauri-apps/plugin-autostart");
    if (enabled) await m.enable();
    else await m.disable();
  },
};

/** Download text through the native save dialog, or a browser download outside Tauri. */
export async function saveTextFile(defaultName: string, contents: string): Promise<string | null> {
  if (inTauri) return shell.exportFile(defaultName, contents);
  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return defaultName;
}
