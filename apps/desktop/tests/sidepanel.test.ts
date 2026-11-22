import { beforeEach, describe, expect, it, vi } from "vitest";

const sentToTab: unknown[][] = [];
vi.mock("@/services/shell", () => ({ inTauri: true, shell: {}, broadcast: async () => undefined }));
vi.mock("@/services/webchatDelivery", () => ({ sendScreenshotsToTab: async (...a: unknown[]) => void sentToTab.push(a) }));

import { MAX_ATTACHMENTS, useChat } from "@/app/state/chat";
import { useComposer } from "@/app/state/composer";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { useNav, useToasts } from "@/app/state/ui";
import { addScreenshotsTo, chatTargetLabel, currentChatTarget } from "@/services/screenshotActions";
import { beginScreenshotDrag, registerDropZone, useScreenshotDrag, wasDragged } from "@/services/screenshotDrag";

const web = { id: "chatgpt-00000001", service: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" };
const own = { id: "zhu-00000002", service: "zhu", name: "Custom chat", url: "about:blank" };

beforeEach(() => {
  sentToTab.length = 0;
  usePrefs.setState({ ...DEFAULT_PREFS, webChatTabs: [web, own], webChatActive: own.id });
  useChat.setState({ attachments: {}, drafts: {}, unread: {} });
  useComposer.setState({ draft: "", attachments: [] });
  useToasts.setState({ toasts: [] });
  useNav.setState({ route: "home" });
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
  it("is the chat tab that is open on AI chats, otherwise the ask box on Home", () => {
    expect(currentChatTarget()).toEqual({ kind: "home" }); // on Home, even with chat tabs open
    useNav.setState({ route: "webchats" });
    expect(currentChatTarget()).toEqual({ kind: "chat", tabId: own.id, name: "Custom chat" });
    usePrefs.setState({ webChatActive: web.id });
    expect(currentChatTarget()).toEqual({ kind: "website", tabId: web.id, name: "ChatGPT" });
    expect(chatTargetLabel(currentChatTarget())).toBe("ChatGPT");
    usePrefs.setState({ webChatTabs: [], webChatActive: null });
    expect(chatTargetLabel(currentChatTarget())).toBe("the ask box on Home");
  });

  it("puts screenshots into that message box and sends nothing", () => {
    addScreenshotsTo({ kind: "chat", tabId: own.id, name: "Custom chat" }, ["a", "b"]);
    expect(useChat.getState().attachments[own.id]).toEqual(["a", "b"]);
    addScreenshotsTo({ kind: "home" }, ["c"]);
    expect(useComposer.getState().attachments).toEqual(["c"]);
    addScreenshotsTo({ kind: "website", tabId: web.id, name: "ChatGPT" }, ["d"]);
    expect(sentToTab).toEqual([[web.id, ["d"]]]); // a website gets it as a draft, through the page helper
    addScreenshotsTo({ kind: "home" }, []);
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["2 screenshots added to Custom chat", "Screenshot added to the ask box"]);
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
  it("has an arrow, a clickable variant and a text beam, each with its hot spot inside the image", async () => {
    const { CURSOR_SIZE, ZHU_CURSORS } = await import("@/styles/cursors");
    for (const kind of ["arrow", "action", "text"] as const) {
      const c = ZHU_CURSORS[kind];
      expect(c.css).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\) \d+ \d+, (default|pointer|text)$/);
      expect(decodeURIComponent(c.src)).toContain(`width="${CURSOR_SIZE}" height="${CURSOR_SIZE}"`);
      expect(c.hotX).toBeGreaterThanOrEqual(0);
      expect(c.hotX).toBeLessThan(CURSOR_SIZE);
      expect(c.hotY).toBeLessThan(CURSOR_SIZE);
    }
    expect([ZHU_CURSORS.arrow.hotX, ZHU_CURSORS.arrow.hotY]).toEqual([2, 2]); // the tip
    expect([ZHU_CURSORS.text.hotX, ZHU_CURSORS.text.hotY]).toEqual([12, 12]); // the middle
  });

  it("chooses the same pointer the style rules choose", async () => {
    const { cursorKindFor } = await import("@/styles/cursors");
    document.body.innerHTML = `
      <div id="plain">x</div>
      <button id="b"><span id="inb">Go</span></button>
      <button id="off" disabled>No</button>
      <div role="menuitem" class="cursor-default" id="menu">Item</div>
      <a href="#" id="link">l</a>
      <textarea id="ta"></textarea><input id="in" /><input type="checkbox" id="cb" />
      <div class="selectable" id="panel"><p id="para">Text <button id="copy">Copy</button></p></div>
      <p id="loose">not selectable</p>`;
    const kind = (id: string) => cursorKindFor(document.getElementById(id));
    expect(kind("plain")).toBe("arrow");
    expect(kind("b")).toBe("action");
    expect(kind("inb")).toBe("action"); // anything inside a button
    expect(kind("off")).toBe("arrow");
    expect(kind("menu")).toBe("arrow");
    expect(kind("link")).toBe("action");
    expect(kind("ta")).toBe("text");
    expect(kind("in")).toBe("text");
    expect(kind("cb")).toBe("action");
    expect(kind("para")).toBe("text"); // text that can be selected
    expect(kind("panel")).toBe("arrow"); // but not the empty part of its panel
    expect(kind("copy")).toBe("action"); // a button inside such text
    expect(kind("loose")).toBe("arrow");
    expect(cursorKindFor(null)).toBe("arrow");
  });

  it("is drawn by the page exactly where its image would reach past the window, and nowhere else", async () => {
    const { installZhuCursors, reachesPastEdge, ZHU_CURSORS } = await import("@/styles/cursors");
    const arrow = ZHU_CURSORS.arrow; // 24 px image, hot spot 2,2
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
    expect(follower.getAttribute("src")).toBe(ZHU_CURSORS.action.src); // the clickable variant over a button
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
