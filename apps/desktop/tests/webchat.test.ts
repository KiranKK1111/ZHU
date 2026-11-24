import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliver = vi.fn(async (..._args: unknown[]) => ({ done: true, ok: true, text: "replace", images: 0 }));
const open = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@/services/shell", () => ({
  inTauri: true,
  shell: { webchatOpen: (...a: unknown[]) => open(...a), webchatDeliver: (...a: unknown[]) => deliver(...a) },
  broadcast: async () => undefined,
}));
let chatContext: ChatContext | null = null;
vi.mock("@/services/engine", () => ({
  api: { chatContext: async () => chatContext },
  fetchBlob: async () => new Blob(),
}));

import { usePrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { useWebChat } from "@/app/state/webchat";
import { isInsecureRemote } from "@/features/settings/ModelsSection";
import { CHAT_SERVICES, hostOf, newTabId, normalizeChatUrl, withInstructions } from "@/features/webchat/services";
import { describeResult, onQuestionEvent, onScreenshotEvent, sendQuestionToChats, targetTabs } from "@/services/webchatDelivery";
import type { ChatContext, Question } from "@/types/engine";

/** The resume as the engine hands it to chat sites (resume.chat_context). */
const CTX: ChatContext = {
  marker: "zhu-1a2b3c4d",
  file_name: "resume-zhu-1a2b3c4d.txt",
  text: "About me, for this whole chat (zhu-1a2b3c4d)\n\nBelow is my resume. Answer questions about me from it.\n\n=== MY RESUME ===\nAsha Rao, Senior Backend Engineer",
  note: "My resume is attached (resume-zhu-1a2b3c4d.txt). Use it for this whole chat, as the file says.",
  question_heading: "=== QUESTION ===",
};

const INJECT = readFileSync(resolve(__dirname, "../src-tauri/src/webchat_inject.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("chat services", () => {
  it("are https, unique, and each has message-box hints in the page helper", () => {
    expect(new Set(CHAT_SERVICES.map((s) => s.id)).size).toBe(CHAT_SERVICES.length);
    for (const s of CHAT_SERVICES) {
      expect(new URL(s.url).protocol).toBe("https:");
      expect(INJECT).toMatch(new RegExp(`\\n\\s+${s.id}: \\[`));
    }
  });

  it("makes tab ids that are valid webview label parts", () => {
    for (const service of ["chatgpt", "custom", "We!rd Name", ""]) expect(newTabId(service)).toMatch(/^[a-z0-9]{1,16}-[0-9a-f]{8}$/);
    expect(newTabId("claude")).not.toBe(newTabId("claude"));
  });

  it("accepts only https addresses for custom tabs", () => {
    expect(normalizeChatUrl("chat.example.com")).toBe("https://chat.example.com/");
    expect(normalizeChatUrl(" https://chat.example.com/app ")).toBe("https://chat.example.com/app");
    for (const bad of ["", "http://chat.example.com", "file:///C:/x", "javascript:alert(1)", "localhost", "tauri://localhost"]) expect(normalizeChatUrl(bad)).toBeNull();
    expect(hostOf("https://www.meta.ai/x")).toBe("meta.ai");
    expect(hostOf("nonsense")).toBe("");
  });

  it("puts the answer instructions before the question", () => {
    expect(withInstructions("", "Q?")).toBe("Q?");
    expect(withInstructions("  ", "Q?")).toBe("Q?");
    expect(withInstructions("Answer briefly.", "Q?")).toBe("Answer briefly.\n\nQ?");
  });
});

describe("delivery results", () => {
  it("never claims more than the page reported", () => {
    expect(describeResult({ done: true, ok: true, text: "replace", images: 0 }, "ChatGPT")).toEqual({ ok: true, message: "Question ready — review and press Send" });
    expect(describeResult({ done: true, ok: true, text: "append", images: 1, images_method: "paste", images_confirmed: true }, "X").message).toBe(
      "Question added below your draft; screenshot attached — review and press Send",
    );
    const unconfirmed = describeResult({ done: true, ok: true, text: "none", images: 2, images_method: "paste", images_confirmed: false }, "X");
    expect(unconfirmed.ok).toBe(true);
    expect(unconfirmed.message).toContain("attachment not confirmed");
    const refused = describeResult({ done: true, ok: false, text: "none", images: 1, images_method: "none" }, "Gemini");
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/^This page did not accept the screenshot/);
    expect(describeResult({ done: true, ok: false, reason: "sign_in" }, "Claude")).toEqual({ ok: false, message: "Claude is showing its sign-in page. Sign in there once; nothing was inserted." });
    expect(describeResult({ done: true, ok: false, reason: "no_message_box" }, "Claude").ok).toBe(false);
    expect(describeResult({ done: true, ok: false, text: "failed", images: 0 }, "X").ok).toBe(false);
  });

  it("says what happened to the resume", () => {
    const r = (extra: object) => ({ done: true, ok: true, text: "replace" as const, images: 0, ...extra });
    expect(describeResult(r({ context: "file", context_confirmed: true }), "X").message).toBe("Resume attached; question ready — review and press Send");
    expect(describeResult(r({ context: "file", context_confirmed: false }), "X").message).toMatch(/^Resume sent to the page \(attachment not confirmed\); question ready/);
    expect(describeResult(r({ context: "text" }), "X").message).toBe("Resume added to the message; question ready — review and press Send");
    // A chat under way, or a draft that has it already: only the question is mentioned.
    expect(describeResult(r({ context: "skipped" }), "X").message).toBe("Question ready — review and press Send");
    expect(describeResult(r({ context: "already_there" }), "X").message).toBe("Question ready — review and press Send");
    const failed = describeResult({ done: true, ok: false, text: "failed", images: 0, context: "failed" }, "X");
    expect(failed).toEqual({ ok: false, message: "The resume could not be added; the question could not be inserted" });
    // "Add resume" alone: there is no question to talk about.
    expect(describeResult(r({ context: "file", context_confirmed: true }), "X", false).message).toBe("Resume attached — review and press Send");
    expect(describeResult(r({ text: "already_there", context: "already_there" }), "X", false).message).toBe("The resume is already in this draft — review and press Send");
  });
});

describe("custom model endpoints", () => {
  it("flags unencrypted remote addresses only", () => {
    expect(isInsecureRemote("http://192.168.1.20:8000/v1")).toBe(true);
    expect(isInsecureRemote("http://example.com/v1")).toBe(true);
    for (const fine of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "https://api.example.com/v1", "", "not a url"]) expect(isInsecureRemote(fine)).toBe(false);
  });
});

function question(id: string, text: string, state: Question["state"] = "COMPLETE"): Question {
  return { question_id: id, session_id: "s1", state, revision: 1, display_text: text, formatted_text: text, subquestions: [] } as unknown as Question;
}

describe("automatic delivery", () => {
  const tabs = [
    { id: "chatgpt-00000001", service: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
    { id: "claude-00000002", service: "claude", name: "Claude", url: "https://claude.ai/new" },
  ];
  const listen = (state: string | null) => useSession.setState({ listening: state ? ({ state } as never) : null });

  beforeEach(() => {
    deliver.mockClear();
    open.mockClear();
    usePrefs.setState({ webChatTabs: tabs, webChatActive: tabs[1].id, webChatAutoQuestions: true, webChatAutoScreenshots: true, webChatTarget: "all", instructions: "" });
    chatContext = null;
    useWebChat.setState({ tabs: {}, onScreen: null });
    listen("listening");
  });

  it("sends a completed question to every open tab while listening, once", async () => {
    onQuestionEvent(question("q1", "What is a mutex?"), false);
    await flush();
    await flush();
    expect(deliver.mock.calls.map((c) => c[0])).toEqual(["chatgpt-00000001", "claude-00000002"]);
    expect(deliver.mock.calls[0][1]).toEqual({ service: "chatgpt", text: "What is a mutex?", images: [], force: false, context: null });
    expect(useWebChat.getState().tabs["chatgpt-00000001"].unread).toBe(true);
    onQuestionEvent(question("q1", "What is a mutex?"), false); // replayed event
    await flush();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("re-sends a question only when its text was revised after it was sent", async () => {
    onQuestionEvent(question("q2", "Never sent before"), true);
    await flush();
    expect(deliver).not.toHaveBeenCalled();
    onQuestionEvent(question("q3", "What is a semaphor?"), false);
    onQuestionEvent(question("q3", "What is a semaphore?"), true);
    await flush();
    await flush();
    await flush();
    expect(deliver.mock.calls.filter((c) => c[0] === "claude-00000002").map((c) => (c[1] as { text: string }).text)).toEqual(["What is a semaphor?", "What is a semaphore?"]);
  });

  it("does nothing when not listening, when switched off, for discarded questions, or without tabs", async () => {
    listen("idle");
    onQuestionEvent(question("q4", "Old question from a replay"), false);
    listen("listening");
    usePrefs.setState({ webChatAutoQuestions: false });
    onQuestionEvent(question("q5", "Switched off"), false);
    usePrefs.setState({ webChatAutoQuestions: true });
    onQuestionEvent(question("q6", "Discarded", "DISCARDED"), false);
    usePrefs.setState({ webChatTabs: [] });
    onQuestionEvent(question("q7", "No tabs"), false);
    onScreenshotEvent({ id: "shot-x" });
    await flush();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("honours the selected-tab target and the answer instructions", async () => {
    usePrefs.setState({ webChatTarget: "active", instructions: "Answer briefly." });
    expect(targetTabs().map((t) => t.id)).toEqual(["claude-00000002"]);
    onQuestionEvent(question("q8", "What is CAP?"), false);
    await flush();
    await flush();
    expect(deliver.mock.calls).toHaveLength(1);
    expect(deliver.mock.calls[0]).toEqual(["claude-00000002", { service: "claude", text: "Answer briefly.\n\nWhat is CAP?", images: [], force: false, context: null }]);
  });

  it("offers the resume with every question, for the page to add in a new chat", async () => {
    chatContext = CTX;
    onQuestionEvent(question("q9", "Tell me about yourself."), false);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    const sent = deliver.mock.calls.map((c) => c[1] as { text: string; context: Record<string, unknown> });
    expect(sent[0].text).toBe("Tell me about yourself."); // the page composes the message, not the window
    expect(sent[0].context).toEqual({ ...CTX, mode: "file", force: false, home: "/" });
    expect(sent[1].context).toMatchObject({ mode: "file", force: false, home: "/new" }); // Claude's new chat is /new

    // Always as a file (no setting any more): the page helper puts it in the message where a site takes no files.
    deliver.mockClear();
    await sendQuestionToChats(question("q10", "Why this company?"));
    expect(deliver.mock.calls.every((c) => (c[1] as { context: { mode: string } }).context.mode === "file")).toBe(true);
  });
});

// ------------------------------------------------------------------ the page helper itself (plain text boxes; rich editors are tested on real sites)
describe("page helper", () => {
  type Step = { done: boolean; ok?: boolean; text?: string; phase?: string; sign_in?: boolean; reason?: string };
  type Helper = { begin: (m: object) => boolean; step: (job: number) => Step };
  let job = 0;

  function load(html: string): Helper {
    document.body.innerHTML = html;
    delete (window as unknown as { __zhu?: unknown }).__zhu;
    // jsdom has no layout: give every element a plausible box so the size checks pass.
    Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 600, left: 0, top: 600, right: 600, bottom: 640, width: 600, height: 40, toJSON: () => ({}) });
    new Function(INJECT)();
    return (window as unknown as { __zhu: Helper }).__zhu;
  }

  function run(z: Helper, text: string, service = "custom"): Step {
    job += 1;
    z.begin({ job, service, text, force: false, images: [] });
    let s: Step = { done: false };
    for (let i = 0; i < 20 && !s.done; i++) s = z.step(job);
    return s;
  }

  it("fills a plain text box, replaces its own unsent draft, and appends to the user's text", () => {
    const z = load('<input type="search" /><textarea id="box"></textarea><button>Send</button>');
    const box = document.getElementById("box") as HTMLTextAreaElement;
    let inputs = 0;
    box.addEventListener("input", () => inputs++);
    expect(run(z, "First question?")).toMatchObject({ done: true, ok: true, text: "replace" });
    expect(box.value).toBe("First question?");
    expect(inputs).toBe(1); // frameworks hear a real input event
    expect(run(z, "First question?").text).toBe("already_there");
    expect(run(z, "Second question?").text).toBe("replace");
    expect(box.value).toBe("Second question?");
    box.value = "my own notes";
    expect(run(z, "Third question?").text).toBe("append");
    expect(box.value).toBe("my own notes\n\nThird question?");
  });

  it("replaces its own draft that the site restored after a reload", () => {
    const z = load('<textarea id="box">What is a mutex?</textarea>'); // a fresh document: the helper remembers nothing
    const box = document.getElementById("box") as HTMLTextAreaElement;
    job += 1;
    z.begin({ job, service: "custom", text: "What is a semaphore?", previous: "What is a mutex?", force: false, images: [] });
    let s: Step = { done: false };
    for (let i = 0; i < 20 && !s.done; i++) s = z.step(job);
    expect(s.text).toBe("replace");
    expect(box.value).toBe("What is a semaphore?");
    box.value = "typed by the user";
    expect(run(z, "Another question?").text).toBe("append"); // unknown text is never overwritten
  });

  it("never types into a sign-in page", () => {
    const z = load('<form><input type="text" placeholder="Email" /><input type="password" /><textarea id="note"></textarea></form>');
    job += 1;
    z.begin({ job, service: "deepseek", text: "A question", force: false, images: [] });
    for (let i = 0; i < 5; i++) expect(z.step(job)).toMatchObject({ done: false, phase: "find", sign_in: true });
    expect((document.getElementById("note") as HTMLTextAreaElement).value).toBe("");
    expect((document.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("");
  });

  it("does not treat single-line inputs or read-only boxes as a message box", () => {
    const z = load('<input type="text" placeholder="Search chats" /><textarea readonly></textarea>');
    job += 1;
    z.begin({ job, service: "custom", text: "A question", force: false, images: [] });
    expect(z.step(job)).toMatchObject({ done: false, phase: "find" });
    expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
  });

  it("never clicks anything", () => {
    const z = load('<textarea></textarea><button id="send">Send</button>');
    let clicks = 0;
    document.getElementById("send")!.addEventListener("click", () => clicks++);
    document.addEventListener("submit", () => clicks++);
    run(z, "A question");
    expect(clicks).toBe(0);
    expect(INJECT).not.toMatch(/\.click\(|\.submit\(|requestSubmit|key(down|press|up)/i);
  });
});

// ------------------------------------------------------------------ the page helper and the resume
describe("page helper: the resume in a new chat", () => {
  type Step = { done: boolean; ok?: boolean; text?: string; context?: string | null; context_method?: string | null; context_confirmed?: boolean; inserted?: string };
  type Helper = { begin: (m: object) => boolean; step: (job: number) => Step };
  let job = 1000;

  // jsdom has no clipboard or drag events and no DataTransfer: plain stand-ins, as a browser shapes them.
  class FakeDataTransfer {
    files: File[] = [];
    items = { add: (f: File) => this.files.push(f) };
    private data: Record<string, string> = {};
    setData(t: string, v: string) {
      this.data[t] = v;
    }
    getData(t: string) {
      return this.data[t] ?? "";
    }
  }
  class FakeClipboardEvent extends Event {
    clipboardData: FakeDataTransfer | null;
    constructor(type: string, init: EventInit & { clipboardData?: FakeDataTransfer }) {
      super(type, init);
      this.clipboardData = init.clipboardData ?? null;
    }
  }
  class FakeDragEvent extends Event {
    dataTransfer: FakeDataTransfer | null;
    constructor(type: string, init: EventInit & { dataTransfer?: FakeDataTransfer }) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  Object.assign(globalThis, { DataTransfer: FakeDataTransfer, ClipboardEvent: FakeClipboardEvent, DragEvent: FakeDragEvent });

  const at = (path: string) => window.history.replaceState(null, "", path);

  function load(html: string): Helper {
    document.body.innerHTML = html;
    delete (window as unknown as { __zhu?: unknown }).__zhu;
    Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 600, left: 0, top: 600, right: 600, bottom: 640, width: 600, height: 40, toJSON: () => ({}) });
    new Function(INJECT)();
    return (window as unknown as { __zhu: Helper }).__zhu;
  }

  function run(z: Helper, text: string, context: object | null, previous = ""): Step {
    job += 1;
    z.begin({ job, service: "custom", text, previous, force: false, images: [], context });
    let s: Step = { done: false };
    for (let i = 0; i < 40 && !s.done; i++) s = z.step(job);
    return s;
  }

  const ctx = (mode: "file" | "text", force = false) => ({ ...CTX, mode, force, home: "/" });
  const asText = (q: string) => `${CTX.text}\n\n${CTX.question_heading}\n${q}`;

  /** A site whose file picker takes text files, and shows a chip with the name once one is chosen. */
  function siteWithPicker(): { z: Helper; box: HTMLTextAreaElement; picked: File[] } {
    const z = load('<textarea id="box"></textarea><input id="pick" type="file" accept="image/*,.pdf,.txt" />');
    const picked: File[] = [];
    const input = document.getElementById("pick") as HTMLInputElement;
    Object.defineProperty(input, "files", { set: (v: File[]) => picked.push(...v), get: () => picked });
    input.addEventListener("change", () => {
      const chip = document.createElement("div");
      chip.className = "attachment";
      chip.textContent = picked[picked.length - 1].name;
      document.body.appendChild(chip);
    });
    return { z, box: document.getElementById("box") as HTMLTextAreaElement, picked };
  }

  it("goes in the message above the first question of a new chat, and stays out of the chat once it is there", () => {
    at("/");
    const z = load('<main id="chat"></main><textarea id="box"></textarea>');
    const box = document.getElementById("box") as HTMLTextAreaElement;
    const first = run(z, "Tell me about yourself.", ctx("text"));
    expect(first).toMatchObject({ ok: true, text: "replace", context: "text", inserted: asText("Tell me about yourself.") });
    expect(box.value).toBe(asText("Tell me about yourself."));

    // Not sent yet: the next question replaces ZHU's draft, and the resume stays in it.
    expect(run(z, "What was your biggest project?", ctx("text"))).toMatchObject({ text: "replace", context: "already_there" });
    expect(box.value).toBe(asText("What was your biggest project?"));

    // Sent: the site moves to the conversation's address and shows the message.
    box.value = "";
    at("/c/7f3a");
    document.getElementById("chat")!.textContent = asText("What was your biggest project?");
    expect(run(z, "Why are you leaving?", ctx("text"))).toMatchObject({ text: "replace", context: "skipped" });
    expect(box.value).toBe("Why are you leaving?");

    // A new chat on the same page gets it again.
    box.value = "";
    at("/");
    document.getElementById("chat")!.textContent = "";
    expect(run(z, "What is a mutex?", ctx("text")).context).toBe("text");
  });

  it("is attached as a text file with a one-line note, through the page's own file picker", async () => {
    at("/");
    const { z, box, picked } = siteWithPicker();
    const s = run(z, "Tell me about yourself.", ctx("file"));
    expect(s).toMatchObject({ ok: true, context: "file", context_method: "file-input", context_confirmed: true });
    expect(box.value).toBe(`${CTX.note}\n\nTell me about yourself.`);
    expect(picked.map((f) => [f.name, f.type])).toEqual([["resume-zhu-1a2b3c4d.txt", "text/plain"]]);
    const read = await new Promise<string>((done) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.readAsText(picked[0]);
    });
    expect(read).toBe(CTX.text);

    // The next question in the same unsent draft: the note stays, no second file.
    expect(run(z, "Why this company?", ctx("file"))).toMatchObject({ context: "already_there", text: "replace" });
    expect(box.value).toBe(`${CTX.note}\n\nWhy this company?`);
    expect(picked).toHaveLength(1);
  });

  it("goes in the message where a site takes no files", () => {
    at("/");
    const z = load('<textarea id="box"></textarea>');
    const s = run(z, "Tell me about yourself.", ctx("file"));
    expect(s).toMatchObject({ ok: true, context: "text", context_method: "none" });
    expect((document.getElementById("box") as HTMLTextAreaElement).value).toBe(asText("Tell me about yourself."));
  });

  it("is left out of a chat under way, unless the user asks for it", () => {
    at("/c/91b2");
    const { z, box, picked } = siteWithPicker();
    expect(run(z, "What is CAP?", ctx("file"))).toMatchObject({ context: "skipped", text: "replace" });
    expect(box.value).toBe("What is CAP?");
    expect(picked).toHaveLength(0);

    // "Add resume": into this chat, with the note only (there is no question).
    box.value = "";
    expect(run(z, "", ctx("file", true))).toMatchObject({ ok: true, context: "file" });
    expect(box.value).toBe(CTX.note);
    expect(picked).toHaveLength(1);
  });

  it("is not added again where the page already shows it, or with another site's address", () => {
    at("/");
    const z = load(`<div class="message">${CTX.text}</div><textarea id="box"></textarea>`); // a site that stays at "/"
    expect(run(z, "Next question?", ctx("text")).context).toBe("skipped");
    const zz = load('<div aria-label="resume-zhu-1a2b3c4d.txt"></div><textarea id="box"></textarea>'); // a chip that names it in a label only
    expect(run(zz, "Next question?", ctx("file")).context).toBe("skipped");
    // A new chat of a site ZHU knows: Claude's /new.
    at("/new");
    const zc = load('<textarea id="box"></textarea>');
    job += 1;
    zc.begin({ job, service: "claude", text: "Q?", force: false, images: [], context: ctx("text") });
    let s: Step = { done: false };
    for (let i = 0; i < 40 && !s.done; i++) s = zc.step(job);
    expect(s.context).toBe("text");
    at("/");
  });

  it("does not change a question when no resume is offered", () => {
    at("/");
    const z = load('<textarea id="box"></textarea>');
    expect(run(z, "Plain question?", null)).toMatchObject({ text: "replace", context: null });
    expect((document.getElementById("box") as HTMLTextAreaElement).value).toBe("Plain question?");
  });
});
