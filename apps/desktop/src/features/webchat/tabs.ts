/**
 * Opening chat tabs, from the tab strip's + menu or when something needs a chat and none is open
 * (a question or a screenshot sent while no tab is there opens a Custom chat for it).
 */
import { usePrefs } from "@/app/state/prefs";
import { NATIVE_CHAT, newTabId, type ChatService, type WebChatTab } from "./services";

/** Add a tab for this service and show it. A second tab of the same service is numbered ("ChatGPT 2"). */
export function openChatTab(service: Pick<ChatService, "id" | "name" | "url">): WebChatTab {
  const tab: WebChatTab = { id: newTabId(service.id), service: service.id, name: service.name, url: service.url };
  const all = usePrefs.getState().webChatTabs;
  const sameService = all.filter((t) => t.service === service.id).length;
  if (sameService) tab.name = `${service.name} ${sameService + 1}`;
  usePrefs.getState().set({ webChatTabs: [...all, tab], webChatActive: tab.id });
  return tab;
}

/** The chat tabs, opening a Custom chat first when there are none. */
export function chatTabsOrCustom(): WebChatTab[] {
  const tabs = usePrefs.getState().webChatTabs;
  return tabs.length ? tabs : [openChatTab(NATIVE_CHAT)];
}
