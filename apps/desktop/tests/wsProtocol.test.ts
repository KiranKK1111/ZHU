import { describe, expect, it } from "vitest";
import { backoffMs, EnvelopeFilter } from "@/utils/wsProtocol";

describe("EnvelopeFilter", () => {
  it("accepts strictly increasing seq and drops duplicates and stale replays", () => {
    const f = new EnvelopeFilter();
    f.onHello({ instance: "a", seq: 0, gap: false });
    expect([1, 2, 2, 3, 1, 5, 4].map((seq) => f.accept({ seq }))).toEqual([true, true, false, true, false, true, false]);
    expect(f.lastSeq).toBe(5);
  });

  it("sends last_seq and instance in hello so the server can replay", () => {
    const f = new EnvelopeFilter();
    f.onHello({ instance: "a", seq: 0, gap: false });
    f.accept({ seq: 7 });
    expect(f.helloMessage()).toEqual({ type: "hello", last_seq: 7, instance: "a" });
  });

  it("resets and requests invalidation when the engine instance changes", () => {
    const f = new EnvelopeFilter();
    expect(f.onHello({ instance: "a", seq: 0, gap: false })).toBe(false);
    f.accept({ seq: 40 });
    expect(f.onHello({ instance: "b", seq: 3, gap: false })).toBe(true);
    expect(f.lastSeq).toBe(0);
    expect(f.accept({ seq: 1 })).toBe(true); // new instance numbers from 1 again
  });

  it("requests invalidation when the replay window has a gap", () => {
    const f = new EnvelopeFilter();
    f.onHello({ instance: "a", seq: 0, gap: false });
    expect(f.onHello({ instance: "a", seq: 9000, gap: true })).toBe(true);
  });

  it("ignores malformed envelopes", () => {
    const f = new EnvelopeFilter();
    expect(f.accept({ seq: undefined as unknown as number })).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially, is jittered, and is capped", () => {
    expect(backoffMs(0, 400, 8000, () => 0)).toBe(200);
    expect(backoffMs(0, 400, 8000, () => 1)).toBe(400);
    expect(backoffMs(3, 400, 8000, () => 1)).toBe(3200);
    expect(backoffMs(20, 400, 8000, () => 1)).toBe(8000);
    expect(backoffMs(20, 400, 8000, () => 0)).toBe(4000);
  });
});
