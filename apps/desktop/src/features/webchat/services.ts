/**
 * Chat websites that can be opened as tabs inside ZHU. `id` is also the key for the message-box
 * hints in the shell's page helper (src-tauri/src/webchat_inject.js). Any other https chat site can
 * be added as a custom tab; the helper then finds the message box generically.
 */
export interface ChatService {
  id: string;
  name: string;
  vendor: string;
  url: string;
}

export const CHAT_SERVICES: ChatService[] = [
  { id: "chatgpt", name: "ChatGPT", vendor: "OpenAI", url: "https://chatgpt.com/" },
  { id: "claude", name: "Claude", vendor: "Anthropic", url: "https://claude.ai/new" },
  { id: "gemini", name: "Gemini", vendor: "Google", url: "https://gemini.google.com/app" },
  { id: "qwen", name: "Qwen", vendor: "Alibaba", url: "https://chat.qwen.ai/" },
  { id: "meta", name: "Meta AI", vendor: "Meta", url: "https://www.meta.ai/" },
  { id: "deepseek", name: "DeepSeek", vendor: "DeepSeek", url: "https://chat.deepseek.com/" },
  { id: "grok", name: "Grok", vendor: "xAI", url: "https://grok.com/" },
  { id: "copilot", name: "Copilot", vendor: "Microsoft", url: "https://copilot.microsoft.com/" },
  { id: "perplexity", name: "Perplexity", vendor: "Perplexity", url: "https://www.perplexity.ai/" },
  { id: "mistral", name: "Le Chat", vendor: "Mistral", url: "https://chat.mistral.ai/chat" },
  // The address without the advertising parameters of the link it was copied from.
  { id: "chatbox", name: "Chatbox AI", vendor: "chat-box.ai", url: "https://chat-box.ai/app/chat" },
];

export const SERVICE_BY_ID: Record<string, ChatService> = Object.fromEntries(CHAT_SERVICES.map((s) => [s.id, s]));

/**
 * ZHU's own chat: not a website but a conversation with the AI models connected under Settings,
 * drawn by ZHU itself (features/chat). It is a tab like the others, without a webview.
 */
export const NATIVE_CHAT: ChatService = { id: "zhu", name: "Custom chat", vendor: "Free models, built into ZHU", url: "about:blank" };

export function isNativeChat(tab: Pick<WebChatTab, "service">): boolean {
  return tab.service === NATIVE_CHAT.id;
}

/** A persisted tab. Several tabs may use the same service. */
export interface WebChatTab {
  /** Unique, [a-z0-9-] only: it becomes part of the webview label in the shell. */
  id: string;
  /** A CHAT_SERVICES id, "custom" (another website), or "zhu" (the built-in chat). */
  service: string;
  name: string;
  /** Home address (https). Unused by the built-in chat. */
  url: string;
  /** Built-in chat only: the conversation the tab shows (none until the first message). */
  conversation?: string | null;
}

export function newTabId(service: string): string {
  const safe = service.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "tab";
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${safe}-${rand}`;
}

/** Normalize a typed address to https, or return null when it is not a usable web address. */
export function normalizeChatUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The text that goes into a chat tab's message box: the user's answer instructions (if any), then the question. */
export function withInstructions(instructions: string, question: string): string {
  const t = instructions.trim();
  return t ? `${t}\n\n${question}` : question;
}
