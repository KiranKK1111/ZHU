import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { cn } from "@/utils/cn";

/**
 * "columns": a vertical bar between two columns; its value is the share of the first (left) column.
 * "rows": a horizontal bar between two rows; its value is the share of the last (bottom) row.
 */
export type SplitDirection = "columns" | "rows";

export interface SplitLimits {
  /** Least and most share, 0 to 1. */
  min: number;
  max: number;
  /** Least size of either side, in CSS pixels; wins over min and max when the space is small. */
  minPx: number;
}

/** The share the pointer asks for, kept within the limits. Pure, so it can be tested. */
export function splitShare(direction: SplitDirection, pointer: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }, limits: SplitLimits): number {
  const size = direction === "columns" ? box.width : box.height;
  if (!(size > 0)) return limits.min;
  const raw = direction === "columns" ? (pointer.x - box.left) / size : (box.top + box.height - pointer.y) / size;
  return clampShare(raw, size, limits);
}

export function clampShare(value: number, size: number, limits: SplitLimits): number {
  const pixels = size > 0 ? limits.minPx / size : 0;
  const lo = Math.max(limits.min, pixels);
  const hi = Math.min(limits.max, 1 - pixels);
  const share = lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, value));
  return Math.round(share * 1000) / 1000;
}

/** Keyboard step: 2% per arrow key, 10% with Page Up/Down. */
const STEP = 0.02;
const PAGE = 0.1;

/**
 * A bar to drag between two panes. Drag it to share the space differently; double-click it for
 * the original sizes; or focus it and use the arrow keys. While dragging only `onChange` is
 * called; `onCommit` once, at the end (to save the result).
 */
export function SplitHandle({
  direction,
  value,
  limits,
  containerRef,
  onChange,
  onCommit,
  onReset,
  label,
  className,
}: {
  direction: SplitDirection;
  value: number;
  limits: SplitLimits;
  containerRef: RefObject<HTMLElement | null>;
  onChange: (share: number) => void;
  onCommit: (share: number) => void;
  onReset: () => void;
  label: string;
  className?: string;
}) {
  const last = useRef<number | null>(null);
  const columns = direction === "columns";
  const resizingClass = columns ? "zhu-resizing-columns" : "zhu-resizing-rows";

  const box = () => containerRef.current?.getBoundingClientRect();

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box()) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = value;
    // The resize pointer, and no text selection, wherever the mouse goes while dragging.
    document.documentElement.classList.add(resizingClass);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const rect = box();
    if (last.current === null || !rect) return;
    last.current = splitShare(direction, { x: e.clientX, y: e.clientY }, rect, limits);
    onChange(last.current);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (last.current === null) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    document.documentElement.classList.remove(resizingClass);
    const share = last.current;
    last.current = null;
    onCommit(share);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const rect = box();
    const size = rect ? (columns ? rect.width : rect.height) : 0;
    // Left/up makes the left column smaller; for rows the value is the bottom row, which up makes larger.
    const grow = columns ? e.key === "ArrowRight" : e.key === "ArrowUp";
    const shrink = columns ? e.key === "ArrowLeft" : e.key === "ArrowDown";
    let next: number | null = null;
    if (grow || shrink) next = value + (grow ? STEP : -STEP);
    else if (e.key === "PageUp" || e.key === "PageDown") next = value + (e.key === "PageUp" ? PAGE : -PAGE);
    else if (e.key === "Home") next = limits.min;
    else if (e.key === "End") next = limits.max;
    else if (e.key === "Enter") {
      e.preventDefault();
      onReset();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    onCommit(clampShare(next, size, limits));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={columns ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(limits.min * 100)}
      aria-valuemax={Math.round(limits.max * 100)}
      aria-valuenow={Math.round(value * 100)}
      title={`${label}. Drag to resize; double-click for the original sizes.`}
      data-split={direction}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className={cn(
        "group relative z-[1] shrink-0 touch-none select-none outline-none",
        columns ? "-mx-[3px] w-[7px] self-stretch" : "-my-[3px] h-[7px] w-full",
        className,
      )}
    >
      {/* The visible line: hairline at rest, accent while hovered, focused or dragged. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-border-subtle transition-[background-color,transform] duration-fast",
          "group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent",
          columns ? "inset-y-0 left-[3px] w-px group-hover:scale-x-[3] group-active:scale-x-[3] group-focus-visible:scale-x-[3]" : "inset-x-0 top-[3px] h-px group-hover:scale-y-[3] group-active:scale-y-[3] group-focus-visible:scale-y-[3]",
        )}
      />
    </div>
  );
}
