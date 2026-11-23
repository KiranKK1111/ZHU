/**
 * ZHU's own pointer: one arrow, in the colours of the ZHU mark. It is the only pointer ZHU shows,
 * over buttons, links, text boxes and dividers alike (globals.css); there is no hand, text beam or
 * resize arrow.
 *
 * Almost everywhere it is an ordinary CSS cursor: Windows draws it, so the pointer moves exactly
 * as the normal one does. The exception is a strip along the edges of the window. The browser
 * engine refuses a custom cursor whenever part of its image would reach past the edge of the
 * window, whatever its size (measured: with a 16 px image the standard arrow still appeared across
 * the last 15 px inside the right and bottom edges). An arrow points up and to the left, so its
 * image always reaches to the right and below the pointer, and those two edges are where the
 * standard arrow showed through. In that strip the system pointer is therefore hidden and the same
 * image is drawn by the page itself, following the mouse (`followAtEdges`).
 */

export interface CursorImage {
  /** The SVG as a data: address. */
  src: string;
  /** The point of the image that is the pointer's position, in CSS px. */
  hotX: number;
  hotY: number;
  /** Width and height of the image, in CSS px. */
  size: number;
  /** The whole CSS `cursor` value, with the standard arrow as fallback. */
  css: string;
}

/** CSS pixels the artwork is drawn at: a little larger than the standard Windows arrow. */
export const CURSOR_SIZE = 24;

const GRADIENT =
  '<linearGradient id="g" x1="5" y1="3" x2="20" y2="27" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#B3A4FF"/><stop offset="0.5" stop-color="#7F6EF6"/><stop offset="1" stop-color="#4B3FD8"/></linearGradient>';
const SHADOW = '<filter id="s" x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.1" flood-color="#17123A" flood-opacity="0.5"/></filter>';
const ARROW = "M5 3.2 V23.4 L10.4 18.4 L13.9 26.4 C14.2 27.1 15 27.4 15.7 27.1 L17.3 26.4 C18 26.1 18.3 25.3 18 24.6 L14.6 16.9 H21.8 Z";
/** Scaled about the arrow's tip (5, 3.2), so the tip stays where it is. */
const ARROW_TRANSFORM = "translate(1 0.64) scale(0.8)";
/** The part of the 32-unit drawing that holds the arrow, and the tip, in drawing units. */
const VIEW_X = 3;
const VIEW_Y = 1.5;
const TIP_X = 5;
const TIP_Y = 3.2;

function arrowImage(): CursorImage {
  const body = `<defs>${GRADIENT}${SHADOW}</defs><path transform="${ARROW_TRANSFORM}" filter="url(#s)" fill="url(#g)" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round" d="${ARROW}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_SIZE}" height="${CURSOR_SIZE}" viewBox="${VIEW_X} ${VIEW_Y} ${CURSOR_SIZE} ${CURSOR_SIZE}">${body}</svg>`;
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  const hotX = Math.round(TIP_X - VIEW_X);
  const hotY = Math.round(TIP_Y - VIEW_Y);
  return { src, hotX, hotY, size: CURSOR_SIZE, css: `url("${src}") ${hotX} ${hotY}, default` };
}

/** ZHU's arrow. */
export const ZHU_ARROW: CursorImage = arrowImage();

/**
 * True when the pointer image at this position would not lie wholly inside the window, which is
 * where the browser engine falls back to the standard arrow. One pixel of margin on every side.
 */
export function reachesPastEdge(img: CursorImage, x: number, y: number, width: number, height: number): boolean {
  const left = x - img.hotX;
  const top = y - img.hotY;
  return left < 1 || top < 1 || left + img.size > width - 1 || top + img.size > height - 1;
}

const VARIABLE = "--zhu-cursor";
const AT_EDGE = "zhu-cursor-at-edge";

/** Draws the pointer in the strip along the window's edges. Returns the function that stops it. */
function followAtEdges(root: HTMLElement): () => void {
  const follower = document.createElement("img");
  follower.className = "zhu-edge-cursor";
  follower.alt = "";
  follower.draggable = false;
  follower.setAttribute("aria-hidden", "true");
  follower.width = follower.height = CURSOR_SIZE;
  follower.src = ZHU_ARROW.src;
  document.body.appendChild(follower);
  let shown = false;

  const hide = () => {
    if (!shown) return;
    shown = false;
    follower.style.display = "none";
    root.classList.remove(AT_EDGE);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerType && e.pointerType !== "mouse") return hide();
    if (!reachesPastEdge(ZHU_ARROW, e.clientX, e.clientY, window.innerWidth, window.innerHeight)) return hide();
    if (!shown) {
      shown = true;
      root.classList.add(AT_EDGE); // hides the system pointer (globals.css)
      follower.style.display = "block";
    }
    follower.style.transform = `translate(${e.clientX - ZHU_ARROW.hotX}px, ${e.clientY - ZHU_ARROW.hotY}px)`;
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
 * Switch ZHU's arrow on for this window. Returns the function that switches it off again; the
 * cursor rule in globals.css then falls back to the standard Windows arrow.
 */
export function installZhuCursors(root: HTMLElement = document.documentElement): () => void {
  root.style.setProperty(VARIABLE, ZHU_ARROW.css);
  const stopFollowing = followAtEdges(root);
  return () => {
    stopFollowing();
    root.style.removeProperty(VARIABLE);
  };
}
