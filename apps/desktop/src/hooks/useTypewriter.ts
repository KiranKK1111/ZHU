import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/useMisc";
import { commonPrefix, revealStep, safeCut, updateInterval, type Reveal } from "@/utils/typewriter";

/**
 * The part of `text` to show, typed out smoothly as `text` grows (see utils/typewriter.ts).
 *
 * What is already there when the component appears is shown at once (an answer from history, or
 * one that was opened while it was being written): only text that arrives afterwards is typed.
 * When the text is replaced by something else (an answer asked again), the typing goes on from
 * what the two have in common. With "reduce motion" on, everything is shown at once.
 *
 * One animation frame loop runs while the visible text is behind, and stops when it has caught
 * up; the component re-renders only when more characters become visible.
 */
export function useTypewriter(text: string, streaming: boolean): string {
  const reduced = usePrefersReducedMotion();
  const reveal = useRef<Reveal>({ shown: text.length, carry: 0 });
  const shownText = useRef(text);
  const latest = useRef({ text, streaming });
  latest.current = { text, streaming };
  const loop = useRef<(() => void) | null>(null); // cancels the scheduled tick while the loop runs
  const lastTick = useRef<number | null>(null);
  const lastPaint = useRef(0);
  const [, repaint] = useState(0);

  if (!text.startsWith(shownText.current)) reveal.current = { shown: commonPrefix(text, shownText.current), carry: 0 };
  const behind = !reduced && reveal.current.shown < text.length;

  useEffect(() => {
    if (!behind || loop.current) return;
    const tick = (now: number) => {
      const { text: target, streaming: more } = latest.current;
      const dt = lastTick.current === null ? 1 / 60 : Math.min(1, Math.max(0, (now - lastTick.current) / 1000));
      lastTick.current = now;
      const prev = reveal.current.shown;
      const next = revealStep(reveal.current, target.length, dt, more);
      reveal.current = next;
      const done = next.shown >= target.length;
      // A long paragraph (a big code block) is drawn less often; the last character always is.
      if (next.shown !== prev && (done || now - lastPaint.current >= updateInterval(safeCut(target, next.shown)))) {
        lastPaint.current = now;
        repaint((n) => n + 1);
      }
      if (done) {
        loop.current = null;
        lastTick.current = null;
      } else schedule();
    };
    // Each tick on the next frame; when no frame comes (the window is minimized, or the system
    // pauses drawing), a timer takes its place, so the text never stays behind what has arrived.
    const schedule = () => {
      let timer = 0;
      const frame = requestAnimationFrame((now) => {
        clearTimeout(timer);
        tick(now);
      });
      timer = window.setTimeout(() => {
        cancelAnimationFrame(frame);
        tick(performance.now());
      }, 250);
      loop.current = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
      };
    };
    schedule();
  });
  useEffect(
    () => () => {
      loop.current?.();
      loop.current = null; // a remount (React's development double mount) starts the loop again
      lastTick.current = null;
    },
    [],
  );

  const visible = reduced ? text : safeCut(text, reveal.current.shown);
  shownText.current = visible;
  return visible;
}
