import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { MARK_URL } from "@/components/layout/Logo";
import { onShellEvent, shell } from "@/services/shell";
import { cn } from "@/utils/cn";

interface Recording {
  recording: boolean;
  paused: boolean;
}

/** Movement (px) before a press becomes a drag; less than this is a click. */
const DRAG_THRESHOLD = 4;

/**
 * The floating icon shown while the main window is minimized (window "bubble", see
 * src-tauri/src/bubble.rs). Click: open ZHU again. Drag: move the icon. A dot shows when ZHU is
 * recording (red) or paused (amber).
 */
export default function BubbleApp() {
  const [state, setState] = useState<Recording>({ recording: false, paused: false });
  const press = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void shell.recordingState().then(setState).catch(() => undefined);
    const off = onShellEvent<Recording>("zhu://recording", setState);
    // The shell asks "are you there?" every couple of seconds while the icon is shown; if the
    // answers stop, it rebuilds the icon (bubble.rs). Answering an event, rather than reporting on
    // a timer, keeps working when the browser engine slows the timers of a covered window.
    const beat = () => void shell.bubbleAlive().catch(() => undefined);
    beat();
    const ping = onShellEvent("zhu://bubble-ping", beat);
    return () => {
      void off.then((f) => f());
      void ping.then((f) => f());
    };
  }, []);

  const label = state.recording ? (state.paused ? "ZHU: recording paused. Click to open" : "ZHU: recording. Click to open") : "Open ZHU";

  return (
    <div className="flex h-full w-full items-center justify-center" onContextMenu={(e) => e.preventDefault()}>
      <button
        type="button"
        aria-label={label}
        title={`${label} · drag to move`}
        onPointerDown={(e) => {
          if (e.button === 0) press.current = { x: e.screenX, y: e.screenY };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (!p || Math.hypot(e.screenX - p.x, e.screenY - p.y) < DRAG_THRESHOLD) return;
          press.current = null;
          void getCurrentWindow().startDragging(); // Windows moves the window until the button is released
        }}
        onPointerUp={() => {
          if (!press.current) return;
          press.current = null;
          void shell.showMain();
        }}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && void shell.showMain()}
        className="zhu-bubble relative h-[52px] w-[52px] rounded-[14px] outline-none"
      >
        <img src={MARK_URL} alt="" draggable={false} className="pointer-events-none h-full w-full select-none" />
        {state.recording ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
            {!state.paused ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-recording opacity-60" /> : null}
            <span className={cn("relative inline-flex h-3 w-3 rounded-full border-2 border-white", state.paused ? "bg-warning" : "bg-recording")} />
          </span>
        ) : null}
      </button>
    </div>
  );
}
