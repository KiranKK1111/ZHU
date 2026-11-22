// @vitest-environment node
/**
 * Opt-in contract test against a running engine:
 *   ZHU_ENGINE_TOKEN=<token> python -m zhu_engine      (prints ZHU_ENGINE_READY port=<n>)
 *   ZHU_ENGINE_PORT=<n> ZHU_ENGINE_TOKEN=<token> npm test
 * It exercises the real api client and EventStream (auth subprotocol, hello/replay, dispatch types).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, EngineHttpError, setConnection } from "@/services/engine";
import { EventStream } from "@/services/eventStream";
import type { Envelope, HelloAck, Question } from "@/types/engine";

const port = Number(process.env.ZHU_ENGINE_PORT);
const token = process.env.ZHU_ENGINE_TOKEN ?? "";
const enabled = !!port && !!token;

describe.skipIf(!enabled)("engine contract (live)", () => {
  let sessionId = "";
  beforeAll(async () => {
    const ws = await import("ws");
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws.WebSocket;
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    setConnection({ port, token });
  });
  afterAll(async () => {
    if (sessionId) await api.deleteSession(sessionId).catch(() => undefined);
  });

  it("rejects a wrong token", async () => {
    setConnection({ port, token: "x".repeat(43) });
    await expect(api.settings()).rejects.toBeInstanceOf(EngineHttpError);
    setConnection({ port, token });
  });

  it("settings, models, providers", async () => {
    const s = await api.settings();
    expect(s.transcription.model).toBeTypeOf("string");
    const m = await api.models();
    expect(Array.isArray(m.catalog)).toBe(true);
    expect(typeof m.setup_required).toBe("boolean");
    const p = await api.providers();
    expect(p.map((x) => x.id)).toEqual(expect.arrayContaining(["gemini", "groq", "openrouter", "chatgpt", "claude", "custom"]));
    expect(p.filter((x) => x.free_tier).map((x) => x.id)).toEqual(["gemini", "groq", "openrouter"]);
  });

  it("streams question events over the authenticated WebSocket", async () => {
    const session = await api.createSession("Contract test");
    sessionId = session.id;
    const received: Envelope[] = [];
    let ack: HelloAck | null = null;
    const stream = new EventStream({ port, token }, { onEnvelopes: (b) => received.push(...b), onHello: (a) => (ack = a), onStatus: () => undefined });
    stream.start();
    await waitFor(() => !!ack);
    const created = await api.createQuestion(sessionId, "what is the difference between double equals and triple equals in javascript");
    expect(created[0].formatted_text).toBe("What is the difference between == and === in JavaScript?");
    await waitFor(() => received.some((e) => e.event_type === "question.created"));
    const q = received.find((e) => e.event_type === "question.created")!.data as Question;
    expect(q.session_id).toBe(sessionId);
    expect(q.category).toBe("JAVASCRIPT");
    const seqs = received.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    stream.stop();

    const listed = await api.questions(sessionId);
    expect(listed).toHaveLength(1);
    const edited = await api.editQuestion(q.question_id, "What is the difference between == and === in JS?");
    expect(edited[0].state).toBe("MANUALLY_EDITED");
    const md = await api.exportSession(sessionId, "md");
    expect(String(md)).toContain("Contract test");
  });
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
