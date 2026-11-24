/**
 * The typewriter, block-by-block Markdown and the follow scroll. The timing properties are checked
 * by simulation: text arriving the way the engine sends it (bursts about 20 times a second) and
 * frames drawn at a given rate.
 */
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareMarkdown } from "@/features/chat/chatText";
import { closeOpenMarkdown, splitBlocks } from "@/features/chat/markdownBlocks";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { useTypewriter } from "@/hooks/useTypewriter";
import { followStep } from "@/utils/scroll";
import { commonPrefix, DRAIN_S, LAG_S, MIN_CPS, revealStep, safeCut, updateInterval, type Reveal } from "@/utils/typewriter";

// ------------------------------------------------------------------ simulation helpers
/** Text arriving at `cps` characters a second in bursts every `burstMs`, shown at `fps`. Returns per-frame (shown, arrived). */
function simulate({ cps, seconds, fps = 60, burstMs = 50, endAt = Infinity }: { cps: number; seconds: number; fps?: number; burstMs?: number; endAt?: number }) {
  const frames: { t: number; shown: number; arrived: number }[] = [];
  let state: Reveal = { shown: 0, carry: 0 };
  const dt = 1 / fps;
  for (let t = dt; t <= seconds + 1e-9; t += dt) {
    const tt = Math.min(t, endAt);
    const arrived = Math.floor((Math.floor((tt * 1000) / burstMs) * burstMs * cps) / 1000);
    state = revealStep(state, arrived, dt, t < endAt);
    frames.push({ t, shown: state.shown, arrived });
  }
  return frames;
}
const stats = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, sd, cv: sd / mean };
};

describe("typewriter: timing", () => {
  it("never shows more than has arrived, and never goes backwards", () => {
    for (const cps of [20, 150, 900]) {
      const frames = simulate({ cps, seconds: 3 });
      frames.forEach((f, i) => {
        expect(f.shown).toBeLessThanOrEqual(f.arrived);
        if (i) expect(f.shown).toBeGreaterThanOrEqual(frames[i - 1].shown);
      });
    }
  });

  it("turns bursts into an even pace", () => {
    // 300 characters a second, in 15-character bursts every 50 ms: shown raw, 2 frames in 3 show nothing.
    const frames = simulate({ cps: 300, seconds: 4 }).filter((f) => f.t > 1);
    const advances = frames.slice(1).map((f, i) => f.shown - frames[i].shown);
    const raw = frames.slice(1).map((f, i) => f.arrived - frames[i].arrived);
    expect(stats(raw).cv).toBeGreaterThan(1.2);
    expect(stats(advances).cv).toBeLessThan(0.35);
    expect(stats(advances).mean).toBeCloseTo(300 / 60, 0);
  });

  it("follows a steady stream about LAG_S behind", () => {
    const cps = 240;
    const lag = simulate({ cps, seconds: 4 })
      .filter((f) => f.t > 2)
      .map((f) => (f.arrived - f.shown) / cps);
    const { mean } = stats(lag);
    expect(mean).toBeGreaterThan(LAG_S * 0.7);
    expect(mean).toBeLessThan(LAG_S * 1.4);
  });

  it("finishes quickly once the answer is complete", () => {
    const frames = simulate({ cps: 600, seconds: 3, endAt: 1.5 });
    const done = frames.find((f) => f.t > 1.5 && f.shown === f.arrived)!;
    expect(done.t - 1.5).toBeLessThan(DRAIN_S * 6);
    // A whole answer that arrives at once (a model that does not stream) is typed out in about a second.
    let s: Reveal = { shown: 0, carry: 0 };
    let t = 0;
    while (s.shown < 3000) {
      s = revealStep(s, 3000, 1 / 60, false);
      t += 1 / 60;
    }
    expect(t).toBeLessThan(1.2);
  });

  it("does not crawl over the last few characters", () => {
    let s: Reveal = { shown: 97, carry: 0 };
    let frames = 0;
    while (s.shown < 100) {
      s = revealStep(s, 100, 1 / 60, true);
      frames++;
    }
    expect(frames / 60).toBeLessThanOrEqual(3 / MIN_CPS + 1 / 60);
  });

  it("is the same speed at 30 and at 120 frames a second", () => {
    const at = (fps: number) => simulate({ cps: 200, seconds: 2, fps }).at(-1)!.shown;
    expect(Math.abs(at(30) - at(120))).toBeLessThanOrEqual(6);
  });

  it("cuts text safely and paints long blocks less often", () => {
    expect(safeCut("ok 😀", 4)).toBe("ok 😀");
    expect(safeCut("ok 😀", 3)).toBe("ok ");
    expect(commonPrefix("hello world", "hello there")).toBe(6);
    expect(updateInterval("A short paragraph.")).toBe(0);
    const longFence = "Intro\n\n```python\n" + "x = 1\n".repeat(600);
    expect(updateInterval(longFence)).toBeGreaterThan(16);
    expect(updateInterval(longFence)).toBeLessThanOrEqual(100);
    expect(updateInterval(longFence + "```\n\nAfter.")).toBe(0);
  });
});

// ------------------------------------------------------------------ Markdown blocks
const REMARK = [remarkGfm, remarkMath];
const REHYPE = [[rehypeKatex, { throwOnError: false, strict: false }], [rehypeHighlight, { detect: false }]] as never;
const html = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: REMARK, rehypePlugins: REHYPE }, md));
const squash = (s: string) => s.replace(/>\s+</g, "><").trim();

const ANSWER = `## Microservices or a monolith?

A **monolith** is one deployable unit. *Microservices* split it up.

1. Start with a monolith.

2. Split out services when:
   - teams block each other

   - parts scale differently

3. Keep one database per service.

| Aspect | Monolith | Microservices |
|---|---|---|
| Deploy | One unit | Many |
| Data | Shared | Per service |

\`\`\`python
def handler(event):

    return {"ok": True}
\`\`\`

$$
T(n) = 2T(n/2) + O(n)

$$

> Conway's law: systems mirror
> the organisations that build them.

---

    indented code after a rule

Cost is $5 and the formula is $x^2$. See [the docs](https://example.com).`;

describe("Markdown blocks", () => {
  it("renders the same, block by block, as the whole answer at once", () => {
    const md = prepareMarkdown(ANSWER);
    const blocks = splitBlocks(md);
    expect(blocks.length).toBeGreaterThan(6);
    expect(squash(blocks.map(html).join(""))).toBe(squash(html(md)));
  });

  it("never cuts inside code, formulas, lists or indented continuations", () => {
    const blocks = splitBlocks(prepareMarkdown(ANSWER));
    expect(blocks.find((b) => b.startsWith("```python"))).toContain('return {"ok": True}\n```');
    expect(blocks.find((b) => b.startsWith("$$"))).toMatch(/\$\$$/);
    expect(blocks.find((b) => b.startsWith("1."))).toContain("3. Keep one database");
    expect(blocks.filter((b) => b.trim().startsWith("- teams"))).toHaveLength(0);
    expect(splitBlocks("~~~\na\n\nb\n~~~\n\nc")).toEqual(["~~~\na\n\nb\n~~~", "c"]);
    expect(splitBlocks("Para\n\n    code\n\nNext")).toEqual(["Para\n\n    code", "Next"]);
  });

  it("keeps an answer that defines link references in one piece", () => {
    const md = "See [the guide][g].\n\nMore.\n\n[g]: https://example.com";
    expect(splitBlocks(md)).toEqual([md]);
  });

  it("tidies the block that is still being written", () => {
    expect(closeOpenMarkdown("Use **bold")).toBe("Use **bold**");
    expect(closeOpenMarkdown("Use **bold words ")).toBe("Use **bold words** ");
    expect(closeOpenMarkdown("Use **")).toBe("Use ");
    expect(closeOpenMarkdown("Call `fetch")).toBe("Call `fetch`");
    expect(closeOpenMarkdown("Call `")).toBe("Call ");
    expect(closeOpenMarkdown("A ~~mistake")).toBe("A ~~mistake~~");
    expect(closeOpenMarkdown("See [the docs](https://exam")).toBe("See the docs");
    expect(closeOpenMarkdown("Intro\n-")).toBe("Intro");
    expect(closeOpenMarkdown("##")).toBe("");
    expect(closeOpenMarkdown("| a | b |")).toBe("");
    expect(closeOpenMarkdown("Before\n$$\nT(n) = 2T(")).toBe("Before");
    const fence = "```python\ndef f(x):\n    return x **";
    expect(closeOpenMarkdown(fence)).toBe(fence);
    const done = "Both **bold** and `code`, a [link](https://example.com) and $$x$$.";
    expect(closeOpenMarkdown(done)).toBe(done);
  });
});

// ------------------------------------------------------------------ hooks, with frames driven by the test
let frames: FrameRequestCallback[] = [];
let clock = 0;
const nextFrame = (ms = 1000 / 60) => {
  clock += ms;
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(clock));
};
const runFor = (seconds: number, fps = 60) => {
  for (let i = 0; i < seconds * fps; i++) act(() => nextFrame(1000 / fps));
};

beforeEach(() => {
  frames = [];
  clock = 0;
  globalThis.requestAnimationFrame = (cb) => {
    frames.push(cb);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => undefined;
});
afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function Typed({ text, streaming }: { text: string; streaming: boolean }) {
  return <p data-testid="out">{useTypewriter(text, streaming)}</p>;
}

describe("useTypewriter", () => {
  it("shows what was there at once, then types what arrives", () => {
    const first = "An answer from history.";
    const view = render(<Typed text={first} streaming />);
    expect(view.getByTestId("out").textContent).toBe(first);
    const more = first + " Then a new paragraph arrives, word after word, in bursts.";
    view.rerender(<Typed text={more} streaming />);
    expect(view.getByTestId("out").textContent).toBe(first);
    runFor(0.1);
    const partway = view.getByTestId("out").textContent!;
    expect(partway.length).toBeGreaterThan(first.length);
    expect(partway.length).toBeLessThan(more.length);
    expect(more.startsWith(partway)).toBe(true);
    view.rerender(<Typed text={more} streaming={false} />);
    runFor(1);
    expect(view.getByTestId("out").textContent).toBe(more);
  });

  it("goes on from what two texts have in common when the answer is replaced", () => {
    const view = render(<Typed text="The answer is A." streaming />);
    view.rerender(<Typed text="The answer is B, because" streaming />);
    expect(view.getByTestId("out").textContent).toBe("The answer is ");
    runFor(1);
    expect(view.getByTestId("out").textContent).toBe("The answer is B, because");
  });

  it("shows everything at once with reduce motion on", () => {
    (window as { matchMedia?: unknown }).matchMedia = () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined });
    const view = render(<Typed text="Hello" streaming />);
    view.rerender(<Typed text="Hello there, all of it now." streaming />);
    expect(view.getByTestId("out").textContent).toBe("Hello there, all of it now.");
  });
});

describe("follow scroll", () => {
  it("glides without overshooting, at any frame rate", () => {
    let y = 0;
    const path: number[] = [];
    for (let i = 0; i < 60; i++) path.push((y = followStep(y, 600, 1 / 60)));
    expect(path[0]).toBeGreaterThan(0);
    expect(path[0]).toBeLessThan(200);
    expect(path.every((p, i) => p <= 600 && (i === 0 || p >= path[i - 1]))).toBe(true);
    expect(path.at(-1)).toBe(600);
    const after = (fps: number) => {
      let p = 0;
      for (let i = 0; i < fps * 0.1; i++) p = followStep(p, 600, 1 / fps);
      return p;
    };
    expect(Math.abs(after(30) - after(120))).toBeLessThan(25);
  });

  it("follows growing content, stops when the reader scrolls up, and comes back on request", () => {
    const observers: (() => void)[] = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
      disconnect() {}
    };
    const box = { top: 0, height: 1000, client: 200 };
    let api!: ReturnType<typeof useStickToBottom<HTMLDivElement, HTMLDivElement>>;
    function List() {
      api = useStickToBottom();
      return (
        <div ref={api.scrollRef} data-testid="scroll">
          <div ref={api.contentRef} />
        </div>
      );
    }
    const view = render(<List />);
    const el = view.getByTestId("scroll");
    Object.defineProperty(el, "scrollHeight", { get: () => box.height });
    Object.defineProperty(el, "clientHeight", { get: () => box.client });
    Object.defineProperty(el, "scrollTop", { get: () => box.top, set: (v: number) => (box.top = Math.max(0, Math.min(v, box.height - box.client))) });
    const grow = (h: number) => act(() => {
      box.height = h;
      observers.forEach((cb) => cb());
    });

    grow(1000); // what was there when the list opened: at the bottom at once
    expect(box.top).toBe(800);
    grow(1300); // more text: a glide, not a jump
    expect(box.top).toBe(800);
    runFor(0.05);
    expect(box.top).toBeGreaterThan(800);
    expect(box.top).toBeLessThan(1100);
    runFor(1);
    expect(box.top).toBe(1100);

    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      box.top = 700;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(api.away).toBe(true);
    grow(1600);
    runFor(0.5);
    expect(box.top).toBe(700); // the reader's place is kept
    expect(api.missed).toBe(true);

    act(() => api.scrollToBottom(true));
    expect(api.away).toBe(false);
    runFor(1);
    expect(box.top).toBe(1400);
  });
});
