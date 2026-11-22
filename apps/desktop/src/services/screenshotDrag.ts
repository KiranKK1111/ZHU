/**
 * Dragging screenshots from the side panel into a message box.
 *
 * This is done with pointer events rather than the browser's own drag and drop, which the desktop
 * shell's file-drop handling switches off on Windows. A drop zone is any element carrying
 * `data-drop-zone="<id>"` whose id has a handler registered here (see useDropZone).
 */
import { create } from "zustand";

interface DragStore {
  /** The screenshots being dragged, or null. */
  ids: string[] | null;
  /** The drop zone under the pointer. */
  over: string | null;
}

export const useScreenshotDrag = create<DragStore>(() => ({ ids: null, over: null }));

const handlers = new Map<string, (ids: string[]) => void>();

/** Register what a drop zone does with dropped screenshots. Returns the function that removes it. */
export function registerDropZone(zone: string, onDrop: (ids: string[]) => void): () => void {
  handlers.set(zone, onDrop);
  return () => {
    if (handlers.get(zone) === onDrop) handlers.delete(zone);
  };
}

/** Movement (px) before a press becomes a drag; less than this is a click. */
const THRESHOLD = 6;
let suppressClick = false;

/** True right after a drag ended on the element that started it, so its click handler can ignore that release. */
export function wasDragged(): boolean {
  return suppressClick;
}

function zoneAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]");
  const zone = el?.dataset.dropZone ?? null;
  return zone && handlers.has(zone) ? zone : null;
}

function makeGhost(source: HTMLElement, count: number): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "zhu-drag-ghost";
  const img = source.querySelector("img");
  if (img?.src) {
    const copy = document.createElement("img");
    copy.src = img.src;
    copy.alt = "";
    ghost.appendChild(copy);
  }
  if (count > 1) {
    const badge = document.createElement("span");
    badge.textContent = String(count);
    ghost.appendChild(badge);
  }
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Call from onPointerDown of a draggable screenshot. `ids` are what a drag carries (the pressed
 * screenshot, or the whole selection it belongs to).
 */
export function beginScreenshotDrag(event: { button: number; clientX: number; clientY: number; pointerId: number; currentTarget: HTMLElement }, ids: string[]): void {
  if (event.button !== 0 || !ids.length) return;
  const source = event.currentTarget;
  const pointerId = event.pointerId;
  const startX = event.clientX;
  const startY = event.clientY;
  let ghost: HTMLElement | null = null;
  // Keep receiving the pointer while it crosses a chat website, which is a separate native view.
  try {
    source.setPointerCapture(pointerId);
  } catch {
    /* a synthetic or already released pointer: the window listeners below still work */
  }

  const place = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  };
  const finish = (drop: { x: number; y: number } | null) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onCancel);
    try {
      source.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    if (!ghost) return; // never became a drag: an ordinary click
    ghost.remove();
    document.body.classList.remove("zhu-dragging");
    const zone = drop ? zoneAt(drop.x, drop.y) : null;
    useScreenshotDrag.setState({ ids: null, over: null });
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    if (zone) handlers.get(zone)?.(ids);
  };
  const onMove = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < THRESHOLD) return;
      ghost = makeGhost(source, ids.length);
      document.body.classList.add("zhu-dragging");
      useScreenshotDrag.setState({ ids, over: null });
    }
    place(e.clientX, e.clientY);
    const over = zoneAt(e.clientX, e.clientY);
    if (over !== useScreenshotDrag.getState().over) useScreenshotDrag.setState({ over });
  };
  const onUp = (e: PointerEvent) => finish({ x: e.clientX, y: e.clientY });
  const onCancel = () => finish(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !ghost) return;
    e.preventDefault();
    e.stopPropagation();
    finish(null);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onCancel);
}
