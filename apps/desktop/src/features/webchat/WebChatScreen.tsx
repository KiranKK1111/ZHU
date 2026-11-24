import { ArrowRight, Globe, Loader2, MessagesSquare, Plus, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "@/app/state/chat";
import { usePrefs } from "@/app/state/prefs";
import { toast, useToasts } from "@/app/state/ui";
import { tabRuntime, useWebChat } from "@/app/state/webchat";
import { Button, IconButton } from "@/components/primitives/Button";
import { Modal } from "@/components/primitives/Dialog";
import { Spinner } from "@/components/primitives/Display";
import { Field, Input } from "@/components/primitives/Input";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Menu";
import { QuestionsColumn, ShowQuestionsButton } from "@/components/questions/QuestionsColumn";
import { inTauri, shell } from "@/services/shell";
import { useDropZone } from "@/hooks/useDropZone";
import { ensureTabLoaded, sendScreenshotsToTab } from "@/services/webchatDelivery";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";
import { CHAT_SERVICES, hostOf, isNativeChat, NATIVE_CHAT, normalizeChatUrl, type ChatService, type WebChatTab } from "./services";
import { openChatTab } from "./tabs";
import { WebChatOptions } from "./WebChatOptions";

// The built-in chat brings its Markdown, code highlighting and formula rendering; they load with the first chat tab.
const ChatPane = lazy(() => import("@/features/chat/ChatPane").then((m) => ({ default: m.ChatPane })));

/** Anything of ZHU's own UI that floats above the page area. The native chat webview would cover it. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-zhu-overlay="true"]';

/**
 * AI chats: provider websites as tabs inside ZHU, plus ZHU's own chat with the connected AI models.
 * A website is a native child webview that the shell positions over the placeholder below, so for
 * those this component only draws the tab strip and toolbar, and tells the shell where the page
 * goes. The built-in chat ("Custom chat") is drawn by ZHU itself (features/chat) and has no webview.
 */
export default function WebChatScreen() {
  const tabs = usePrefs((p) => p.webChatTabs);
  const activePref = usePrefs((p) => p.webChatActive);
  const setPrefs = usePrefs((p) => p.set);
  const runtime = useWebChat((s) => s.tabs);
  const chatStreaming = useChat((s) => s.streaming);
  const chatUnread = useChat((s) => s.unread);
  const active = tabs.find((t) => t.id === activePref) ?? tabs[0] ?? null;
  const native = !!active && isNativeChat(active);
  const hostRef = useRef<HTMLDivElement>(null);
  const questionsCollapsed = usePrefs((p) => p.questionsCollapsed);
  const [customOpen, setCustomOpen] = useState(false);
  const occluded = useOccluded();

  useChatViewport(native ? null : active, hostRef, occluded);

  // Questions delivered to a built-in chat tab mark it unread unless that tab is what the user is looking at.
  const nativeId = native ? active.id : null;
  useEffect(() => {
    useWebChat.getState().setNativeOnScreen(!!nativeId);
    if (nativeId) useChat.getState().markRead(nativeId);
    return () => useWebChat.getState().setNativeOnScreen(false);
  }, [nativeId]);

  const openTab = useCallback((service: Pick<ChatService, "id" | "name" | "url">) => void openChatTab(service), []);

  const closeTab = useCallback(
    (id: string) => {
      const all = usePrefs.getState().webChatTabs;
      const index = all.findIndex((t) => t.id === id);
      const rest = all.filter((t) => t.id !== id);
      const wasActive = (usePrefs.getState().webChatActive ?? all[0]?.id) === id;
      setPrefs({ webChatTabs: rest, webChatActive: wasActive ? (rest[Math.min(index, rest.length - 1)]?.id ?? null) : usePrefs.getState().webChatActive });
      useWebChat.getState().remove(id);
      // A built-in chat tab has no webview to close; its conversation stays in the chat history.
      if (all[index] && isNativeChat(all[index])) useChat.getState().closeTab(id);
      else if (inTauri) void shell.webchatClose(id).catch(() => undefined);
    },
    [setPrefs],
  );

  /** A built-in chat tab now shows another conversation (or none: a new chat). */
  const setConversation = useCallback(
    (tabId: string, conversation: string | null) => {
      setPrefs({ webChatTabs: usePrefs.getState().webChatTabs.map((t) => (t.id === tabId ? { ...t, conversation } : t)) });
    },
    [setPrefs],
  );
  const onConversation = useCallback((conversation: string | null) => (nativeId ? setConversation(nativeId, conversation) : undefined), [nativeId, setConversation]);

  // The questions column keeps its width and collapsed state in the preferences; the page area
  // below is measured by its own observer (useChatViewport), so the website's native view follows
  // the column as it is dragged, collapsed or opened.
  return (
    <QuestionsColumn>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
          {questionsCollapsed ? <ShowQuestionsButton /> : null}
          <div role="tablist" aria-label="Chat tabs" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {tabs.map((t) => {
              const r = tabRuntime(runtime, t.id);
              const selected = active?.id === t.id;
              const own = isNativeChat(t);
              const answering = own && !!t.conversation && !!chatStreaming[t.conversation];
              return (
                <div
                  key={t.id}
                  className={cn(
                    "group flex h-7 shrink-0 items-center rounded-md border text-secondary transition-colors duration-fast",
                    selected ? "border-border bg-active text-fg" : "border-transparent text-fg-2 hover:bg-hover hover:text-fg",
                  )}
                >
                  <button type="button" role="tab" aria-selected={selected} onClick={() => setPrefs({ webChatActive: t.id })} className="flex h-full items-center gap-1.5 pl-2.5 pr-1" title={r.last ? `${r.title ?? t.name}: ${r.last.message}` : (r.title ?? t.name)}>
                    {r.delivering || r.loading || answering ? (
                      <Loader2 className="h-3 w-3 animate-spin text-fg-3" aria-hidden />
                    ) : own ? (
                      chatUnread[t.id] ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" /> : <Sparkles className="h-3 w-3 text-accent" aria-hidden />
                    ) : (
                      <span
                        aria-hidden
                        className={cn("h-1.5 w-1.5 rounded-full", r.unread ? "bg-accent" : r.last && !r.last.ok ? "bg-warning" : r.loaded ? "bg-success" : "bg-fg-3")}
                      />
                    )}
                    <span className="max-w-[140px] truncate">{t.name}</span>
                    <span className="sr-only">{own ? (answering ? "(answering)" : chatUnread[t.id] ? "(draft ready)" : "") : r.unread ? "(draft ready)" : r.last && !r.last.ok ? "(needs attention)" : !r.loaded ? "(not loaded yet)" : ""}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${t.name}`}
                    onClick={() => closeTab(t.id)}
                    className="mr-1 flex h-4 w-4 items-center justify-center rounded-xs text-fg-3 opacity-60 hover:bg-hover hover:text-fg group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="Open a chat tab" size="sm" noTooltip>
                  <Plus className="h-4 w-4" />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuLabel>Chat inside ZHU</MenuLabel>
                <MenuItem icon={<Sparkles className="h-3.5 w-3.5 text-accent" />} onSelect={() => openTab(NATIVE_CHAT)}>
                  {NATIVE_CHAT.name}
                  <span className="ml-auto pl-4 text-caption text-fg-3">Free models</span>
                </MenuItem>
                <MenuSeparator />
                <MenuLabel>Open a chat website</MenuLabel>
                {CHAT_SERVICES.map((s) => (
                  <MenuItem key={s.id} onSelect={() => openTab(s)}>
                    {s.name}
                    <span className="ml-auto pl-4 text-caption text-fg-3">{s.vendor}</span>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem icon={<Globe className="h-3.5 w-3.5" />} onSelect={() => setCustomOpen(true)}>
                  Other website…
                </MenuItem>
              </MenuContent>
            </Menu>
          </div>
          <InlineStatus />
          <Popover>
            <PopoverTrigger asChild>
              <IconButton label="Delivery options" size="sm" noTooltip>
                <SlidersHorizontal className="h-4 w-4" />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent className="w-[400px] py-1">
              <WebChatOptions />
            </PopoverContent>
          </Popover>
        </div>

        <div ref={hostRef} className="relative min-h-0 flex-1 bg-surface">
          {active && native ? (
            <div className="absolute inset-0">
              <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner label="Opening chat" /></div>}>
                <ChatPane key={active.id} tab={active} onConversation={onConversation} />
              </Suspense>
            </div>
          ) : active && !inTauri ? (
            <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-body text-fg-2">
              Chat websites need the ZHU desktop app: they are native browser views inside its window.
            </div>
          ) : active ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-secondary text-fg-3" aria-hidden={!occluded}>
              <WebsiteDropZone tab={active} />
              {occluded ? (
                <span>The page is hidden while a menu or dialog is open.</span>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  <span>Loading {active.name}…</span>
                </>
              )}
            </div>
          ) : (
            <EmptyChats onOpen={openTab} onCustom={() => setCustomOpen(true)} />
          )}
        </div>

        <CustomTabDialog open={customOpen} onOpenChange={setCustomOpen} onAdd={(name, url) => openTab({ id: "custom", name, url })} />
      </div>
    </QuestionsColumn>
  );
}

/**
 * A website is a native view that covers ZHU's own drawing, so a dragged screenshot could never
 * be dropped on it. While one is being dragged this layer marks itself as an overlay, which hides
 * the page (see useOccluded), and takes the drop: the screenshot is added to the site's draft.
 */
function WebsiteDropZone({ tab }: { tab: WebChatTab }) {
  const drop = useDropZone(`web:${tab.id}`, (ids) => void sendScreenshotsToTab(tab.id, ids));
  if (!drop.dragging) return null;
  return (
    <div
      {...drop.props}
      data-zhu-overlay="true"
      className={cn(
        "absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-surface text-body transition-colors duration-fast",
        drop.over ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-2",
      )}
    >
      <Plus className="h-5 w-5" aria-hidden />
      <span className="font-medium">Drop to add to {tab.name}'s draft</span>
      <span className="text-secondary text-fg-3">The page comes back when you let go. You still press Send there.</span>
    </div>
  );
}

/** True while one of ZHU's own menus, dialogs or drawers is open (they would sit under the native page). */
function useOccluded(): boolean {
  const [occluded, setOccluded] = useState(false);
  useEffect(() => {
    const check = () => setOccluded(!!document.querySelector(OVERLAY_SELECTOR));
    check();
    // Radix renders menus and dialogs in portals appended to <body>; the sidebar marks its hover overlay.
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-zhu-overlay", "role"] });
    return () => mo.disconnect();
  }, []);
  return occluded;
}

/**
 * Show/hide/move commands run on the shell's thread pool, so two sent close together could be
 * applied in the wrong order (a late "hide" after a "show" would leave the page invisible).
 * They are chained here so the shell always sees them in the order the UI issued them.
 */
let viewportChain: Promise<unknown> = Promise.resolve();
function viewport(command: () => Promise<unknown>): void {
  viewportChain = viewportChain.then(command).catch(() => undefined);
}

/** Keeps the active tab's native webview exactly over the placeholder element. */
function useChatViewport(active: WebChatTab | null, hostRef: React.RefObject<HTMLDivElement>, occluded: boolean): void {
  const id = active?.id ?? null;
  const url = active?.url ?? null;

  useLayoutEffect(() => {
    if (!inTauri) return;
    const host = hostRef.current;
    if (!active || !id || !url || !host || occluded) {
      useWebChat.getState().setOnScreen(null);
      viewport(() => shell.webchatHide());
      return;
    }
    let cancelled = false;
    let frame = 0;
    const place = () => {
      if (cancelled) return;
      const r = host.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const bounds = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      viewport(() => (cancelled ? Promise.resolve() : shell.webchatShow(id, bounds)));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    void ensureTabLoaded(active)
      .then((loaded) => {
        if (cancelled || !loaded) return;
        useWebChat.getState().setOnScreen(id);
        place();
      })
      .catch((e) => toast.error("Could not open the chat tab", errorMessage(e)));
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    window.addEventListener("resize", schedule);
    // The screen fades in with a small vertical offset; measure again once it has settled.
    const settle = [setTimeout(place, 220), setTimeout(place, 600)];
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      settle.forEach(clearTimeout);
    };
    // `active` is a new object on every preference change; its id and url are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, url, occluded, hostRef]);

  // Leaving the screen: the page must not stay on top of another screen.
  useEffect(
    () => () => {
      useWebChat.getState().setOnScreen(null);
      if (inTauri) viewport(() => shell.webchatHide());
    },
    [],
  );
}

/** Toasts are drawn bottom-right, under the native page, so on this screen the latest one is shown inline. */
function InlineStatus() {
  const latest = useToasts((s) => s.toasts[s.toasts.length - 1]);
  if (!latest) return null;
  return (
    <span role={latest.kind === "error" ? "alert" : "status"} className={cn("max-w-[42%] shrink truncate px-2 text-caption", latest.kind === "error" ? "text-danger" : latest.kind === "success" ? "text-success" : "text-fg-2")} title={latest.description ? `${latest.title} — ${latest.description}` : latest.title}>
      {latest.title}
      {latest.description ? ` — ${latest.description}` : ""}
    </span>
  );
}

function EmptyChats({ onOpen, onCustom }: { onOpen: (s: ChatService) => void; onCustom: () => void }) {
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-6 py-10">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <div>
            <h1 className="zhu-display text-section text-fg">AI chats</h1>
            <p className="mt-1 text-body text-fg-2">
              Chat with free AI models inside ZHU, or open the chat websites you already use as tabs. On a website you sign in once; the sign-in is kept for every tab and after a restart. While you
              are listening, each detected question is placed in the message box of the open tabs (websites also get each screenshot). You only press Send.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpen(NATIVE_CHAT)}
          className="group flex items-center gap-3.5 rounded-xl border border-[color-mix(in_srgb,var(--zhu-accent)_35%,transparent)] bg-accent-soft px-4 py-3.5 text-left transition-[border-color,filter] duration-fast hover:border-accent hover:brightness-105"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-1">
            <Sparkles className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-card text-fg">{NATIVE_CHAT.name}</span>
            <span className="block text-secondary text-fg-2">ZHU's own chat. Choose from the free models of the providers you connect, or add your own provider. No website, no sign-in page.</span>
          </span>
          <ArrowRight className="h-4 w-4 shrink-0 text-accent transition-transform duration-fast group-hover:translate-x-0.5" aria-hidden />
        </button>
        <div className="grid grid-cols-2 gap-2 @[560px]:grid-cols-3">
          {CHAT_SERVICES.map((s) => (
            <button key={s.id} type="button" onClick={() => onOpen(s)} className="flex flex-col items-start rounded-lg border border-border-subtle bg-surface-2 px-3.5 py-3 text-left transition-colors duration-fast hover:border-border hover:bg-surface-3">
              <span className="text-body font-medium text-fg">{s.name}</span>
              <span className="text-caption text-fg-3">{s.vendor}</span>
            </button>
          ))}
          <button type="button" onClick={onCustom} className="flex flex-col items-start rounded-lg border border-dashed border-border bg-transparent px-3.5 py-3 text-left transition-colors duration-fast hover:bg-hover">
            <span className="text-body font-medium text-fg">Other website…</span>
            <span className="text-caption text-fg-3">Any https chat site</span>
          </button>
        </div>
        <p className="text-caption text-fg-3">
          ZHU never signs in for you and never presses Send. The sites are the providers' own pages, under their terms and your account's limits. Some providers refuse sign-in inside app-embedded
          browsers (Google does this for some accounts); if that happens, use that provider's API under Providers, or its website in your browser.
        </p>
      </div>
    </div>
  );
}

function CustomTabDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (name: string, url: string) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const url = normalizeChatUrl(address);
  const submit = () => {
    if (!url) return;
    onAdd(name.trim() || hostOf(url), url);
    setName("");
    setAddress("");
    onOpenChange(false);
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Open another chat website"
      description="ZHU finds the message box on the page automatically. Sites with unusual editors may not accept inserted text."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!url} onClick={submit}>
            Open tab
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Address" hint={address.trim() && !url ? "Enter an https address, for example chat.example.com" : "https only"} htmlFor="webchat-url">
          <Input id="webchat-url" autoFocus value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://chat.example.com" spellCheck={false} />
        </Field>
        <Field label="Tab name (optional)" htmlFor="webchat-name">
          <Input id="webchat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={url ? hostOf(url) : "My assistant"} maxLength={40} />
        </Field>
      </form>
    </Modal>
  );
}
