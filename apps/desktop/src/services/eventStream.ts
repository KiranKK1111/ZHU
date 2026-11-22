/**
 * One WebSocket per window. It authenticates with the bearer.<token> subprotocol,
 * replays from the last seq after a reconnect, drops duplicates, reconnects with
 * backoff, and batches envelopes into animation frames.
 */
import type { Envelope, HelloAck } from "@/types/engine";
import { backoffMs, EnvelopeFilter } from "@/utils/wsProtocol";
import type { Connection } from "./engine";

export type StreamStatus = "connecting" | "open" | "closed";

export interface EventStreamHandlers {
  onEnvelopes: (batch: Envelope[]) => void;
  onHello: (ack: HelloAck, invalidate: boolean) => void;
  onStatus: (status: StreamStatus) => void;
}

export class EventStream {
  private ws: WebSocket | null = null;
  private filter = new EnvelopeFilter();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Envelope[] = [];
  private flushScheduled = false;
  private closed = false;

  constructor(private conn: Connection, private handlers: EventStreamHandlers) {}

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
  }

  private open(): void {
    this.handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.conn.port}/ws`, ["zhu.v1", `bearer.${this.conn.token}`]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let helloSeen = false;
    ws.onopen = () => {
      ws.send(JSON.stringify(this.filter.helloMessage()));
    };
    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (!helloSeen && msg && typeof msg === "object" && (msg as { type?: string }).type === "hello.ack") {
        helloSeen = true;
        this.attempt = 0;
        const ack = msg as HelloAck;
        const invalidate = this.filter.onHello(ack);
        this.handlers.onStatus("open");
        this.handlers.onHello(ack, invalidate);
        return;
      }
      const env = msg as Envelope;
      if (!this.filter.accept(env)) return;
      this.queue.push(env);
      this.scheduleFlush();
    };
    ws.onclose = () => {
      this.ws = null;
      this.handlers.onStatus("closed");
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = backoffMs(this.attempt++);
    this.timer = setTimeout(() => this.open(), delay);
  }

  /**
   * Flush on the next frame. A hidden window gets no frames and its timers are throttled to one
   * per second or slower, yet questions must still reach the chat tabs promptly while the main
   * window is minimized or in the tray, so a hidden window flushes in a microtask instead.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    let done = false;
    const flush = () => {
      if (done) return;
      done = true;
      this.flushScheduled = false;
      const batch = this.queue;
      this.queue = [];
      if (batch.length) this.handlers.onEnvelopes(batch);
    };
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      queueMicrotask(flush);
      return;
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    setTimeout(flush, 100);
  }
}
