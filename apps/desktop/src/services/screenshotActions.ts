/**
 * What can be done with screenshots from the side panel: put them into the chat tab that is open,
 * copy, delete. Shared by the buttons and by drag and drop.
 */
import { useChat } from "@/app/state/chat";
import { currentPrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { isNativeChat } from "@/features/webchat/services";
import { chatTabsOrCustom } from "@/features/webchat/tabs";
import { api } from "@/services/engine";
import { errorMessage } from "@/utils/format";
import { sendScreenshotsToTab } from "./webchatDelivery";

export type ChatTarget = { kind: "chat"; tabId: string; name: string } | { kind: "website"; tabId: string; name: string } | { kind: "new" };

/** Where "Add to chat" goes: the chat tab that is shown, or a new Custom chat when no tab is open. */
export function currentChatTarget(): ChatTarget {
  const p = currentPrefs();
  const tab = p.webChatTabs.find((t) => t.id === p.webChatActive) ?? p.webChatTabs[0];
  if (!tab) return { kind: "new" };
  return isNativeChat(tab) ? { kind: "chat", tabId: tab.id, name: tab.name } : { kind: "website", tabId: tab.id, name: tab.name };
}

export function chatTargetLabel(t: ChatTarget): string {
  return t.kind === "new" ? "a new Custom chat" : t.name;
}

/** Put screenshots into a message box. Nothing is sent to a model until the user presses Send there. */
export function addScreenshotsTo(target: ChatTarget, ids: string[]): void {
  if (!ids.length) return;
  const what = ids.length === 1 ? "Screenshot" : `${ids.length} screenshots`;
  if (target.kind === "website") {
    void sendScreenshotsToTab(target.tabId, ids);
    return;
  }
  const tab = target.kind === "chat" ? { id: target.tabId, name: target.name } : chatTabsOrCustom()[0];
  useChat.getState().attach(tab.id, ids);
  toast.success(`${what} added to ${tab.name}`);
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
