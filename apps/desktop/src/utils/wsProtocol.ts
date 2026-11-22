/**
 * Event-stream ordering and idempotency (ARCHITECTURE.md §5.1). Pure and unit tested.
 *
 * - Envelopes carry a strictly increasing `seq` per engine instance.
 * - Duplicates and out-of-order replays (seq <= lastSeq) are dropped.
 * - When the engine instance changes (restart) or the server reports a replay gap,
 *   the client must refetch all REST state.
 */
import type { Envelope, HelloAck } from "@/types/engine";

export class EnvelopeFilter {
  lastSeq = 0;
  instance: string | null = null;

  /** Handle hello.ack. Returns true when cached state must be invalidated. */
  onHello(ack: Pick<HelloAck, "instance" | "seq" | "gap">): boolean {
    const changed = this.instance !== null && this.instance !== ack.instance;
    if (changed) this.lastSeq = 0;
    this.instance = ack.instance;
    return changed || ack.gap;
  }

  /** True if the envelope is new and must be processed. */
  accept(env: Pick<Envelope, "seq">): boolean {
    if (typeof env.seq !== "number" || env.seq <= this.lastSeq) return false;
    this.lastSeq = env.seq;
    return true;
  }

  helloMessage(): { type: "hello"; last_seq: number; instance: string | null } {
    return { type: "hello", last_seq: this.lastSeq, instance: this.instance };
  }
}

/** Exponential backoff with jitter, capped. attempt starts at 0. */
export function backoffMs(attempt: number, base = 400, cap = 8000, random: () => number = Math.random): number {
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}
