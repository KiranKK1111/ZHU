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
