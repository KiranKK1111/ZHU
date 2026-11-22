/**
 * ZHU's own pointer: the arrow, the arrow with a spark (over things that can be clicked) and the
 * text beam, in the colours of the ZHU mark.
 *
 * Almost everywhere they are ordinary CSS cursors: Windows draws them, so the pointer moves
 * exactly as the normal one does. The exception is a strip along the edges of the window. The
 * browser engine refuses a custom cursor whenever part of its image would reach past the edge of
 * the window, whatever its size (measured: with a 16 px image the standard arrow still appeared
 * across the last 15 px inside the right and bottom edges). An arrow points up and to the left,
 * so its image always reaches to the right and below the pointer, and those two edges are where
 * the standard arrow showed through. In that strip the system pointer is therefore hidden and the
 * same image is drawn by the page itself, following the mouse (`followAtEdges`).
 */

export type CursorKind = "arrow" | "action" | "text";

export interface CursorImage {
  /** The SVG as a data: address. */
  src: string;
  /** The point of the image that is the pointer's position, in CSS px. */
  hotX: number;
  hotY: number;
  /** Width and height of the image, in CSS px. */
  size: number;
  /** The whole CSS `cursor` value, with the standard cursor as fallback. */
  css: string;
}

/** CSS pixels the artwork is drawn at: a little larger than the standard Windows arrow. */
export const CURSOR_SIZE = 24;

const GRADIENT =
  '<linearGradient id="g" x1="5" y1="3" x2="20" y2="27" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#B3A4FF"/><stop offset="0.5" stop-color="#7F6EF6"/><stop offset="1" stop-color="#4B3FD8"/></linearGradient>';
const SHADOW = '<filter id="s" x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.1" flood-color="#17123A" flood-opacity="0.5"/></filter>';
const ARROW = "M5 3.2 V23.4 L10.4 18.4 L13.9 26.4 C14.2 27.1 15 27.4 15.7 27.1 L17.3 26.4 C18 26.1 18.3 25.3 18 24.6 L14.6 16.9 H21.8 Z";
const SPARK = "M23.5 2.6 C23.9 6 25.1 7.2 28.5 7.6 C25.1 8 23.9 9.2 23.5 12.6 C23.1 9.2 21.9 8 18.5 7.6 C21.9 7.2 23.1 6 23.5 2.6 Z";
const BEAM = "M11.5 6.5 C14 6.5 16 7.4 16 9.6 V22.4 C16 24.6 14 25.5 11.5 25.5 M20.5 6.5 C18 6.5 16 7.4 16 9.6 M16 22.4 C16 24.6 18 25.5 20.5 25.5 M13.6 16 H18.4";
/** Scaled about the arrow's tip (5, 3.2), so the tip stays where it is. */
const ARROW_TRANSFORM = "translate(1 0.64) scale(0.8)";

/** The artwork sits in a 32-unit drawing; each cursor shows the 24-unit part of it that holds its shape. */
const ARTWORK: Record<CursorKind, { body: string; viewX: number; viewY: number; hotX: number; hotY: number; fallback: string }> = {
  arrow: {
    body: `<defs>${GRADIENT}${SHADOW}</defs><path transform="${ARROW_TRANSFORM}" filter="url(#s)" fill="url(#g)" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round" d="${ARROW}"/>`,
    viewX: 3,
    viewY: 1.5,
    hotX: 5,
    hotY: 3.2,
    fallback: "default",
  },
  action: {
    body:
      `<defs>${GRADIENT}${SHADOW}</defs><g transform="${ARROW_TRANSFORM}" filter="url(#s)" stroke-linejoin="round">` +
      `<path fill="url(#g)" stroke="#FFFFFF" stroke-width="1.6" d="${ARROW}"/><path fill="#FFD166" stroke="#4B3FD8" stroke-width="0.9" d="${SPARK}"/></g>`,
    viewX: 3,
    viewY: 1.5,
    hotX: 5,
    hotY: 3.2,
    fallback: "pointer",
  },
  text: {
    body:
      `<defs><filter id="s" x="-60%" y="-30%" width="220%" height="160%"><feDropShadow dx="0" dy="1" stdDeviation="0.9" flood-color="#17123A" flood-opacity="0.45"/></filter></defs>` +
      `<g transform="translate(16 16) scale(0.82) translate(-16 -16)" filter="url(#s)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      `<path stroke="#FFFFFF" stroke-width="4.4" d="${BEAM}"/><path stroke="#5B4BE0" stroke-width="2" d="${BEAM}"/></g>`,
    viewX: 4,
    viewY: 4,
    hotX: 16,
    hotY: 16,
    fallback: "text",
  },
};

function image(kind: CursorKind): CursorImage {
  const a = ARTWORK[kind];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="${a.viewX} ${a.viewY} ${CURSOR_SIZE} ${CURSOR_SIZE}">${a.body}</svg>`;
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const hotX = Math.round(a.hotX - a.viewX);
  const hotY = Math.round(a.hotY - a.viewY);
  return { src, hotX, hotY, size: CURSOR_SIZE, css: `url("${src}") ${hotX} ${hotY}, ${a.fallback}` };
}

/** The three pointer images. */
export const ZHU_CURSORS: Record<CursorKind, CursorImage> = { arrow: image("arrow"), action: image("action"), text: image("text") };

// The same choices as the cursor rules in globals.css, for the strip where the page draws the pointer.
const TEXT_INPUT = 'textarea, input:not([type]), input[type="text"], input[type="password"], input[type="search"], input[type="email"], input[type="url"], input[type="number"], [contenteditable="true"]';
const CLICKABLE =
  'button, a[href], select, summary, label[for], input[type="checkbox"], input[type="radio"], input[type="file"], [role="button"], [role="tab"], [role="option"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="radio"]';
const NOT_CLICKABLE = ':disabled, [aria-disabled="true"], [data-disabled], .cursor-default';
const SELECTABLE_TEXT = "p, span, li, pre, code, h1, h2, h3, h4, td, th, blockquote, em, strong";

/** Which pointer an element shows. */
export function cursorKindFor(el: Element | null): CursorKind {
  if (!el) return "arrow";
  if (el.closest(TEXT_INPUT)) return "text";
  const clickable = el.closest(CLICKABLE);
  if (clickable) return clickable.matches(NOT_CLICKABLE) ? "arrow" : "action";
  return el.matches(SELECTABLE_TEXT) && el.closest(".selectable") ? "text" : "arrow";
}

/**
 * True when the pointer image at this position would not lie wholly inside the window, which is
 * where the browser engine falls back to the standard arrow. One pixel of margin on every side.
 */
export function reachesPastEdge(img: CursorImage, x: number, y: number, width: number, height: number): boolean {
  const left = x - img.hotX;
  const top = y - img.hotY;
  return left < 1 || top < 1 || left + img.size > width - 1 || top + img.size > height - 1;
}

const VARIABLES: Record<CursorKind, string> = { arrow: "--zhu-cursor", action: "--zhu-cursor-action", text: "--zhu-cursor-text" };
const AT_EDGE = "zhu-cursor-at-edge";

/** Draws the pointer in the strip along the window's edges. Returns the function that stops it. */
function followAtEdges(root: HTMLElement): () => void {
  const follower = document.createElement("img");
  follower.className = "zhu-edge-cursor";
  follower.alt = "";
  follower.draggable = false;
  follower.setAttribute("aria-hidden", "true");
  follower.width = follower.height = CURSOR_SIZE;
  document.body.appendChild(follower);
  let shown: CursorKind | null = null;

  const hide = () => {
    if (shown === null) return;
    shown = null;
    follower.style.display = "none";
    root.classList.remove(AT_EDGE);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType && e.pointerType !== "mouse") return hide();
    // Over a resize bar (or while dragging one) the resize arrow is shown, not the page's arrow.
    if ((e.target instanceof Element && e.target.closest("[data-split]")) || /zhu-resizing-/.test(root.className)) return hide();
    const kind = cursorKindFor(e.target instanceof Element ? e.target : null);
    const img = ZHU_CURSORS[kind];
    if (!reachesPastEdge(img, e.clientX, e.clientY, window.innerWidth, window.innerHeight)) return hide();
    if (shown !== kind) {
      if (shown === null) {
        root.classList.add(AT_EDGE); // hides the system pointer (globals.css)
        follower.style.display = "block";
      }
      follower.src = img.src;
      shown = kind;
    }
    follower.style.transform = `translate(${e.clientX - img.hotX}px, ${e.clientY - img.hotY}px)`;
  };
  // The mouse left the window (or went onto a chat website, which is not part of this page).
  const left = (e: MouseEvent) => {
    if (!e.relatedTarget) hide();
  };

  window.addEventListener("pointermove", move, { capture: true, passive: true });
  window.addEventListener("pointerdown", move, { capture: true, passive: true });
  document.addEventListener("mouseout", left);
  document.documentElement.addEventListener("pointerleave", hide);
  window.addEventListener("blur", hide);
  return () => {
    window.removeEventListener("pointermove", move, { capture: true });
    window.removeEventListener("pointerdown", move, { capture: true });
    document.removeEventListener("mouseout", left);
    document.documentElement.removeEventListener("pointerleave", hide);
    window.removeEventListener("blur", hide);
    hide();
    follower.remove();
  };
}

/**
 * Switch ZHU's pointer on for this window. Returns the function that switches it off again; every
 * cursor rule in globals.css then falls back to the standard cursor.
 */
export function installZhuCursors(root: HTMLElement = document.documentElement): () => void {
  for (const kind of Object.keys(VARIABLES) as CursorKind[]) root.style.setProperty(VARIABLES[kind], ZHU_CURSORS[kind].css);
  for (const [name, value] of Object.entries(RESIZE)) root.style.setProperty(name, value);
  const stopFollowing = followAtEdges(root);
  return () => {
    stopFollowing();
    for (const name of [...Object.values(VARIABLES), ...Object.keys(RESIZE)]) root.style.removeProperty(name);
  };
}

/**
 * The bars that resize panes inside the window (components/primitives/SplitHandle) use ZHU's
 * resize arrows, the same artwork the shell shows at the window's edges (public/cursors).
 */
const RESIZE: Record<string, string> = {
  "--zhu-cursor-ew": 'url("/cursors/resize-ew.svg") 16 16, col-resize',
  "--zhu-cursor-ns": 'url("/cursors/resize-ns.svg") 16 16, row-resize',
};
