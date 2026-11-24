/** The chats: the questions beside the chat tabs, and opening a Custom chat when a question needs one. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.fn();
vi.mock("@/services/webchatDelivery", () => ({
  sendQuestionToChats: (...a: unknown[]) => sent(...a),
  ensureTabLoaded: vi.fn(async () => false),
  sendScreenshotsToTab: vi.fn(),
}));
vi.mock("@/services/engine", () => ({
  api: {
    resumes: vi.fn(async () => ({ items: [], active_id: null, enabled: true, job: null, limits: { resume_chars: 24_000, job_chars: 12_000, resumes: 10 } })),
    clearQuestions: vi.fn(),
    clearTranscript: vi.fn(),
  },
}));

import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { useQuestions } from "@/app/state/questions";
import { TooltipProvider } from "@/components/primitives/Tooltip";
import { columnsFor } from "@/components/questions/QuestionsColumn";
import WebChatScreen from "@/features/webchat/WebChatScreen";
import { chatTabsOrCustom, openChatTab } from "@/features/webchat/tabs";
import type { Question } from "@/types/engine";

const question = (id: string, text: string, state: Question["state"] = "COMPLETE", at = 1_000) =>
  ({
    question_id: id, session_id: "s1", state, revision: 1, display_text: text, formatted_text: text,
    subquestions: [], category: "GENERAL", started_at_ms: at, needs_review: false, review_reasons: [], math_latex: null,
  }) as unknown as Question;

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <WebChatScreen />
      </TooltipProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  sent.mockClear();
  usePrefs.setState({ ...DEFAULT_PREFS, webChatTabs: [{ id: "chatgpt-1", service: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" }], webChatActive: "chatgpt-1" });
  useQuestions.setState({ byId: { q1: question("q1", "What is a mutex?"), q2: question("q2", "And a semaphore", "QUESTION_IN_PROGRESS", 2_000) } });
});
afterEach(cleanup);

describe("the questions beside the chat", () => {
  it("shows the questions next to the chat tabs, and sends one to the chats from its card", () => {
    show();
    const pane = screen.getByRole("region", { name: "Questions" });
    expect(screen.getByRole("tablist", { name: "Chat tabs" })).toBeTruthy();
    const card = within(pane).getByRole("article", { name: "Question: What is a mutex?" });
    fireEvent.click(within(card).getByRole("button", { name: "Send to chat" }));
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ question_id: "q1" }));
    expect(screen.getByRole("separator", { name: "Width of the questions" })).toBeTruthy();
    // No strip under the tabs: the site's page starts right below them.
    for (const name of [/^Back$/, /^Reload$/, /Add resume/, /Send latest question/, /Open this page in your browser/]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("collapses to a button before the tabs, keeps the chat in place, and opens again", () => {
    show();
    const chatArea = screen.getByRole("tablist").parentElement!.parentElement!;
    fireEvent.click(screen.getByRole("button", { name: "Collapse the questions" }));
    expect(usePrefs.getState().questionsCollapsed).toBe(true);
    expect(screen.queryByRole("region", { name: "Questions" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Width of the questions" })).toBeNull();
    // The same element: the website's page is placed over it, and the built-in chat lives in it.
    expect(screen.getByRole("tablist").parentElement!.parentElement).toBe(chatArea);

    const strip = screen.getByRole("tablist").parentElement!;
    const open = within(strip).getByRole("button", { name: "Show the questions (2 questions, one being asked)" });
    expect(open.textContent).toBe("Questions2");
    fireEvent.click(open);
    expect(usePrefs.getState().questionsCollapsed).toBe(false);
    expect(screen.getByRole("region", { name: "Questions" })).toBeTruthy();
    expect(screen.getByRole("tablist").parentElement!.parentElement).toBe(chatArea);
  });

  it("leaves no empty space beside the chats, whatever width is saved", () => {
    // The questions are kept between their minimum and what leaves the chats theirs; the chats
    // take all the rest (shares in fr left a gap once one side sat at its minimum).
    expect(columnsFor(0.2)).toBe("clamp(min(300px, 50%), 20%, calc(100% - min(300px, 50%))) auto minmax(0, 1fr)");
    expect(columnsFor(1 / 3)).toContain(" 33.33%,");
    show();
    const row = screen.getByRole("separator", { name: "Width of the questions" }).parentElement!;
    expect(row.style.gridTemplateColumns).toBe(columnsFor(0.4));
    fireEvent.click(screen.getByRole("button", { name: "Collapse the questions" }));
    expect(row.style.gridTemplateColumns).toBe(""); // collapsed: the chats alone
  });

  it("keeps its width and the transcript switch for the next time", () => {
    const first = show();
    fireEvent.keyDown(screen.getByRole("separator", { name: "Width of the questions" }), { key: "End" });
    expect(usePrefs.getState().questionsSplit).toBeCloseTo(0.6); // the widest it goes
    fireEvent.click(within(screen.getByRole("region", { name: "Questions" })).getByRole("button", { name: "Hide transcript" }));
    first.unmount();
    show();
    expect(screen.getByRole("separator", { name: "Width of the questions" }).getAttribute("aria-valuenow")).toBe("60");
    expect(within(screen.getByRole("region", { name: "Questions" })).getByRole("button", { name: "Show transcript" })).toBeTruthy();
  });
});

describe("chat tabs for a question", () => {
  it("open a Custom chat when there is none, and use the tabs that are there otherwise", () => {
    usePrefs.setState({ webChatTabs: [], webChatActive: null });
    const [made] = chatTabsOrCustom();
    expect(made).toMatchObject({ service: "zhu", name: "Custom chat" });
    expect(usePrefs.getState().webChatActive).toBe(made.id);
    expect(chatTabsOrCustom()).toEqual([made]); // not a second one
    const second = openChatTab({ id: "zhu", name: "Custom chat", url: "about:blank" });
    expect(second.name).toBe("Custom chat 2");
    expect(usePrefs.getState().webChatTabs.map((t) => t.name)).toEqual(["Custom chat", "Custom chat 2"]);
  });
});
