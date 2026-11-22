import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useChat } from "@/app/state/chat";
import { useSession } from "@/app/state/session";
import { dispatchEnvelopes } from "@/services/dispatch";
import { getConnection, onConnectionChange, type Connection } from "@/services/engine";
import { EventStream } from "@/services/eventStream";
import type { WindowKind } from "@/types/shell";

/** One event stream per window; it is restarted when the engine connection changes. */
export function useEventStream(kind: WindowKind): void {
  const qc = useQueryClient();
  useEffect(() => {
    let stream: EventStream | null = null;
    const start = (c: Connection | null) => {
      stream?.stop();
      stream = null;
      if (!c) return;
      stream = new EventStream(c, {
        onEnvelopes: (batch) => dispatchEnvelopes(batch, qc, kind),
        onHello: (ack, invalidate) => {
          useSession.getState().setListening(ack.listening);
          if (invalidate) {
            // A different engine process: answers that were streaming are over, so chats are read again.
            useChat.getState().reset();
            void qc.invalidateQueries();
          }
        },
        onStatus: (s) => useSession.getState().setStreamStatus(s),
      });
      stream.start();
    };
    start(getConnection());
    const off = onConnectionChange(start);
    return () => {
      off();
      stream?.stop();
    };
  }, [qc, kind]);
}
