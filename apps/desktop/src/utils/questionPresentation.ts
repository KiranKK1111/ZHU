import type { Question, QuestionCategory } from "@/types/engine";
import { titleCase } from "./format";

const CATEGORY_LABELS: Partial<Record<QuestionCategory, string>> = {
  SPRING_BOOT: "Spring Boot",
  JAVASCRIPT: "JavaScript",
  TYPESCRIPT: "TypeScript",
  NODEJS: "Node.js",
  CSHARP: "C#",
  CPP: "C++",
  SQL: "SQL",
  DATA_STRUCTURES: "Data structures",
  SYSTEM_DESIGN: "System design",
  DEVOPS: "DevOps",
};

export function categoryLabel(c: QuestionCategory): string {
  return CATEGORY_LABELS[c] ?? titleCase(c);
}

export function isOpen(q: Pick<Question, "state">): boolean {
  return q.state === "CANDIDATE" || q.state === "QUESTION_IN_PROGRESS" || q.state === "AWAITING_COMPLETION";
}

/** The text a user copies or adds to the composer: the resolved text when present. */
export function questionCopyText(q: Pick<Question, "display_text" | "subquestions">, includeSubquestions = false): string {
  if (!includeSubquestions || !q.subquestions.length) return q.display_text;
  return `${q.display_text}\n\n${q.subquestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
}
