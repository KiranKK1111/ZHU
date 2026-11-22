/** Text helpers for rendering questions and transcripts. */

export type InlinePart = { kind: "text"; text: string } | { kind: "code"; text: string };

/** Split text on `backtick` spans (the engine wraps SQL fragments in backticks). */
export function parseInlineCode(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) });
    parts.push({ kind: "code", text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export type MarkedPart = { text: string; uncertain: boolean; reason?: string };

/**
 * Mark uncertain words in a text: a word is uncertain when it matches a low-probability
 * STT word. Matching is case-insensitive on stripped tokens, in order.
 */
export function markUncertainWords(text: string, uncertain: { text: string; reason?: string }[]): MarkedPart[] {
  if (!uncertain.length) return [{ text, uncertain: false }];
  const queue = uncertain.map((u) => ({ token: normalizeToken(u.text), reason: u.reason })).filter((u) => u.token);
  const out: MarkedPart[] = [];
  const re = /(\s+)/;
  for (const piece of text.split(re)) {
    if (!piece) continue;
    const token = normalizeToken(piece);
    const idx = token ? queue.findIndex((q) => q.token === token) : -1;
    if (idx >= 0) {
      out.push({ text: piece, uncertain: true, reason: queue[idx].reason });
      queue.splice(idx, 1);
    } else if (out.length && !out[out.length - 1].uncertain) {
      out[out.length - 1] = { text: out[out.length - 1].text + piece, uncertain: false };
    } else {
      out.push({ text: piece, uncertain: false });
    }
  }
  return out;
}

export function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/^[^\p{L}\p{N}#+]+|[^\p{L}\p{N}#+]+$/gu, "");
}

/** Spans (from Question.uncertain_spans, char offsets into raw_text) -> list of words. */
export function wordsFromSpans(raw: string, spans: { start: number; end: number; reason: string }[]): { text: string; reason: string }[] {
  return spans
    .filter((s) => s.start >= 0 && s.end <= raw.length && s.end > s.start)
    .map((s) => ({ text: raw.slice(s.start, s.end), reason: s.reason }));
}

export function highlightMatches(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let pos = 0;
  while (pos < text.length) {
    const idx = lower.indexOf(ql, pos);
    if (idx < 0) {
      out.push({ text: text.slice(pos), match: false });
      break;
    }
    if (idx > pos) out.push({ text: text.slice(pos, idx), match: false });
    out.push({ text: text.slice(idx, idx + q.length), match: true });
    pos = idx + q.length;
  }
  return out;
}
