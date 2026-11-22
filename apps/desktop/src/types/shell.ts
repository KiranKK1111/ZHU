/** Contract with the Rust shell (apps/desktop/src-tauri). */

export type WindowKind = "main" | "bubble";

export interface EngineInfo {
  status: "starting" | "ready" | "failed";
  port: number | null;
  token: string | null;
  error: string | null;
  /** The engine did not stop when asked: only restarting ZHU can start it again. */
  stuck?: boolean;
}

export type HotkeyAction = "toggle_listening" | "capture_screen" | "copy_latest_question";

export const HOTKEY_ACTIONS: HotkeyAction[] = ["toggle_listening", "capture_screen", "copy_latest_question"];

export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  toggle_listening: "CommandOrControl+Shift+L",
  capture_screen: "CommandOrControl+Shift+A",
  copy_latest_question: "CommandOrControl+Shift+C",
};

export const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  toggle_listening: "Start, pause or resume listening",
  capture_screen: "Screenshot of the whole screen",
  copy_latest_question: "Copy the latest question",
};

export type TrayAction = "toggle_listening" | "open_settings" | "new_session";

// ------------------------------------------------------------------ embedded web chat tabs
/** Area of the main window (CSS pixels) that a chat tab's webview covers. */
export interface WebChatBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebChatTabSnapshot {
  id: string;
  url: string | null;
  loading: boolean;
}

export interface WebChatImage {
  id: string;
  name: string;
  mime: string;
  /** Base64 image bytes. */
  data: string;
}

export interface WebChatDeliverPayload {
  service: string;
  text: string | null;
  images: WebChatImage[];
  force: boolean;
}

/** Reported by the page helper. ZHU never presses Send, so "ok" means "the draft is ready". */
export interface WebChatDeliverResult {
  done: boolean;
  ok: boolean;
  /** Set when the delivery did not run: "sign_in" (a sign-in page is showing), "no_message_box", "timeout", "script_error". */
  reason?: string;
  message?: string;
  url?: string;
  /** What happened to the text. */
  text?: "replace" | "append" | "already_there" | "none" | "failed";
  text_method?: string | null;
  /** Number of images handed to the page, how, and whether a preview appeared. */
  images?: number;
  images_method?: "paste" | "file-input" | "drop" | "none" | null;
  images_confirmed?: boolean;
}

export interface WebChatEvent {
  id: string;
  kind: "loading" | "loaded" | "title";
  url: string | null;
  title: string | null;
}
