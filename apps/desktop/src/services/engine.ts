/**
 * Authenticated HTTP client for the local engine (127.0.0.1 only). The bearer token
 * comes from the Rust shell and is kept in memory only.
 */
import type {
  AudioDevice,
  ChatConversation,
  ChatMessage,
  ChatSendResult,
  Diagnostics,
  EngineSettings,
  Interaction,
  ListeningStatus,
  ModelsStatus,
  Monitor,
  ProviderConfig,
  ProviderInfo,
  ProviderTestResult,
  ResumeInfo,
  Question,
  Screenshot,
  Session,
  SettingsPatch,
  TranscriptRow,
} from "@/types/engine";

export interface Connection {
  port: number;
  token: string;
}

let connection: Connection | null = null;
const listeners = new Set<(c: Connection | null) => void>();

export function setConnection(c: Connection | null): void {
  connection = c;
  for (const l of listeners) l(c);
}
export function getConnection(): Connection | null {
  return connection;
}
export function onConnectionChange(fn: (c: Connection | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class EngineHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "EngineHttpError";
  }
}

function baseUrl(): string {
  if (!connection) throw new EngineHttpError(0, "The local engine is not connected yet.");
  return `http://127.0.0.1:${connection.port}/api`;
}

function detailMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) {
      return d
        .map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : String(x)))
        .join("; ");
    }
  }
  return `Request failed (HTTP ${status})`;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const url = baseUrl() + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${connection!.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new EngineHttpError(0, "Cannot reach the local engine. It may be restarting.");
  }
  const type = res.headers.get("content-type") ?? "";
  const payload: unknown = type.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new EngineHttpError(res.status, detailMessage(payload, res.status));
  return payload as T;
}

/** Send a file as the request body (the engine reads it and keeps only what it needs). */
async function upload<T>(path: string, file: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(baseUrl() + path, { method: "POST", headers: { Authorization: `Bearer ${connection!.token}`, "Content-Type": "application/octet-stream" }, body: file });
  } catch {
    throw new EngineHttpError(0, "Cannot reach the local engine. It may be restarting.");
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new EngineHttpError(res.status, detailMessage(payload, res.status));
  return payload as T;
}

export async function fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(baseUrl() + path, { headers: { Authorization: `Bearer ${connection!.token}` }, signal });
  if (!res.ok) throw new EngineHttpError(res.status, `Image unavailable (HTTP ${res.status})`);
  return res.blob();
}

const enc = encodeURIComponent;
const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return entries.length ? "?" + entries.map(([k, v]) => `${enc(k)}=${enc(String(v))}`).join("&") : "";
};

export const api = {
  diagnostics: () => request<Diagnostics>("GET", "/system/diagnostics"),

  settings: () => request<EngineSettings>("GET", "/settings"),
  updateSettings: (patch: SettingsPatch) => request<EngineSettings>("PUT", "/settings", patch),
  audioDevices: () => request<AudioDevice[]>("GET", "/audio/devices"),
  models: () => request<ModelsStatus>("GET", "/models"),
  downloadModel: (name: string) => request<unknown>("POST", `/models/${enc(name)}/download`),
  cancelDownload: () => request<unknown>("POST", "/models/cancel"),
  deleteModel: (name: string) => request<ModelsStatus>("DELETE", `/models/${enc(name)}`),
  sessions: (p: { query?: string; sort?: string; limit?: number } = {}) => request<Session[]>("GET", `/sessions${qs(p)}`),
  createSession: (name?: string) => request<Session>("POST", "/sessions", { name: name ?? null }),
  session: (id: string) => request<Session>("GET", `/sessions/${enc(id)}`),
  updateSession: (id: string, patch: { name?: string; notes?: string }) => request<Session>("PATCH", `/sessions/${enc(id)}`, patch),
  endSession: (id: string) => request<Session>("POST", `/sessions/${enc(id)}/end`),
  deleteSession: (id: string) => request<{ ok: boolean }>("DELETE", `/sessions/${enc(id)}`),
  exportSession: (id: string, format: "md" | "json") => request<string | object>("GET", `/sessions/${enc(id)}/export?format=${format}`),
  transcript: (id: string) => request<TranscriptRow[]>("GET", `/sessions/${enc(id)}/transcript`),
  clearTranscript: (id: string) => request<{ ok: boolean; removed: number }>("DELETE", `/sessions/${enc(id)}/transcript`),
  startListening: (sessionId: string, sources?: ("microphone" | "system")[]) =>
    request<ListeningStatus>("POST", "/listening/start", { session_id: sessionId, sources: sources ?? null }),
  pauseListening: () => request<ListeningStatus>("POST", "/listening/pause"),
  resumeListening: () => request<ListeningStatus>("POST", "/listening/resume"),
  stopListening: () => request<ListeningStatus>("POST", "/listening/stop"),
  questions: (sessionId: string, includeDiscarded = false) =>
    request<Question[]>("GET", `/sessions/${enc(sessionId)}/questions${qs({ include_discarded: includeDiscarded || undefined })}`),
  clearQuestions: (sessionId: string) => request<{ ok: boolean; removed: number }>("DELETE", `/sessions/${enc(sessionId)}/questions`),
  createQuestion: (sessionId: string, text: string) => request<Question[]>("POST", "/questions", { session_id: sessionId, text }),

  editQuestion: (id: string, text: string) => request<Question[]>("PATCH", `/questions/${enc(id)}`, { text }),
  discardQuestion: (id: string) => request<Question[]>("DELETE", `/questions/${enc(id)}`),

  monitors: () => request<Monitor[]>("GET", "/capture/monitors"),
  capture: (mode: "monitor" | "all" | "window", monitor?: number, sessionId?: string | null) =>
    request<Screenshot>("POST", "/capture", { mode, monitor: monitor ?? null, session_id: sessionId ?? null }),
  screenshots: (sessionId?: string | null) => request<Screenshot[]>("GET", `/screenshots${qs({ session_id: sessionId ?? undefined })}`),
  deleteScreenshot: (id: string) => request<{ ok: boolean }>("DELETE", `/screenshots/${enc(id)}`),
  copyScreenshot: (id: string) => request<{ ok: boolean }>("POST", `/screenshots/${enc(id)}/copy`),

  resume: () => request<ResumeInfo | null>("GET", "/resume"),
  uploadResume: (file: File) => upload<ResumeInfo>(`/resume${qs({ file_name: file.name })}`, file),
  enableResume: (enabled: boolean) => request<ResumeInfo>("PATCH", "/resume", { enabled }),
  deleteResume: () => request<{ ok: boolean }>("DELETE", "/resume"),

  providers: () => request<ProviderInfo[]>("GET", "/providers"),
  updateProvider: (id: string, patch: Partial<Omit<ProviderConfig, "known_models">> & { api_key?: string }) =>
    request<ProviderInfo>("PUT", `/providers/${enc(id)}/config`, patch),
  addCustomProvider: (body: { name: string; base_url: string; model?: string | null; api_key?: string | null; images?: boolean }) =>
    request<ProviderInfo>("POST", "/providers/custom", body),
  removeProvider: (id: string) => request<{ ok: boolean }>("DELETE", `/providers/${enc(id)}`),
  forgetProviderKey: (id: string) => request<ProviderInfo>("DELETE", `/providers/${enc(id)}/credential`),
  testProvider: (id: string) => request<ProviderTestResult>("POST", `/providers/${enc(id)}/test`),
  submitPrompt: (id: string, body: { session_id: string | null; prompt: string; screenshot_ids: string[]; model?: string | null; system?: string | null }) =>
    request<{ request_id: string; interaction_id: string; model: string }>("POST", `/providers/${enc(id)}/submit`, body),
  cancelRequest: (requestId: string) => request<{ cancelled: boolean }>("POST", `/requests/${enc(requestId)}/cancel`),
  interactions: (sessionId: string) => request<Interaction[]>("GET", `/sessions/${enc(sessionId)}/interactions`),

  // The built-in chat tab.
  chats: () => request<ChatConversation[]>("GET", "/chats"),
  createChat: () => request<ChatConversation>("POST", "/chats", {}),
  chat: (id: string) => request<ChatConversation & { messages: ChatMessage[] }>("GET", `/chats/${enc(id)}`),
  renameChat: (id: string, title: string) => request<ChatConversation>("PATCH", `/chats/${enc(id)}`, { title }),
  deleteChat: (id: string) => request<{ ok: boolean }>("DELETE", `/chats/${enc(id)}`),
  sendChat: (id: string, body: { provider_id: string; model: string | null; content?: string; regenerate?: boolean; screenshot_ids?: string[] }) =>
    request<ChatSendResult>("POST", `/chats/${enc(id)}/messages`, body),

  purgeAll: () => request<{ ok: boolean }>("POST", "/data/purge", { confirm: "DELETE" }),
};

export const imagePaths = {
  thumbnail: (id: string) => `/screenshots/${enc(id)}/thumbnail`,
  image: (id: string) => `/screenshots/${enc(id)}/image`,
};
