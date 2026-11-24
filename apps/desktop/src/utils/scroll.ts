/** Auto-scroll policy for live transcript views (UI prompt §10). */

export const NEAR_BOTTOM_PX = 72;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The user is "near the bottom" when the remaining scroll distance is small. */
export function isNearBottom(m: ScrollMetrics, threshold: number = NEAR_BOTTOM_PX): boolean {
  return m.scrollHeight - (m.scrollTop + m.clientHeight) <= threshold;
}

/**
 * Decide what to do when new content arrives:
 * - "follow": the user was near the bottom, so scroll to the new end
 * - "notify": the user scrolled up; keep their position and show "Jump to live"
 */
export function onNewContent(wasNearBottom: boolean): "follow" | "notify" {
  return wasNearBottom ? "follow" : "notify";
}

/** Seconds for the follow glide to cover about two thirds of the way to the bottom. */
export const FOLLOW_TAU_S = 0.09;

/**
 * One frame of gliding from `current` toward `target` (scroll positions, pixels) after `dt`
 * seconds: an exponential ease, independent of the frame rate, at least a pixel a frame so it
 * always arrives, and never past the target.
 */
export function followStep(current: number, target: number, dt: number, tau = FOLLOW_TAU_S): number {
  const gap = target - current;
  if (Math.abs(gap) < 1 || !(dt > 0)) return target;
  const step = gap * (1 - Math.exp(-dt / tau));
  return current + (Math.abs(step) < 1 ? Math.sign(gap) : step);
}
