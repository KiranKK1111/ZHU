/**
 * What can be done with screenshots from the side panel: put them into the chat the user is
 * looking at, copy, delete. Shared by the buttons and by drag and drop.
 */
import { useChat } from "@/app/state/chat";
import { useComposer } from "@/app/state/composer";
import { currentPrefs } from "@/app/state/prefs";
import { toast, useNav } from "@/app/state/ui";
import { isNativeChat } from "@/features/webchat/services";
import { api } from "@/services/engine";
import { errorMessage } from "@/utils/format";
import { sendScreenshotsToTab } from "./webchatDelivery";

export type ChatTarget = { kind: "home" } | { kind: "chat"; tabId: string; name: string } | { kind: "website"; tabId: string; name: string };

/** Where "Add to chat" goes: the chat tab that is open on the AI chats screen, otherwise the ask box on Home. */
export function currentChatTarget(): ChatTarget {
  if (useNav.getState().route !== "webchats") return { kind: "home" };
  const p = currentPrefs();
  const tab = p.webChatTabs.find((t) => t.id === p.webChatActive) ?? p.webChatTabs[0];
  if (!tab) return { kind: "home" };
  return isNativeChat(tab) ? { kind: "chat", tabId: tab.id, name: tab.name } : { kind: "website", tabId: tab.id, name: tab.name };
}

export function chatTargetLabel(t: ChatTarget): string {
  return t.kind === "home" ? "the ask box on Home" : t.name;
}

/** Put screenshots into a message box. Nothing is sent to a model until the user presses Send there. */
export function addScreenshotsTo(target: ChatTarget, ids: string[]): void {
  if (!ids.length) return;
  const what = ids.length === 1 ? "Screenshot" : `${ids.length} screenshots`;
  if (target.kind === "chat") {
    useChat.getState().attach(target.tabId, ids);
    toast.success(`${what} added to ${target.name}`);
  } else if (target.kind === "website") {
    void sendScreenshotsToTab(target.tabId, ids);
  } else {
    useComposer.getState().attach(ids);
    toast.success(`${what} added to the ask box`, useNav.getState().route === "home" ? undefined : "It is waiting on Home.");
  }
}

export async function copyScreenshot(id: string): Promise<void> {
  try {
    await api.copyScreenshot(id);
    toast.success("Screenshot copied");
  } catch (err) {
    toast.error("Could not copy the screenshot", errorMessage(err));
  }
}

/** Delete screenshots for good (files included). Returns how many were deleted. */
export async function deleteScreenshots(ids: string[]): Promise<number> {
  const results = await Promise.allSettled(ids.map((id) => api.deleteScreenshot(id)));
  const failed = results.filter((r) => r.status === "rejected");
  const done = ids.length - failed.length;
  if (failed.length) toast.error(failed.length === 1 ? "A screenshot could not be deleted" : `${failed.length} screenshots could not be deleted`, errorMessage((failed[0] as PromiseRejectedResult).reason));
  else toast.success(done === 1 ? "Screenshot deleted" : `${done} screenshots deleted`);
  return done;
}
