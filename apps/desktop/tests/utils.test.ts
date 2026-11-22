import { describe, expect, it } from "vitest";
import { isNearBottom, onNewContent } from "@/utils/scroll";
import { markUncertainWords, parseInlineCode } from "@/utils/text";
import { toAccelerator } from "@/utils/hotkeys";

describe("auto-scroll policy", () => {
  it("detects near-bottom within the threshold", () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1500, clientHeight: 560 })).toBe(true); // 40 px left
    expect(isNearBottom({ scrollTop: 500, scrollHeight: 1500, clientHeight: 560 })).toBe(false); // 440 px left
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 560 })).toBe(true); // no overflow
  });
  it("follows when near the bottom, otherwise shows Jump to live", () => {
    expect(onNewContent(true)).toBe("follow");
    expect(onNewContent(false)).toBe("notify");
  });
});

describe("text helpers", () => {
  it("splits inline code spans", () => {
    expect(parseInlineCode("How would you write `SELECT * FROM t` in SQL?")).toEqual([
      { kind: "text", text: "How would you write " },
      { kind: "code", text: "SELECT * FROM t" },
      { kind: "text", text: " in SQL?" },
    ]);
  });
  it("marks uncertain words in order", () => {
    const parts = markUncertainWords("What is kubernetes used for?", [{ text: "kubernetes", reason: "low" }]);
    expect(parts.filter((p) => p.uncertain).map((p) => p.text)).toEqual(["kubernetes"]);
    expect(parts.map((p) => p.text).join("")).toBe("What is kubernetes used for?");
  });
});

describe("hotkey recorder", () => {
  const e = (p: Partial<{ key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }>) => ({ key: "s", code: "KeyS", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...p });
  it("builds Tauri accelerators and requires a modifier", () => {
    expect(toAccelerator(e({ ctrlKey: true, shiftKey: true }))).toBe("CommandOrControl+Shift+S");
    expect(toAccelerator(e({ key: " ", code: "Space", ctrlKey: true }))).toBe("CommandOrControl+Space");
    expect(toAccelerator(e({ key: "F5", code: "F5", altKey: true }))).toBe("Alt+F5");
    expect(toAccelerator(e({}))).toBeNull();
    expect(toAccelerator(e({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeNull();
  });
});
