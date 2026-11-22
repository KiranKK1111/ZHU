import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliver = vi.fn(async (..._args: unknown[]) => ({ done: true, ok: true, text: "replace", images: 0 }));
const open = vi.fn(async (..._args: unknown[]) => false);
const opened: string[] = [];
vi.mock("@/services/shell", () => ({
  inTauri: true,
  shell: { webchatOpen: (...a: unknown[]) => open(...a), webchatDeliver: (...a: unknown[]) => deliver(...a) },
  broadcast: async () => undefined,
  copyText: async () => undefined,
  openExternal: async (url: string) => void opened.push(url),
}));

import { useChat } from "@/app/state/chat";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { useWebChat } from "@/app/state/webchat";
import { prepareMarkdown, splitThinking } from "@/features/chat/chatText";
import { Markdown } from "@/features/chat/Markdown";
import { inputKinds } from "@/features/chat/ModelInputs";
import { chatModelGroups, describeConnection, filterGroups, imageAlternative, imageSupportKnown, readsImages, resolveChatModel, usableForChat } from "@/features/chat/models";
import { isNativeChat, NATIVE_CHAT } from "@/features/webchat/services";
import { onQuestionEvent, onScreenshotEvent } from "@/services/webchatDelivery";
import type { ChatMessage, ProviderInfo, Question } from "@/types/engine";

const flush = () => new Promise((r) => setTimeout(r, 0));

function provider(id: string, patch: Partial<ProviderInfo> & { known?: string[]; free?: string[]; basis?: ProviderInfo["config"]["free_basis"] } = {}): ProviderInfo {
  const { known = [], free = [], basis = null, ...rest } = patch;
  return {
    id, name: id.toUpperCase(), status: "ready", model: known[0] ?? null, has_api_key: true, key_required: true, free_tier: false, user_defined: false,
    config: { known_models: known, free_models: free, free_basis: basis },
    ...rest,
  } as unknown as ProviderInfo;
}

function message(seq: number, role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "completed"): ChatMessage {
  return { seq, id: `m${seq}`, conversation_id: "c1", role, content, provider_id: role === "assistant" ? "groq" : null, model: role === "assistant" ? "llama" : null, status, error: null, usage: null, screenshot_ids: [], created_at: seq, completed_at: null };
}

// ------------------------------------------------------------------ models
describe("models that read screenshots", () => {
  const gateway = provider("kilo", { known: ["see/vl:free", "text/only:free", "see/paid"], free: ["see/vl:free", "text/only:free"], basis: "listed", default_images: false });
  gateway.config.image_models = ["see/vl:free", "see/paid"];
  gateway.config.images = true; // "Allow images" was pressed earlier
  const plain = provider("groq", { known: ["llama"], default_images: false });
  const option = (model: string, free: boolean) => ({ providerId: "kilo", providerName: "KILO", model, label: model, free, inputs: null });

  it("knows what each model takes from the provider's list, and filters by it", () => {
    const listed = provider("openrouter", { known: ["a/vision", "b/text", "c/all"], default_images: false });
    listed.config.model_inputs = { "a/vision": ["image"], "b/text": [], "c/all": ["image", "file", "audio"] };
    const groups = chatModelGroups([listed, plain], false);
    const models = (kind: string | null) => filterGroups(groups, "", kind).flatMap((g) => g.options.map((o) => o.model));
    expect(groups[0]!.options.map((o) => o.inputs)).toEqual([["image"], [], ["image", "file", "audio"]]);
    expect(models("image")).toEqual(["a/vision", "c/all"]);
    expect(models("file")).toEqual(["c/all"]);
    expect(models("text")).toEqual(["b/text"]);
    expect(models(null)).toEqual(["a/vision", "b/text", "c/all", "llama"]);
    // A provider that does not say: no icons, and its switch decides about screenshots.
    expect(groups[1]!.options[0]!.inputs).toBeNull();
    expect(readsImages(listed, "b/text")).toBe(false);
    expect(readsImages(listed, "c/all")).toBe(true);
    expect(inputKinds(["video", "image"])).toEqual(["image", "video"]);
    expect(inputKinds([])).toEqual(["text"]);
    expect(inputKinds(null)).toEqual([]);
  });

  it("follows the provider's model list where it says, and the provider's switch elsewhere", () => {
    expect(readsImages(gateway, "see/vl:free")).toBe(true);
    expect(readsImages(gateway, "text/only:free")).toBe(false);
    expect(imageSupportKnown(gateway, "text/only:free")).toBe(true);
    expect(readsImages(gateway, "not/listed")).toBe(true);
    expect(imageSupportKnown(plain, "llama")).toBe(false);
    expect(readsImages(plain, "llama")).toBe(false);
    expect(readsImages({ ...plain, config: { ...plain.config, images: true } }, "llama")).toBe(true);
  });

  it("suggests a model that reads images, and never a paid one in place of a free one", () => {
    expect(imageAlternative([gateway, plain], option("text/only:free", true))?.model).toBe("see/vl:free");
    const paidOnly = { ...gateway, config: { ...gateway.config, image_models: ["see/paid"] } };
    expect(imageAlternative([paidOnly], option("text/only:free", true))).toBeNull();
    expect(imageAlternative([paidOnly], option("text/only:free", false))?.model).toBe("see/paid");
  });
});

describe("models offered in the chat", () => {
  const providers = [
    provider("chatgpt", { known: ["gpt-9", "gpt-9-mini"], basis: "unknown" }),
    provider("openrouter", { free_tier: true, known: ["a/one:free", "b/two:free", "c/paid"], free: ["a/one:free", "b/two:free"], basis: "listed", model: "b/two:free" }),
    provider("groq", { free_tier: true, known: ["models/llama-4"], free: ["models/llama-4"], basis: "free_tier" }),
    provider("gemini", { status: "not_configured", has_api_key: false, free_tier: true }),
    provider("custom-11111111", { user_defined: true, key_required: false, has_api_key: false, known: ["qwen3"], free: ["qwen3"], basis: "local" }),
    provider("kilo", { status: "needs_model", key_required: false, has_api_key: false, free_tier: true }), // keyless, but not connected yet
    provider("claude", { status: "disabled", known: ["claude-x"] }),
  ];

  it("lists only what can be called, free providers first", () => {
    expect(providers.filter(usableForChat).map((p) => p.id)).toEqual(["chatgpt", "openrouter", "groq", "custom-11111111"]);
    const all = chatModelGroups(providers, false);
    expect(all.map((g) => g.provider.id)).toEqual(["openrouter", "groq", "custom-11111111", "chatgpt"]);
    expect(all.map((g) => g.freeNote)).toEqual(["2 free models", "Free tier", "Runs on your computer", null]);
    expect(all[0].options.map((o) => [o.model, o.free])).toEqual([["a/one:free", true], ["b/two:free", true], ["c/paid", false]]);
    expect(all[1].options[0].label).toBe("llama-4"); // Google-style "models/" prefix is not shown
  });

  it("shows only free models when asked to", () => {
    const free = chatModelGroups(providers, true);
    expect(free.map((g) => g.provider.id)).toEqual(["openrouter", "groq", "custom-11111111"]);
    expect(free.flatMap((g) => g.options).every((o) => o.free)).toBe(true);
    expect(filterGroups(free, "TWO").flatMap((g) => g.options.map((o) => o.model))).toEqual(["b/two:free"]);
    expect(filterGroups(free, "groq llama").map((g) => g.provider.id)).toEqual(["groq"]); // provider names match too
    expect(filterGroups(free, "nothing-like-this")).toEqual([]);
  });

  it("starts on a free model and keeps the user's choice while it exists", () => {
    // No choice yet: a free model, and the one the provider has selected rather than merely its first.
    expect(resolveChatModel(providers, null)).toMatchObject({ providerId: "openrouter", model: "b/two:free", free: true });
    expect(resolveChatModel(providers, { providerId: "chatgpt", model: "gpt-9-mini" })).toMatchObject({ providerId: "chatgpt", model: "gpt-9-mini", free: false });
    // The chosen model disappeared from the provider's list: fall back to a free one, never silently to a paid one.
    expect(resolveChatModel(providers, { providerId: "openrouter", model: "gone:free" })).toMatchObject({ model: "b/two:free" });
    // Only a paid provider is connected: it is still offered, so the chat is usable.
    expect(resolveChatModel([providers[0]], null)).toMatchObject({ providerId: "chatgpt", model: "gpt-9", free: false });
    expect(resolveChatModel([providers[3], providers[5]], null)).toBeNull();
  });

  it("says what was found after connecting a provider", () => {
    expect(describeConnection("Gateway", 40, 6, "listed").detail).toBe("40 models found, 6 of them free.");
    expect(describeConnection("Gateway", 3, 0, "listed").detail).toBe("3 models found. None of them is free.");
    expect(describeConnection("Ollama", 1, 1, "local").detail).toMatch(/^1 model found\. They run on your computer/);
    expect(describeConnection("Groq", 12, 12, "free_tier").detail).toMatch(/free tier/);
    expect(describeConnection("Acme", 5, 0, "unknown").detail).toMatch(/cannot tell which are free/);
  });
});

// ------------------------------------------------------------------ text
describe("answer text", () => {
  it("turns every LaTeX delimiter into the one the renderer reads", () => {
    expect(prepareMarkdown("Euler: \\(e^{i\\pi} + 1 = 0\\).")).toBe("Euler: $e^{i\\pi} + 1 = 0$.");
    expect(prepareMarkdown("So \\[ x = \\frac{1}{2} \\] holds")).toBe("So \n$$\nx = \\frac{1}{2}\n$$\n holds");
  });

  it("keeps prices from being set as formulas, and real formulas intact", () => {
    expect(prepareMarkdown("It costs $5 and $10.50, or $3k (about $1,200).")).toBe("It costs \\$5 and \\$10.50, or \\$3k (about \\$1,200).");
    expect(prepareMarkdown("Then $2x + 3$ and $x$ and $5$.")).toBe("Then $2x + 3$ and $x$ and $5$.");
    expect(prepareMarkdown("So $3 + 4 = 7$, clearly.")).toBe("So $3 + 4 = 7$, clearly.");
    // Seen in a real answer: ranges, and an amount in a sentence that also has a formula.
    expect(prepareMarkdown("from $10k–$100k+ down to $1–$5 per chip")).toBe("from \\$10k–\\$100k+ down to \\$1–\\$5 per chip");
    expect(prepareMarkdown("It costs $5. Let $x$ be the price, and $0.15/$0.50 the rates.")).toBe("It costs \\$5. Let $x$ be the price, and \\$0.15/\\$0.50 the rates.");
    expect(prepareMarkdown("Pay $5 for one and two for $9$")).toBe("Pay \\$5 for one and two for $9$"); // prose is never a formula
    expect(prepareMarkdown("already \\$5 and $$\nE = mc^2\n$$")).toBe("already \\$5 and $$\nE = mc^2\n$$");
  });

  it("never touches code", () => {
    const code = "Run `echo $5 \\(x\\)` then\n```sh\necho $1 \\[a\\]\n```\nfor $7 more";
    expect(prepareMarkdown(code)).toBe("Run `echo $5 \\(x\\)` then\n```sh\necho $1 \\[a\\]\n```\nfor \\$7 more");
    expect(prepareMarkdown("```py\nprice = $5 \\(still streaming")).toBe("```py\nprice = $5 \\(still streaming"); // an unfinished fence
  });

  it("separates a reasoning model's thinking from its answer", () => {
    expect(splitThinking("Plain answer")).toEqual({ thinking: null, open: false, answer: "Plain answer" });
    expect(splitThinking("<think>step one")).toEqual({ thinking: "step one", open: true, answer: "" });
    expect(splitThinking("\n<think>\nstep one\n</think>\n\nThe answer is 4.")).toEqual({ thinking: "step one", open: false, answer: "The answer is 4." });
    expect(splitThinking("Use the <think> tag like this")).toMatchObject({ thinking: null }); // only a leading block counts
  });
});

describe("rendered answers", () => {
  it("renders Markdown, code with a copy button, tables and formulas", () => {
    const { container } = render(<Markdown text={"# Title\n\nSome **bold** and `inline`.\n\n```python\nprint('hi')\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nMass: $E = mc^2$"} />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector(".zhu-md-code-bar span")?.textContent).toBe("python");
    expect(container.querySelector(".zhu-md-code button")?.getAttribute("aria-label")).toBe("Copy code");
    expect(container.querySelector("pre code")?.textContent).toBe("print('hi')\n");
    expect(container.querySelector("pre code .hljs-string")).toBeTruthy(); // highlighted
    expect(container.querySelectorAll("td").length).toBe(2);
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("breaks lines where a model wrote <br>, as they do inside table cells", () => {
    const text = ["| Step | What |", "|---|---|", "| Migrate | 1. Find a context.<br>2. Build the service.<BR/>3. Route traffic. |", "", "Done<br>here, but `<br>` in code stays."].join("\n");
    const { container } = render(<Markdown text={text} />);
    const cell = container.querySelectorAll("td")[1];
    expect(cell.querySelectorAll("br").length).toBe(2);
    expect(cell.textContent?.split("\n")).toEqual(["1. Find a context.", "2. Build the service.", "3. Route traffic."]);
    expect(container.querySelector("p br")).toBeTruthy();
    expect(container.querySelector("p code")?.textContent).toBe("<br>");
    expect(container.textContent).not.toContain("<br>2.");
  });

  it("treats the model's text as text: no HTML, no remote images, links open outside the app", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> <script>alert(1)</script>\n\n![chart](https://tracker.example/pixel.png)\n\n[docs](https://example.com/docs)'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("[image: chart");
    const link = container.querySelector("a") as HTMLAnchorElement;
    link.click();
    expect(opened).toEqual(["https://example.com/docs"]);
  });
});

// ------------------------------------------------------------------ store
describe("chat store", () => {
  beforeEach(() => useChat.setState({ messages: {}, streaming: {}, sending: {}, joinedLate: {}, early: {}, drafts: {}, unread: {}, attachments: {} }));

  it("streams an answer into the conversation and ends it", () => {
    const chat = useChat.getState();
    chat.load("c1", [], null);
    chat.beginSend("c1");
    chat.appendTurn("c1", message(1, "user", "Hi"), message(2, "assistant", "", "streaming"), "r1");
    expect(useChat.getState().streaming).toEqual({ c1: "r1" });
    expect(useChat.getState().sending).toEqual({});
    chat.delta("c1", "m2", "Hel");
    chat.delta("c1", "m2", "lo");
    chat.finish("c1", "m2", { status: "completed", model: "llama-4" });
    const [user, answer] = useChat.getState().messages.c1;
    expect(user.content).toBe("Hi");
    expect(answer).toMatchObject({ content: "Hello", status: "completed", model: "llama-4", error: null });
    expect(useChat.getState().streaming).toEqual({});
  });

  it("keeps text that arrives before the send request returns", () => {
    const chat = useChat.getState();
    chat.load("c1", [], null);
    chat.beginSend("c1");
    chat.delta("c1", "m2", "Fast ");
    chat.delta("c1", "m2", "answer");
    chat.finish("c1", "m2", { status: "failed", error: { kind: "rate_limited", message: "Slow down", retry_after_s: 5, status: 429 } });
    chat.appendTurn("c1", message(1, "user", "Hi"), message(2, "assistant", "", "streaming"), "r1");
    const answer = useChat.getState().messages.c1[1];
    expect(answer).toMatchObject({ content: "Fast answer", status: "failed" });
    expect(answer.error?.kind).toBe("rate_limited");
    expect(useChat.getState().streaming).toEqual({}); // it already ended
    expect(useChat.getState().early).toEqual({});
  });

  it("ignores events for conversations that are not open, and replaces the answer when asked again", () => {
    const chat = useChat.getState();
    chat.delta("other", "mx", "text"); // not loaded, nothing in flight
    expect(useChat.getState().early).toEqual({});
    chat.load("c1", [message(1, "user", "Q1"), message(2, "assistant", "A1"), message(3, "user", "Q2"), message(4, "assistant", "A2 old")], null);
    chat.beginSend("c1");
    chat.appendTurn("c1", message(3, "user", "Q2"), message(5, "assistant", "", "streaming"), "r2");
    expect(useChat.getState().messages.c1.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m5"]);
    chat.finish("c1", "m5", { status: "cancelled" });
    expect(useChat.getState().messages.c1[3]).toMatchObject({ status: "cancelled", error: null });
  });

  it("puts a question into a tab's message box below what is being typed, once", () => {
    const chat = useChat.getState();
    chat.offerDraft("t1", "What is a mutex?", true);
    expect(useChat.getState().drafts.t1).toBe("What is a mutex?");
    expect(useChat.getState().unread).toEqual({});
    chat.setDraft("t1", "My own note  ");
    chat.offerDraft("t1", "What is a mutex?", false);
    expect(useChat.getState().drafts.t1).toBe("My own note\n\nWhat is a mutex?");
    expect(useChat.getState().unread).toEqual({ t1: true });
    chat.offerDraft("t1", "What is a mutex?", false); // already there
    expect(useChat.getState().drafts.t1).toBe("My own note\n\nWhat is a mutex?");
    chat.closeTab("t1");
    expect(useChat.getState().drafts).toEqual({});
  });
});

// ------------------------------------------------------------------ questions reach the built-in chat
describe("detected questions and the built-in chat tab", () => {
  const web = { id: "chatgpt-00000001", service: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" };
  const own = { id: "zhu-00000002", service: NATIVE_CHAT.id, name: NATIVE_CHAT.name, url: NATIVE_CHAT.url };
  const question = (id: string, text: string) => ({ question_id: id, session_id: "s1", state: "COMPLETE", revision: 1, display_text: text, formatted_text: text, subquestions: [] }) as unknown as Question;

  beforeEach(() => {
    deliver.mockClear();
    open.mockClear();
    usePrefs.setState({ ...DEFAULT_PREFS, webChatTabs: [web, own], webChatActive: web.id });
    useWebChat.setState({ tabs: {}, onScreen: null, nativeOnScreen: false });
    useChat.setState({ drafts: {}, unread: {}, attachments: {} });
    useSession.setState({ listening: { state: "listening" } as never });
  });

  it("goes into the chat's message box without opening a web page for it", async () => {
    expect(isNativeChat(own)).toBe(true);
    expect(isNativeChat(web)).toBe(false);
    onQuestionEvent(question("n1", "What is a deadlock?"), false);
    await flush();
    await flush();
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([web.id]);
    expect(open.mock.calls.map((c) => c[0])).toEqual([web.id]); // no webview is ever created for the built-in chat
    expect(useChat.getState().drafts[own.id]).toBe("What is a deadlock?");
    expect(useChat.getState().unread).toEqual({ [own.id]: true });
  });

  it("is not marked unread when that tab is on screen, and a new screenshot is attached to its message box", async () => {
    usePrefs.setState({ webChatTabs: [own], webChatActive: own.id });
    useWebChat.setState({ nativeOnScreen: true });
    onQuestionEvent(question("n2", "What is a livelock?"), false);
    onScreenshotEvent({ id: "shot-1" });
    await flush();
    await flush();
    expect(useChat.getState().drafts[own.id]).toBe("What is a livelock?");
    expect(useChat.getState().attachments[own.id]).toEqual(["shot-1"]);
    expect(useChat.getState().unread).toEqual({});
    expect(deliver).not.toHaveBeenCalled(); // no image is read or sent anywhere for the built-in chat
    expect(open).not.toHaveBeenCalled();
  });
});
