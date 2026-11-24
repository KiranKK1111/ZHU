import { useCallback, useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/useMisc";
import { followStep, isNearBottom } from "@/utils/scroll";

/**
 * A scroll area that follows its content to the bottom as it grows (a streamed answer, a live
 * transcript), gliding instead of jumping, until the reader scrolls up.
 *
 * * Content growth is watched with a ResizeObserver on `contentRef`, so text, highlighted code,
 *   formulas and images that change size later are all followed.
 * * The glide eases toward the bottom (utils/scroll.ts `followStep`); new content during a glide
 *   just moves its destination, so a typed answer is followed in one continuous movement.
 * * Scrolling up with the wheel, the keyboard, a touch or the scrollbar stops following at once,
 *   even in the middle of a glide; scrolling back to the bottom starts it again.
 * * `away` is true while the reader is up the page; `missed` once content arrived meanwhile (for a
 *   "Latest" / "Jump to live" button). With "reduce motion" on, it jumps instead of gliding.
 * * What is already there when the view opens is shown at the bottom at once.
 */
export function useStickToBottom<S extends HTMLElement = HTMLDivElement, C extends HTMLElement = HTMLDivElement>({ threshold = 80 }: { threshold?: number } = {}) {
  const scrollRef = useRef<S>(null);
  const contentRef = useRef<C>(null);
  const reduced = usePrefersReducedMotion();
  const pinned = useRef(true);
  const glide = useRef(0);
  const lastTick = useRef<number | null>(null);
  const expected = useRef<number | null>(null); // where the last programmatic scroll put us
  const [away, setAway] = useState(false);
  const [missed, setMissed] = useState(false);

  const stop = useCallback(() => {
    cancelAnimationFrame(glide.current);
    glide.current = 0;
    lastTick.current = null;
  }, []);

  const follow = useCallback(
    (smooth = true) => {
      const el = scrollRef.current;
      if (!el) return;
      if (!smooth || reduced) {
        stop();
        el.scrollTop = el.scrollHeight;
        expected.current = el.scrollTop;
        return;
      }
      if (glide.current) return; // already gliding: it reads the new bottom on its next frame
      const tick = (now: number) => {
        const box = scrollRef.current;
        if (!box || !pinned.current) return stop();
        const dt = lastTick.current === null ? 1 / 60 : Math.min(0.1, (now - lastTick.current) / 1000);
        lastTick.current = now;
        const target = box.scrollHeight - box.clientHeight;
        const next = followStep(box.scrollTop, target, dt);
        const arrived = Math.abs(target - next) < 1;
        box.scrollTop = arrived ? target : next; // the last frame lands exactly on the bottom
        expected.current = box.scrollTop;
        if (arrived) return stop();
        glide.current = requestAnimationFrame(tick);
      };
      glide.current = requestAnimationFrame(tick);
    },
    [reduced, stop],
  );

  /** Back to the newest content (the "Latest" button, or a message the user just sent). */
  const scrollToBottom = useCallback(
    (smooth = true) => {
      pinned.current = true;
      setAway(false);
      setMissed(false);
      follow(smooth);
    },
    [follow],
  );

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el) return;
    const leave = () => {
      if (!pinned.current) return;
      pinned.current = false;
      stop();
      setAway(true);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) leave();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) leave();
    };
    let dragging = false;
    const onDown = () => {
      dragging = true; // the scrollbar, or selecting text by dragging
    };
    const onUp = () => {
      dragging = false;
    };
    const onScroll = () => {
      const programmatic = expected.current !== null && Math.abs(el.scrollTop - expected.current) < 2;
      if (programmatic && !dragging) return;
      expected.current = null;
      const near = isNearBottom(el, threshold);
      if (near && !pinned.current) {
        pinned.current = true;
        setAway(false);
        setMissed(false);
      } else if (!near) leave();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", leave, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("scroll", onScroll, { passive: true });
    // The first report is the content that was there when the view opened: shown at the bottom
    // straight away, not glided to.
    let first = true;
    const ro =
      content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (pinned.current) follow(!first);
            else setMissed(true);
            first = false;
          })
        : null;
    if (ro && content) ro.observe(content);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", leave);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      stop();
    };
  }, [follow, stop, threshold]);

  return { scrollRef, contentRef, away, missed, scrollToBottom };
}
