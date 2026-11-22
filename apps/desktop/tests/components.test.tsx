import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const asked = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/services/ask", () => ({ askQuestion: (...a: unknown[]) => asked(...a), bindQueryClient: () => undefined }));

import { TooltipProvider } from "@/components/primitives/Tooltip";
import { QuestionCard } from "@/components/questions/QuestionCard";
import { QuestionText } from "@/components/questions/QuestionText";
import type { Question } from "@/types/engine";

function question(patch: Partial<Question>): Question {
  return {
    question_id: "q1", session_id: "s1", state: "COMPLETE", revision: 1, display_text: "What is a mutex?", formatted_text: "What is a mutex?",
    subquestions: [], category: "GENERAL", started_at_ms: 65_000, needs_review: false, review_reasons: [], math_latex: null, ...patch,
  } as Question;
}
const show = (q: Question) => render(<TooltipProvider><QuestionCard question={q} /></TooltipProvider>);

describe("question card", () => {
  it("shows the question and asks the model with one button", () => {
    const q = question({});
    show(q);
    expect(screen.getByText("What is a mutex?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(asked).toHaveBeenCalledWith(q);
  });

  it("says in words when a question is still being spoken or needs a second look", () => {
    const { unmount } = show(question({ state: "QUESTION_IN_PROGRESS" }));
    expect(screen.getByText("Still listening…")).toBeTruthy();
    unmount();
    show(question({ needs_review: true, review_reasons: ["low confidence"] }));
    expect(screen.getByText("Check wording")).toBeTruthy();
  });

  it("renders backtick spans as selectable code", () => {
    const { container } = render(<QuestionText text="Write `SELECT 1` please" />);
    expect(container.querySelector("code")?.textContent).toBe("SELECT 1");
    expect(container.querySelector("p")?.className).toContain("selectable");
  });
});
