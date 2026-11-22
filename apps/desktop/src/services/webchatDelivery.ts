/**
 * Sends detected questions and captured screenshots to the embedded web chat tabs.
 *
 * "Send" here means: put the text into the site's message box and attach the images to the draft.
 * ZHU never presses the site's Send button; the user reviews the draft and submits it.
 *
 * Runs in the main window only. Deliveries to one tab are serialized, so two questions arriving
 * close together can never interleave in the same message box.
 */
import { useChat } from "@/app/state/chat";
import { currentPrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { toast } from "@/app/state/ui";
import { useWebChat } from "@/app/state/webchat";
import { isNativeChat, withInstructions, type WebChatTab } from "@/features/webchat/services";
import { fetchBlob } from "@/services/engine";
import { inTauri, shell } from "@/services/shell";
import type { Question, Screenshot } from "@/types/engine";
import type { WebChatDeliverResult, WebChatImage } from "@/types/shell";
import { errorMessage } from "@/utils/format";
import { questionCopyText } from "@/utils/questionPresentation";

export interface DeliveryRequest {
  text?: string | null;
  screenshotIds?: string[];
  /** Attach screenshots even if this page already received them. */
  force?: boolean;
  /** Explicit targets; otherwise the "all tabs / active tab" preference decides. */
  tabIds?: string[];
}

export interface DeliveryOutcome {
  tab: WebChatTab;
  ok: boolean;
  message: string;
}

/** Images larger than this are re-encoded (JPEG, at most 2560 px) before they go to a page. */
const MAX_DIRECT_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 2560;

const queues = new Map<string, Promise<unknown>>();

function tabExists(id: string): boolean {
  return currentPrefs().webChatTabs.some((t) => t.id === id);
}

/**
 * Create the tab's webview if needed. A tab can be closed while its webview is still being
 * created; the webview is then closed again so no page keeps running without a tab.
 */
export async function ensureTabLoaded(tab: WebChatTab): Promise<boolean> {
  if (!tabExists(tab.id)) return false;
  const created = await shell.webchatOpen(tab.id, tab.url);
  if (!tabExists(tab.id)) {
    await shell.webchatClose(tab.id).catch(() => undefined);
    useWebChat.getState().remove(tab.id);
    return false;
  }
  useWebChat.getState().patch(tab.id, created ? { loaded: true, loading: true, url: tab.url } : { loaded: true });
  return true;
}

/** Load the target tabs in the background (when listening starts), so the first question finds them ready. */
export function preloadTargetTabs(): void {
  const p = currentPrefs();
  if (!inTauri || !(p.webChatAutoQuestions || p.webChatAutoScreenshots)) return;
  for (const tab of targetTabs()) if (!isNativeChat(tab)) void ensureTabLoaded(tab).catch(() => undefined);
}

export function targetTabs(tabIds?: string[]): WebChatTab[] {
  const p = currentPrefs();
  if (tabIds) return p.webChatTabs.filter((t) => tabIds.includes(t.id));
  if (p.webChatTarget === "active") return p.webChatTabs.filter((t) => t.id === p.webChatActive);
  return p.webChatTabs;
}

/** Human-readable result of one delivery (pure; unit-tested). */
export function describeResult(r: WebChatDeliverResult, tabName: string): { ok: boolean; message: string } {
  if (r.reason === "sign_in") return { ok: false, message: `${tabName} is showing its sign-in page. Sign in there once; nothing was inserted.` };
  if (r.reason === "no_message_box") return { ok: false, message: `No message box found in ${tabName}. Sign in or open a chat there first.` };
  if (r.reason === "timeout") return { ok: false, message: `${tabName} did not respond in time.` };
  if (r.reason) return { ok: false, message: `${tabName}: ${r.message ?? r.reason}` };
  const parts: string[] = [];
  if (r.text === "replace" || r.text === "append") parts.push(r.text === "append" ? "Question added below your draft" : "Question ready");
  else if (r.text === "already_there") parts.push("Question already in the box");
  else if (r.text === "failed") parts.push("The question could not be inserted");
  const n = r.images ?? 0;
  if (n > 0) {
    const what = n === 1 ? "screenshot" : `${n} screenshots`;
    if (r.images_method === "none") parts.push(`this page did not accept the ${what} (some sites allow attachments only after sign-in)`);
    else parts.push(r.images_confirmed ? `${what} attached` : `${what} sent to the page (attachment not confirmed)`);
  }
  if (!parts.length) parts.push("Nothing new to add");
  const ok = r.ok && r.text !== "failed" && !(n > 0 && r.images_method === "none");
  const joined = parts.join("; ");
  return { ok, message: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}${ok ? " — review and press Send" : ""}` };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function shrink(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return out && out.size < blob.size ? out : blob;
  } finally {
    bitmap.close();
  }
}

async function loadImage(id: string): Promise<WebChatImage> {
  let blob = await fetchBlob(`/screenshots/${encodeURIComponent(id)}/image`);
  if (blob.size > MAX_DIRECT_BYTES) blob = await shrink(blob);
  const mime = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  return { id, name: `zhu-screenshot-${id.slice(-8)}.${ext}`, mime, data: await blobToBase64(blob) };
}

/**
 * The built-in chat has no page to type into: the question and the screenshots go into its
 * message box in ZHU's own state, and the user presses Send there as in any other tab.
 */
function deliverToNativeChat(tab: WebChatTab, text: string | null, screenshotIds: string[]): DeliveryOutcome {
  const onScreen = currentPrefs().webChatActive === tab.id && useWebChat.getState().nativeOnScreen;
  if (text) useChat.getState().offerDraft(tab.id, text, onScreen);
  if (screenshotIds.length) useChat.getState().attach(tab.id, screenshotIds);
  const parts = [text ? "question ready" : "", screenshotIds.length ? (screenshotIds.length === 1 ? "screenshot attached" : `${screenshotIds.length} screenshots attached`) : ""].filter(Boolean).join("; ");
  return { tab, ok: true, message: `${parts.charAt(0).toUpperCase()}${parts.slice(1)} — review and press Send` };
}

async function deliverOne(tab: WebChatTab, text: string | null, images: WebChatImage[], force: boolean, screenshotIds: string[]): Promise<DeliveryOutcome> {
  if (isNativeChat(tab)) return deliverToNativeChat(tab, text, screenshotIds);
  const store = useWebChat.getState();
  store.patch(tab.id, { delivering: true });
  let outcome: DeliveryOutcome;
  try {
    // A tab the user has not opened yet in this run has no webview: create it (hidden) first.
    if (!(await ensureTabLoaded(tab))) return { tab, ok: false, message: `${tab.name} was closed.` };
    const result = await shell.webchatDeliver(tab.id, { service: tab.service, text, images, force });
    outcome = { tab, ...describeResult(result, tab.name) };
  } catch (err) {
    outcome = { tab, ok: false, message: `${tab.name}: ${errorMessage(err)}` };
  }
  if (!tabExists(tab.id)) return outcome;
  const now = useWebChat.getState();
  now.patch(tab.id, {
    delivering: false,
    last: { ok: outcome.ok, message: outcome.message, at: Date.now() },
    unread: outcome.ok ? now.onScreen !== tab.id : (now.tabs[tab.id]?.unread ?? false),
  });
  return outcome;
}

/** Deliver to the target tabs. Resolves when every tab has reported. */
export async function deliverToChats(req: DeliveryRequest): Promise<DeliveryOutcome[]> {
  if (!inTauri) return [];
  const text = req.text?.trim() ? req.text.trim() : null;
  const ids = req.screenshotIds ?? [];
  const tabs = targetTabs(req.tabIds);
  if (!tabs.length || (!text && !ids.length)) return [];
  let images: WebChatImage[] = [];
  if (ids.length && tabs.some((t) => !isNativeChat(t))) {
    const loaded = await Promise.allSettled(ids.map(loadImage));
    images = loaded.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (!images.length && !text) return tabs.map((tab) => ({ tab, ok: false, message: "The screenshot could not be read." }));
  }
  return Promise.all(
    tabs.map((tab) => {
      const run = (queues.get(tab.id) ?? Promise.resolve()).then(() => deliverOne(tab, text, images, !!req.force, ids));
      queues.set(tab.id, run.catch(() => undefined));
      return run;
    }),
  );
}

function report(outcomes: DeliveryOutcome[], quietSuccess: boolean): void {
  const failed = outcomes.filter((o) => !o.ok && tabExists(o.tab.id));
  if (failed.length) toast.error(failed.length === 1 ? "Chat tab needs attention" : `${failed.length} chat tabs need attention`, failed.map((o) => o.message).join(" "));
  else if (!quietSuccess && outcomes.length) toast.success(outcomes.length === 1 ? `Sent to ${outcomes[0].tab.name}` : `Sent to ${outcomes.length} chat tabs`, "Review the draft and press Send.");
}

// ------------------------------------------------------------------ automatic delivery
/** question id -> text already delivered (so replayed or unchanged events are not sent twice). */
const sentQuestions = new Map<string, string>();
const sentScreenshots = new Set<string>();

function listeningNow(): boolean {
  const s = useSession.getState().listening?.state;
  return s === "listening" || s === "paused";
}

/**
 * A question completed (or was revised after completion). Only live questions are delivered:
 * events replayed after a reconnect, or for a session that is not being recorded, are ignored.
 */
export function onQuestionEvent(q: Question, revised: boolean): void {
  const p = currentPrefs();
  if (!inTauri || !p.webChatAutoQuestions || !p.webChatTabs.length) return;
  if (q.state === "DISCARDED" || !listeningNow()) return;
  const body = questionCopyText(q, true).trim();
  if (!body) return;
  const previous = sentQuestions.get(q.question_id);
  if (previous === body || (revised && previous === undefined)) return;
  sentQuestions.set(q.question_id, body);
  if (sentQuestions.size > 500) sentQuestions.delete(sentQuestions.keys().next().value as string);
  void deliverToChats({ text: withInstructions(p.instructions, body) }).then((o) => report(o, true));
}

export function onScreenshotEvent(s: Pick<Screenshot, "id" | "duplicate">): void {
  const p = currentPrefs();
  if (!inTauri || !p.webChatAutoScreenshots || !p.webChatTabs.length) return;
  if (!s.id || s.duplicate || sentScreenshots.has(s.id)) return;
  sentScreenshots.add(s.id);
  void deliverToChats({ screenshotIds: [s.id] }).then((o) => report(o, true));
}

// ------------------------------------------------------------------ manual delivery
export async function sendQuestionToChats(q: Question): Promise<void> {
  const p = currentPrefs();
  if (!p.webChatTabs.length) {
    toast.info("No chat tab is open", "Open one under AI chats first.");
    return;
  }
  sentQuestions.set(q.question_id, questionCopyText(q, true).trim());
  report(await deliverToChats({ text: withInstructions(p.instructions, questionCopyText(q, true)) }), false);
}

/** Add screenshots to one chat tab's draft (dropped on it, or "Add to chat" in the side panel). */
export async function sendScreenshotsToTab(tabId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  for (const id of ids) sentScreenshots.add(id);
  report(await deliverToChats({ screenshotIds: ids, force: true, tabIds: [tabId] }), false);
}

export async function sendScreenshotsToChats(ids: string[]): Promise<void> {
  if (!ids.length) return;
  if (!currentPrefs().webChatTabs.length) {
    toast.info("No chat tab is open", "Open one under AI chats first.");
    return;
  }
  for (const id of ids) sentScreenshots.add(id);
  report(await deliverToChats({ screenshotIds: ids, force: true }), false);
}
