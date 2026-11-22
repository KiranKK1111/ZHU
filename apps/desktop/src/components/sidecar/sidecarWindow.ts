/**
 * Sidecar window behavior: compact-mode resizing and recovery to a visible monitor
 * after a resize. Edge snapping and periodic off-screen recovery live in the Rust shell. Every call is best effort, and failures (missing permissions,
 * a window that is closing) are logged rather than thrown.
 */
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import { inTauri } from "@/services/shell";

export const SIDECAR_COMPACT_HEIGHT = 46;
export const SIDECAR_MIN = { width: 300, height: 260 };
const HEIGHT_KEY = "zhu.sidecar.expandedHeight";

export async function applyCompact(compact: boolean): Promise<void> {
  if (!inTauri) return;
  const win = getCurrentWindow();
  try {
    const scale = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(scale);
    if (compact) {
      if (size.height > SIDECAR_COMPACT_HEIGHT + 10) {
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(size.height)));
        } catch {
          /* ignore */
        }
      }
      await win.setMinSize(new LogicalSize(SIDECAR_MIN.width, SIDECAR_COMPACT_HEIGHT));
      await win.setSize(new LogicalSize(Math.max(SIDECAR_MIN.width, size.width), SIDECAR_COMPACT_HEIGHT));
    } else {
      let h = 520;
      try {
        h = Math.max(SIDECAR_MIN.height, Number(localStorage.getItem(HEIGHT_KEY)) || 520);
      } catch {
        /* ignore */
      }
      await win.setSize(new LogicalSize(Math.max(SIDECAR_MIN.width, size.width), h));
      await win.setMinSize(new LogicalSize(SIDECAR_MIN.width, SIDECAR_MIN.height));
    }
    await ensureVisible();
  } catch (err) {
    console.warn("sidecar resize failed", err);
  }
}

/** Restore to a visible position after a display configuration change. */
export async function ensureVisible(): Promise<void> {
  if (!inTauri) return;
  const win = getCurrentWindow();
  try {
    const mon = await currentMonitor();
    if (mon) return;
    const primary = await primaryMonitor();
    if (!primary) return;
    await win.setPosition(new PhysicalPosition(primary.position.x + Math.round(48 * primary.scaleFactor), primary.position.y + Math.round(48 * primary.scaleFactor)));
  } catch (err) {
    console.warn("sidecar visibility check failed", err);
  }
}
