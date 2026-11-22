import { beforeEach, describe, expect, it, vi } from "vitest";

const submit = vi.fn(async (..._a: unknown[]) => ({ request_id: "r1", interaction_id: "i1", model: "m" }));
const listProviders = vi.fn(async () => providers);
vi.mock("@/services/engine", () => ({ api: { submitPrompt: (...a: unknown[]) => submit(...a), providers: () => listProviders() } }));
vi.mock("@/services/shell", () => ({ inTauri: true, shell: {}, broadcast: async () => undefined }));

import { useComposer } from "@/app/state/composer";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { useNav } from "@/app/state/ui";
import { modelLabel, pickAnswerModel } from "@/hooks/useProviders";
import { ask, onQuestionForAutoAnswer } from "@/services/ask";
import type { ProviderInfo, Question } from "@/types/engine";

function provider(id: string, status: ProviderInfo["status"], images = false): ProviderInfo {
  return { id, name: id.toUpperCase(), status, model: status === "ready" ? `models/${id}-1` : null, capabilities: { images } } as unknown as ProviderInfo;
}
let providers: ProviderInfo[] = [];
const question = (id: string, state: Question["state"] = "COMPLETE") => ({ question_id: id, state, display_text: `Question ${id}?`, subquestions: [] }) as unknown as Question;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  submit.mockClear();
  providers = [provider("gemini", "not_configured"), provider("groq", "ready"), provider("openrouter", "ready", true)];
  usePrefs.setState({ ...DEFAULT_PREFS });
  useComposer.setState({ draft: "", attachments: [], responses: {}, responseOrder: [] });
  useSession.setState({ currentSessionId: "s1", listening: { state: "listening" } as never });
  useNav.setState({ route: "home" });
});

describe("choosing the model that answers", () => {
  it("uses the chosen model when it is connected, otherwise the first connected one", () => {
    expect(pickAnswerModel(providers, null)?.id).toBe("groq");
    expect(pickAnswerModel(providers, "openrouter")?.id).toBe("openrouter");
    expect(pickAnswerModel(providers, "gemini")?.id).toBe("groq"); // chosen, but its key was removed
    expect(pickAnswerModel([provider("gemini", "needs_model")], null)).toBeNull();
    expect(modelLabel(providers[1])).toBe("GROQ · groq-1"); // Google's "models/" prefix is not shown
  });
});

describe("asking", () => {
  it("sends the question with the session and the user's answer instructions", async () => {
    usePrefs.setState({ instructions: " Answer briefly. " });
    expect(await ask("  What is CAP?  ")).toBe(true);
    expect(submit).toHaveBeenCalledWith("groq", { session_id: "s1", prompt: "What is CAP?", screenshot_ids: [], system: "Answer briefly." });
    expect(Object.values(useComposer.getState().responses)[0]).toMatchObject({ providerId: "groq", prompt: "What is CAP?", status: "streaming" });
  });

  it("attaches screenshots only for models that read images", async () => {
    await ask("Look at this", { screenshotIds: ["shot1"] });
    expect((submit.mock.calls[0][1] as { screenshot_ids: string[] }).screenshot_ids).toEqual([]);
    usePrefs.setState({ answerProvider: "openrouter" });
    await ask("Look at this", { screenshotIds: ["shot1"] });
    expect(submit.mock.calls[1]).toEqual(["openrouter", { session_id: "s1", prompt: "Look at this", screenshot_ids: ["shot1"], system: null }]);
  });

  it("with no model connected, sends nothing and opens Settings", async () => {
    providers = [provider("gemini", "not_configured")];
    expect(await ask("What is CAP?")).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(useNav.getState().route).toBe("settings");
    useNav.setState({ route: "home" });
    expect(await ask("What is CAP?", { quiet: true })).toBe(false); // automatic asks never move the user
    expect(useNav.getState().route).toBe("home");
  });
});

describe("auto-answer", () => {
  it("is off by default", async () => {
    onQuestionForAutoAnswer(question("a1"));
    await flush();
    expect(submit).not.toHaveBeenCalled();
  });

  it("asks once per question, only while listening", async () => {
    usePrefs.setState({ autoAnswer: true });
    useSession.setState({ listening: { state: "idle" } as never });
    onQuestionForAutoAnswer(question("b1")); // a replayed or historical event
    useSession.setState({ listening: { state: "listening" } as never });
    onQuestionForAutoAnswer(question("b2", "DISCARDED"));
    onQuestionForAutoAnswer(question("b3"));
    onQuestionForAutoAnswer(question("b3")); // the same question again
    await flush();
    await flush();
    expect(submit.mock.calls.map((c) => (c[1] as { prompt: string }).prompt)).toEqual(["Question b3?"]);
  });
});

describe("preferences", () => {
  it("keeps only known, well-typed settings from older versions or other windows", () => {
    usePrefs.getState().applyRemote({ theme: "light", density: "compact", fontScale: 1.2, autoAnswer: "yes", answerProvider: "groq", webChatTabs: "oops" } as never);
    const s = usePrefs.getState() as unknown as Record<string, unknown>;
    expect(s.theme).toBe("light");
    expect(s.answerProvider).toBe("groq");
    expect(s.autoAnswer).toBe(false); // wrong type: the default is kept
    expect(s.webChatTabs).toEqual([]);
    expect("density" in s || "fontScale" in s).toBe(false);
  });
});
