import { useEffect } from "react";
import { registerDropZone, useScreenshotDrag } from "@/services/screenshotDrag";
import { useLatest } from "./useMisc";

/**
 * Make an element accept screenshots dragged from the side panel. Spread `props` on the element;
 * `dragging` is true while any screenshot is being dragged (show where it can go) and `over` while
 * the pointer is on this element.
 */
export function useDropZone(zone: string, onDrop: (ids: string[]) => void): { props: { "data-drop-zone": string }; dragging: boolean; over: boolean } {
  const latest = useLatest(onDrop);
  useEffect(() => registerDropZone(zone, (ids) => latest.current(ids)), [zone, latest]);
  const dragging = useScreenshotDrag((s) => s.ids !== null);
  const over = useScreenshotDrag((s) => s.over === zone);
  return { props: { "data-drop-zone": zone }, dragging, over };
}
