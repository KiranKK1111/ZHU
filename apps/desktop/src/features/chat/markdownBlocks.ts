/**
 * Streaming Markdown, cheaply and without flicker. All pure.
 *
 * `splitBlocks` cuts an answer into top-level blocks (paragraphs, headings, lists, tables, code,
 * formulas) at blank lines, so each block is rendered on its own: while an answer is written only
 * its last block changes, and the finished ones (with their highlighted code and typeset
 * formulas) are not parsed again. It cuts only where rendering the pieces separately gives the
 * same result as rendering the whole: never inside a code fence or a `$$` formula, never between
 * the items of one list or before an indented continuation, and not at all when the text defines
 * link references or footnotes (which may be used in another block).
 *
 * `closeOpenMarkdown` tidies the block that is still being written, so half-typed syntax does
 * not flash on screen: an opened `**` or `` ` `` is closed, a link shows its text until its
 * address is complete, and a formula or table appears once it can be drawn.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const REFERENCE = /^ {0,3}\[[^\]\n]+\]:/m;

export function splitBlocks(md: string): string[] {
  if (REFERENCE.test(md)) return [md];
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  let math = false;
  let blankBefore = false;
  let isList = false;
  const flush = () => {
    while (cur.length && !cur[cur.length - 1].trim()) cur.pop();
    if (cur.length) blocks.push(cur.join("\n"));
    cur = [];
  };
  for (const line of md.split("\n")) {
    if (fence) {
      cur.push(line);
      if (line.trim().startsWith(fence) && line.trim().replace(new RegExp(`^${fence[0] === "`" ? "`" : "~"}+`), "") === "") fence = null;
      continue;
    }
    if (math) {
      cur.push(line);
      if (line.trim().endsWith("$$")) math = false;
      continue;
    }
    if (!line.trim()) {
      if (cur.length) {
        blankBefore = true;
        cur.push(line);
      }
      continue;
    }
    if (blankBefore) {
      blankBefore = false;
      const continues = /^(\t| {1,})\S/.test(line) || (isList && LIST_ITEM.test(line));
      if (!continues) flush();
    }
    if (!cur.length) isList = LIST_ITEM.test(line);
    const open = FENCE.exec(line);
    if (open) fence = open[1];
    else {
      const t = line.trim();
      if (t.startsWith("$$") && !(t.length > 4 && t.endsWith("$$"))) math = true;
    }
    cur.push(line);
  }
  flush();
  return blocks;
}

/** Inline code spans and the text between them, for counting markers outside code. */
function outsideInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, "");
}

function closeMarker(text: string, marker: string): string {
  const count = outsideInlineCode(text).split(marker).length - 1;
  if (count % 2 === 0) return text;
  if (text.endsWith(marker)) return text.slice(0, -marker.length); // opened, nothing inside yet
  return text.replace(/(\s*)$/, `${marker}$1`); // closed before any trailing space, or it would not close
}

/** The last block of an answer that is still being written, made ready to draw. */
export function closeOpenMarkdown(block: string): string {
  const lines = block.split("\n");
  // In an unclosed code fence the renderer shows a code block up to the end: right as it is.
  let fence: string | null = null;
  for (const line of lines) {
    const open = FENCE.exec(line);
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
    } else if (open) fence = open[1];
  }
  if (fence) return block;
  // A formula still being written: drawn once it is complete.
  const mathAt = lines.findIndex((l) => l.trim().startsWith("$$"));
  if (mathAt >= 0) {
    const rest = lines.slice(mathAt).join("\n").trim();
    const closed = rest.length > 4 && rest.endsWith("$$");
    if (!closed) return lines.slice(0, mathAt).join("\n").trimEnd();
  }
  // A table whose header row has arrived but not the row under it: drawn once it is a table.
  if (lines[0].trim().startsWith("|") && !lines.some((l) => /^\s*\|?\s*:?-{3,}/.test(l))) return "";
  let text = block;
  // The start of a heading, a list item, or a rule ("-" under a paragraph would make it a heading).
  text = text.replace(/\n {0,3}(#{1,6}|[-*+=_]{1,3}|\d{1,9}[.)])[ \t]*$/, "");
  if (/^ {0,3}(#{1,6}|[-*+=_]{1,3}|\d{1,9}[.)])[ \t]*$/.test(text)) return "";
  // A link whose address is still arriving: its text for now.
  text = text.replace(/!?\[([^\]\n]*)\]\([^)\s]*$/, "$1");
  // Code, bold and strikethrough opened but not closed yet.
  const tick = outsideInlineCode(text).split("`").length - 1;
  if (tick % 2 === 1) text = text.endsWith("`") ? text.slice(0, -1) : `${text}\``;
  text = closeMarker(text, "**");
  text = closeMarker(text, "~~");
  return text;
}
