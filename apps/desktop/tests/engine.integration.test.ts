// @vitest-environment node
/**
 * Contract test against a real engine: the api client and EventStream as the app uses them
 * (token check, auth subprotocol, hello/replay, the shapes of what comes back).
 *
 * The test starts its own engine from the repository's virtualenv (engine/.venv) on a throwaway
 * data folder, and stops it afterwards; the engine also stops by itself when this process ends.
 * To test against an engine that is already running instead, give its address:
 *   ZHU_ENGINE_PORT=<n> ZHU_ENGINE_TOKEN=<token> npm test
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, EngineHttpError, setConnection } from "@/services/engine";
import { EventStream } from "@/services/eventStream";
import type { Envelope, HelloAck, Question } from "@/types/engine";

let port = Number(process.env.ZHU_ENGINE_PORT);
let token = process.env.ZHU_ENGINE_TOKEN ?? "";
let engine: ChildProcess | null = null;
let dataDir = "";

/** Start the engine from engine/.venv and wait for the line that says which port it listens on. */
async function startEngine(): Promise<void> {
  const engineDir = resolve(process.cwd(), "..", "..", "engine");
  const python = join(engineDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!existsSync(python)) throw new Error(`The engine's virtualenv is missing (${python}). Set it up first: docs/INSTALLATION.md, Developers.`);
  token = randomBytes(24).toString("hex");
  dataDir = mkdtempSync(join(tmpdir(), "zhu-contract-"));
  const child = spawn(python, ["-m", "zhu_engine"], {
    cwd: engineDir,
    env: { ...process.env, ZHU_ENGINE_TOKEN: token, ZHU_DATA_DIR: dataDir, ZHU_PARENT_PID: String(process.pid), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  engine = child;
  port = await new Promise<number>((ready, failed) => {
    let said = "";
    const give = (reason: string) => failed(new Error(`${reason}. The engine said:\n${said.slice(-2000) || "(nothing)"}`));
    const timer = setTimeout(() => give("The engine was not ready after 90 seconds"), 90_000);
    const read = (chunk: Buffer) => {
      said += chunk.toString();
      const line = /ZHU_ENGINE_READY port=(\d+)/.exec(said);
      if (line) {
        clearTimeout(timer);
        ready(Number(line[1]));
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (e) => (clearTimeout(timer), give(`The engine could not be started (${e.message})`)));
    child.once("exit", (code) => (clearTimeout(timer), give(`The engine stopped before it was ready (exit code ${code})`)));
  });
}

describe("engine contract (live)", () => {
  let sessionId = "";
  beforeAll(async () => {
    if (!port || !token) await startEngine();
    const ws = await import("ws");
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws.WebSocket;
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    setConnection({ port, token });
  }, 120_000);
  afterAll(async () => {
    if (sessionId) await api.deleteSession(sessionId).catch(() => undefined);
    if (engine) {
      const gone = new Promise((r) => engine!.once("exit", r));
      engine.kill();
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
      // The engine's files can stay locked for a moment after it has gone.
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      } catch {
        /* a leftover folder in the temp directory is harmless */
      }
    }
  }, 30_000);

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
    // Providers with a free tier, and the two that answer without a key (the list grows over time).
    expect(p.filter((x) => x.free_tier).map((x) => x.id)).toEqual(expect.arrayContaining(["gemini", "groq", "openrouter", "kilo", "pollinations"]));
    expect(p.filter((x) => x.free_tier && !x.key_required).map((x) => x.id)).toEqual(["kilo", "pollinations"]);
    expect(p.find((x) => x.id === "chatgpt")?.free_tier).toBe(false);
    // What the model list needs for its icons: null until a provider's own list has been read.
    for (const x of p) expect(x.config.model_inputs ?? null).toBeNull();
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
