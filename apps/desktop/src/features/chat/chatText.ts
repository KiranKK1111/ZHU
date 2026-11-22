/**
 * Text preparation for chat answers before they are rendered as Markdown. All pure.
 *
 * Models disagree on how to write mathematics and reasoning, so three things are normalized:
 * LaTeX delimiters, dollar amounts that would be mistaken for mathematics, and a leading
 * <think> block.
 */

/** A fenced block, an unfinished fence at the end (while streaming), or an inline code span. */
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

/** Two plain words in a row: prose, not a formula. */
const PROSE = /[a-zA-Z]{2,}\s+[a-zA-Z]{2,}/;

function outsideCode(text: string, change: (part: string) => string): string {
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : change(part)))
    .join("");
}

/**
 * Where the formula whose body starts at `from` closes, or -1 when what follows is not a formula.
 * A closing dollar sign has no space before it and no digit after it (so the second sign in
 * "$5 and $10" closes nothing), and a formula holds no running prose.
 */
function formulaEnd(line: string, from: number): number {
  let j = line.indexOf("$", from);
  while (j > 0 && line[j - 1] === "\\") j = line.indexOf("$", j + 1);
  if (j < 0 || /\s/.test(line[j - 1]) || /\d/.test(line[j + 1] ?? "")) return -1;
  const body = line.slice(from, j);
  return PROSE.test(body) && !body.includes("\\") ? -1 : j;
}

/**
 * Escape the dollar signs that are money ("$5", "$10k–$100k", "$1,200") so they are not read as
 * the start of a formula, and leave real formulas ("$2x + 3$", "$5$") alone.
 */
function escapeMoney(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i += 2;
    } else if (ch !== "$") {
      out += ch;
      i += 1;
    } else if (line[i + 1] === "$") {
      out += "$$"; // display mathematics
      i += 2;
    } else if (/\d/.test(line[i + 1] ?? "")) {
      const end = formulaEnd(line, i + 1);
      out += end < 0 ? "\\$" : line.slice(i, end + 1);
      i = end < 0 ? i + 1 : end + 1;
    } else {
      // A formula that starts with a letter or symbol: copy it whole, so its closing sign is not read as an opening one.
      const end = line.indexOf("$", i + 1);
      out += end < 0 ? line.slice(i) : line.slice(i, end + 1);
      i = end < 0 ? line.length : end + 1;
    }
  }
  return out;
}

/**
 * Make an answer safe to hand to the Markdown renderer:
 * `\( x \)` and `\[ x \]` become `$x$` and `$$x$$` (the only forms the renderer reads), and a
 * dollar sign in front of an amount is escaped so "$5 and $10" is not set as a formula.
 * Code is left alone.
 */
export function prepareMarkdown(text: string): string {
  return outsideCode(text, (part) =>
    part
      .split("\n")
      .map((line) => (line.includes("$") ? escapeMoney(line) : line))
      .join("\n")
      .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`),
  );
}

export interface Thinking {
  /** The model's reasoning, when the answer starts with a <think> block. */
  thinking: string | null;
  /** True while the block is still open (the model is still reasoning). */
  open: boolean;
  answer: string;
}

/** Reasoning models write their thinking first, inside <think>…</think>; it is shown folded away. */
export function splitThinking(text: string): Thinking {
  const start = /^\s*<think(?:ing)?>/i.exec(text);
  if (!start) return { thinking: null, open: false, answer: text };
  const rest = text.slice(start[0].length);
  const end = /<\/think(?:ing)?>/i.exec(rest);
  if (!end) return { thinking: rest.trim(), open: true, answer: "" };
  return { thinking: rest.slice(0, end.index).trim(), open: false, answer: rest.slice(end.index + end[0].length).replace(/^\s+/, "") };
}
