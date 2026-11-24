/**
 * The typewriter: how much of a streamed answer is on screen. Pure, so it can be tested.
 *
 * Text arrives in bursts (the engine sends what the model wrote about 20 times a second, and
 * models themselves write unevenly). Shown as it arrives, it jumps. Here the visible part closes
 * the gap to what has arrived exponentially, with time constant `LAG_S`: a model writing at a
 * steady R characters a second is shown at R characters a second, `LAG_S` behind; a burst is
 * spread over the next fraction of a second; a pause slows the text down instead of stopping it
 * dead. The step depends on the elapsed time, not on the number of frames, so a busy or slower
 * screen shows the same speed.
 */

/** Seconds the visible text trails what has arrived, at a steady pace. */
export const LAG_S = 0.3;
/** Once the answer is complete: the rest is shown faster (about 4 × this to finish). */
export const DRAIN_S = 0.12;
/** Never slower than this (characters a second), so the last words do not crawl. */
export const MIN_CPS = 45;

export interface Reveal {
  /** Characters visible. */
  shown: number;
  /** Fraction of a character carried to the next frame. */
  carry: number;
}

/**
 * The next frame: `target` characters have arrived, `dt` seconds passed since the last frame, and
 * `streaming` says whether more may come.
 */
export function revealStep(state: Reveal, target: number, dt: number, streaming: boolean): Reveal {
  const gap = target - state.shown;
  if (gap <= 0 || !(dt > 0)) return gap <= 0 ? { shown: target, carry: 0 } : state;
  const tau = streaming ? LAG_S : DRAIN_S;
  const advance = Math.max(gap * (1 - Math.exp(-dt / tau)), MIN_CPS * dt) + state.carry;
  const whole = Math.floor(advance);
  const shown = Math.min(target, state.shown + whole);
  return { shown, carry: shown === target ? 0 : advance - whole };
}

/** Never end the visible part between the two halves of a character outside the BMP (an emoji). */
export function safeCut(text: string, n: number): string {
  if (n <= 0) return "";
  if (n >= text.length) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n + 1 : n);
}

/** Characters at the start of both strings. */
export function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Milliseconds between screen updates: every frame while the paragraph being written is short;
 * less often while it is long (a big code block is highlighted again on every update), so the
 * page stays smooth to scroll. The text still advances at the same speed, in larger steps.
 */
export function updateInterval(visible: string): number {
  const fences = visible.match(/^ {0,3}(```|~~~)/gm)?.length ?? 0;
  const start = fences % 2 === 1 ? visible.search(/^ {0,3}(```|~~~)(?![\s\S]*^ {0,3}(```|~~~))/m) : visible.lastIndexOf("\n\n");
  const tail = visible.length - Math.max(0, start);
  return tail < 1500 ? 0 : Math.min(100, Math.round((tail / 1500) * 16));
}
