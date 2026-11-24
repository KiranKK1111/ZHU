import { beforeEach, describe, expect, it, vi } from "vitest";

const sentToTab: unknown[][] = [];
vi.mock("@/services/shell", () => ({ inTauri: true, shell: {}, broadcast: async () => undefined }));
vi.mock("@/services/webchatDelivery", () => ({ sendScreenshotsToTab: async (...a: unknown[]) => void sentToTab.push(a) }));

import { MAX_ATTACHMENTS, useChat } from "@/app/state/chat";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { useToasts } from "@/app/state/ui";
import { addScreenshotsTo, chatTargetLabel, currentChatTarget } from "@/services/screenshotActions";
import { beginScreenshotDrag, registerDropZone, useScreenshotDrag, wasDragged } from "@/services/screenshotDrag";

const web = { id: "chatgpt-00000001", service: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" };
const own = { id: "zhu-00000002", service: "zhu", name: "Custom chat", url: "about:blank" };

beforeEach(() => {
  sentToTab.length = 0;
  usePrefs.setState({ ...DEFAULT_PREFS, webChatTabs: [web, own], webChatActive: own.id });
  useChat.setState({ attachments: {}, drafts: {}, unread: {} });
  useToasts.setState({ toasts: [] });
});

describe("screenshots waiting in a chat's message box", () => {
  it("are kept in order, once each, up to what one message can carry", () => {
    const chat = useChat.getState();
    chat.attach("t1", ["a", "b", "a"]);
    chat.attach("t1", ["b", "c"]);
    expect(useChat.getState().attachments.t1).toEqual(["a", "b", "c"]);
    chat.attach("t1", Array.from({ length: 20 }, (_, i) => `s${i}`));
    expect(useChat.getState().attachments.t1).toHaveLength(MAX_ATTACHMENTS);
    chat.detach("t1", "b");
    expect(useChat.getState().attachments.t1).not.toContain("b");
  });

  it("drop a screenshot everywhere when it is deleted, and go with their tab", () => {
    const chat = useChat.getState();
    chat.attach("t1", ["a", "b"]);
    chat.attach("t2", ["b"]);
    chat.forgetScreenshot("b");
    expect(useChat.getState().attachments).toEqual({ t1: ["a"], t2: [] });
    chat.closeTab("t1");
    expect(useChat.getState().attachments).toEqual({ t2: [] });
  });
});

describe("where “Add to chat” goes", () => {
  it("is the chat tab that is shown, or a new Custom chat when no tab is open", () => {
    expect(currentChatTarget()).toEqual({ kind: "chat", tabId: own.id, name: "Custom chat" });
    usePrefs.setState({ webChatActive: web.id });
    expect(currentChatTarget()).toEqual({ kind: "website", tabId: web.id, name: "ChatGPT" });
    expect(chatTargetLabel(currentChatTarget())).toBe("ChatGPT");
    usePrefs.setState({ webChatTabs: [], webChatActive: null });
    expect(currentChatTarget()).toEqual({ kind: "new" });
    expect(chatTargetLabel(currentChatTarget())).toBe("a new Custom chat");
  });

  it("puts screenshots into that message box and sends nothing", () => {
    addScreenshotsTo({ kind: "chat", tabId: own.id, name: "Custom chat" }, ["a", "b"]);
    expect(useChat.getState().attachments[own.id]).toEqual(["a", "b"]);
    addScreenshotsTo({ kind: "website", tabId: web.id, name: "ChatGPT" }, ["d"]);
    expect(sentToTab).toEqual([[web.id, ["d"]]]); // a website gets it as a draft, through the page helper
    addScreenshotsTo({ kind: "chat", tabId: own.id, name: "Custom chat" }, []);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["2 screenshots added to Custom chat"]);
  });

  it("opens a Custom chat for the screenshots when no chat tab is open", () => {
    usePrefs.setState({ webChatTabs: [], webChatActive: null });
    addScreenshotsTo({ kind: "new" }, ["c"]);
    const [tab] = usePrefs.getState().webChatTabs;
    expect(tab).toMatchObject({ service: "zhu", name: "Custom chat" });
    expect(usePrefs.getState().webChatActive).toBe(tab.id);
    expect(useChat.getState().attachments[tab.id]).toEqual(["c"]);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Screenshot added to Custom chat"]);
  });
});

describe("dragging a screenshot", () => {
  const source = document.createElement("button");
  const zone = document.createElement("div");
  zone.dataset.dropZone = "chat:t1";
  const elsewhere = document.createElement("div");
  let under: Element = elsewhere;
  let dropped: string[][] = [];
  const pointer = (type: string, x: number, y: number) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));
  const press = (ids: string[]) => beginScreenshotDrag({ button: 0, clientX: 100, clientY: 100, pointerId: 1, currentTarget: source }, ids);
  let off = () => undefined as void;

  beforeEach(() => {
    document.body.replaceChildren(source, zone, elsewhere);
    document.elementFromPoint = () => under;
    under = elsewhere;
    dropped = [];
    off();
    off = registerDropZone("chat:t1", (ids) => void dropped.push(ids));
    useScreenshotDrag.setState({ ids: null, over: null });
  });

  it("starts only after the pointer has moved, so a click stays a click", () => {
    press(["a"]);
    pointer("pointermove", 103, 102);
    expect(useScreenshotDrag.getState().ids).toBeNull();
    pointer("pointerup", 103, 102);
    expect(wasDragged()).toBe(false);
    expect(document.querySelector(".zhu-drag-ghost")).toBeNull();
    expect(dropped).toEqual([]);
  });

  it("shows where it can go and delivers the whole selection on release", () => {
    press(["a", "b"]);
    pointer("pointermove", 140, 150);
    expect(useScreenshotDrag.getState()).toMatchObject({ ids: ["a", "b"], over: null });
    expect(document.querySelector(".zhu-drag-ghost span")?.textContent).toBe("2");
    under = zone;
    pointer("pointermove", 400, 500);
    expect(useScreenshotDrag.getState().over).toBe("chat:t1");
    pointer("pointerup", 400, 500);
    expect(dropped).toEqual([["a", "b"]]);
    expect(useScreenshotDrag.getState()).toMatchObject({ ids: null, over: null });
    expect(document.querySelector(".zhu-drag-ghost")).toBeNull();
    expect(wasDragged()).toBe(true); // the release must not also count as a click on the tile
  });

  it("does nothing when released elsewhere, on a zone nobody listens to, or after Escape", () => {
    press(["a"]);
    pointer("pointermove", 300, 300);
    pointer("pointerup", 300, 300);
    const stranger = document.createElement("div");
    stranger.dataset.dropZone = "unregistered";
    under = stranger;
    press(["a"]);
    pointer("pointermove", 300, 300);
    expect(useScreenshotDrag.getState().over).toBeNull();
    pointer("pointerup", 300, 300);
    under = zone;
    press(["a"]);
    pointer("pointermove", 300, 300);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(useScreenshotDrag.getState().ids).toBeNull();
    pointer("pointerup", 300, 300); // the release after Escape is not a drop
    expect(dropped).toEqual([]);
  });
});

describe("ZHU's pointer", () => {
  it("is one arrow, with its hot spot at the tip and the Windows arrow as fallback", async () => {
    const { CURSOR_SIZE, ZHU_ARROW } = await import("@/styles/cursors");
    expect(ZHU_ARROW.css).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) 2 2, default$/);
    expect(decodeURIComponent(ZHU_ARROW.src)).toContain(`width="${CURSOR_SIZE}" height="${CURSOR_SIZE}"`);
    expect([ZHU_ARROW.hotX, ZHU_ARROW.hotY]).toEqual([2, 2]); // the tip
  });

  it("is the only pointer: one rule gives every element the arrow, and no other rule sets a pointer", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (file: string) => readFileSync(resolve(__dirname, "../src/styles", file), "utf8");
    const css = read("globals.css");
    expect(css).toMatch(/html,\s*html \*,\s*html \*::before,\s*html \*::after\s*\{\s*cursor: var\(--zhu-cursor, default\) !important;/);
    // Every cursor declaration: the arrow rule, and "none" where the page draws the arrow itself.
    const values = [...css.matchAll(/cursor:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(values.sort()).toEqual(["none !important", "var(--zhu-cursor, default) !important"]);
    expect(read("chat.css")).not.toMatch(/cursor:/);
  });

  it("is drawn by the page exactly where its image would reach past the window, and nowhere else", async () => {
    const { installZhuCursors, reachesPastEdge, ZHU_ARROW } = await import("@/styles/cursors");
    const arrow = ZHU_ARROW; // 24 px image, hot spot 2,2
    expect(reachesPastEdge(arrow, 500, 300, 1000, 800)).toBe(false);
    expect(reachesPastEdge(arrow, 976, 300, 1000, 800)).toBe(false); // 976 - 2 + 24 = 998: still inside
    expect(reachesPastEdge(arrow, 978, 300, 1000, 800)).toBe(true); // the right strip
    expect(reachesPastEdge(arrow, 500, 778, 1000, 800)).toBe(true); // the bottom strip
    expect(reachesPastEdge(arrow, 2, 300, 1000, 800)).toBe(true); // hard against the left edge
    expect(reachesPastEdge(arrow, 4, 4, 1000, 800)).toBe(false);

    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    document.body.innerHTML = '<div id="plain">x</div><button id="b">Go</button>';
    const root = document.documentElement;
    const off = installZhuCursors(root);
    expect(root.style.getPropertyValue("--zhu-cursor")).toBe(arrow.css);
    const follower = document.querySelector<HTMLElement>(".zhu-edge-cursor")!;
    const move = (id: string, x: number, y: number) => document.getElementById(id)!.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y }));

    move("plain", 500, 300);
    expect(root.classList.contains("zhu-cursor-at-edge")).toBe(false); // Windows draws it here
    move("plain", 990, 300);
    expect(root.classList.contains("zhu-cursor-at-edge")).toBe(true); // system pointer hidden…
    expect(follower.style.display).toBe("block"); // …and the same image drawn by the page,
    expect(follower.style.transform).toBe("translate(988px, 298px)"); // with its tip on the mouse
    expect(follower.getAttribute("src")).toBe(arrow.src);
    move("b", 990, 300);
    expect(follower.getAttribute("src")).toBe(arrow.src); // the arrow over a button too
    move("plain", 500, 300);
    expect(root.classList.contains("zhu-cursor-at-edge")).toBe(false);
    expect(follower.style.display).toBe("none");

    move("plain", 990, 300);
    off(); // switched off in Settings
    expect(root.classList.contains("zhu-cursor-at-edge")).toBe(false);
    expect(document.querySelector(".zhu-edge-cursor")).toBeNull();
    expect(root.style.getPropertyValue("--zhu-cursor")).toBe("");
  });
});
