"""Event hub: assigns a monotonic ``seq`` to every event, keeps a bounded replay
ring, and fans events out to WebSocket subscribers through bounded queues.

A slow subscriber whose queue overflows is disconnected rather than blocking the
engine. It reconnects and replays from its last ``seq``.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections import deque
from typing import Any, Optional


class EventHub:
    def __init__(self, ring_size: int = 2000, subscriber_queue: int = 1000) -> None:
        self.instance_id = uuid.uuid4().hex[:12]
        self._seq = 0
        self._ring: deque[dict] = deque(maxlen=ring_size)
        self._subs: set[asyncio.Queue] = set()
        self._queue_size = subscriber_queue
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.Lock()
        self.on_publish = None  # optional callback(envelope) for persistence/metrics

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def publish(self, event_type: str, data: Any, session_id: Optional[str] = None) -> dict:
        """Call from the event-loop thread."""
        with self._lock:
            self._seq += 1
            env = {"seq": self._seq, "event_type": event_type, "session_id": session_id, "ts_ms": int(time.time() * 1000), "data": data}
            self._ring.append(env)
        for q in list(self._subs):
            try:
                q.put_nowait(env)
            except asyncio.QueueFull:
                self._subs.discard(q)
                q.put_nowait_overflow = True  # type: ignore[attr-defined]
        if self.on_publish:
            self.on_publish(env)
        return env

    def publish_threadsafe(self, event_type: str, data: Any, session_id: Optional[str] = None) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self.publish, event_type, data, session_id)

    def subscribe(self, last_seq: int = 0) -> tuple[asyncio.Queue, list[dict], bool]:
        """Returns (queue, replay events, gap). ``gap`` is True when events after
        last_seq were already evicted, in which case the client must refetch state."""
        q: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        with self._lock:
            replay = [e for e in self._ring if e["seq"] > last_seq] if last_seq else []
            oldest = self._ring[0]["seq"] if self._ring else self._seq + 1
            gap = bool(last_seq) and last_seq + 1 < oldest
            self._subs.add(q)
        return q, replay, gap

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    @property
    def seq(self) -> int:
        return self._seq
