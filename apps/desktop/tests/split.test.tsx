import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampShare, SplitHandle, splitShare, type SplitLimits } from "@/components/primitives/SplitHandle";

const limits: SplitLimits = { min: 0.25, max: 0.75, minPx: 300 };
const box = { left: 100, top: 50, width: 1000, height: 800 };

afterEach(cleanup);

describe("dragging a divider", () => {
  it("turns the pointer position into a share of the space, within the limits", () => {
    expect(splitShare("columns", { x: 600, y: 0 }, box, limits)).toBe(0.5);
    expect(splitShare("columns", { x: 400, y: 0 }, box, limits)).toBe(0.3);
    // Not narrower than 300 px either side, and not past min/max.
    expect(splitShare("columns", { x: 150, y: 0 }, box, limits)).toBe(0.3);
    expect(splitShare("columns", { x: 1090, y: 0 }, box, limits)).toBe(0.7);
    // Rows: the share is the bottom part's (the transcript), measured from the bottom edge.
    expect(splitShare("rows", { x: 0, y: 650 }, box, { min: 0.1, max: 0.9, minPx: 0 })).toBe(0.25);
  });

  it("keeps the pixel minimum when the space is small, and the middle when it cannot", () => {
    expect(clampShare(0.1, 2000, limits)).toBe(0.25);
    expect(clampShare(0.9, 2000, limits)).toBe(0.75);
    expect(clampShare(0.3, 500, limits)).toBe(0.5); // 300 px each side does not fit in 500: the middle
    expect(clampShare(0.5, 0, limits)).toBe(0.5);
  });

  it("works with the keyboard and resets on double-click", () => {
    const committed = vi.fn();
    const reset = vi.fn();
    function Harness() {
      const ref = useRef<HTMLDivElement>(null);
      const [value, setValue] = useState(0.5);
      return (
        <div ref={ref}>
          <SplitHandle
            direction="columns"
            label="Width"
            value={value}
            limits={{ min: 0.25, max: 0.75, minPx: 0 }}
            containerRef={ref}
            onChange={setValue}
            onCommit={(v) => {
              committed(v);
              setValue(v);
            }}
            onReset={reset}
          />
        </div>
      );
    }
    render(<Harness />);
    const bar = screen.getByRole("separator", { name: "Width" });
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(committed).toHaveBeenLastCalledWith(0.52);
    fireEvent.keyDown(bar, { key: "PageDown" });
    expect(committed).toHaveBeenLastCalledWith(0.42);
    fireEvent.keyDown(bar, { key: "Home" });
    expect(committed).toHaveBeenLastCalledWith(0.25);
    fireEvent.doubleClick(bar);
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
