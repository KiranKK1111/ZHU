import { Loader2 } from "lucide-react";
import { useSession } from "@/app/state/session";
import { useTicker } from "@/hooks/useMisc";
import type { ListeningStatus } from "@/types/engine";
import { cn } from "@/utils/cn";
import { formatClock } from "@/utils/format";

/** Elapsed recording time, extrapolated between listening.status updates. */
export function useElapsedMs(): number {
  const listening = useSession((s) => s.listening);
  const updatedAt = useSession((s) => s.listeningUpdatedAt);
  useTicker(listening?.state === "listening", 1000);
  if (!listening) return 0;
  const drift = listening.state === "listening" ? performance.now() - updatedAt : 0;
  return listening.elapsed_ms + Math.max(0, drift);
}

export function statusText(s: ListeningStatus | null): string {
  switch (s?.state) {
    case "listening":
      return "Live";
    case "paused":
      return "Paused";
    case "loading_model":
      return "Loading model";
    case "error":
      return "Error";
    default:
      return "Not recording";
  }
}

/**
 * The recording state is always conveyed through text (and aria-live), never by
 * color alone (UI prompt §25).
 */
export function RecordingIndicator({ showElapsed = false, size = "md", className }: { showElapsed?: boolean; size?: "sm" | "md"; className?: string }) {
  const listening = useSession((s) => s.listening);
  const elapsed = useElapsedMs();
  const state = listening?.state ?? "idle";
  const text = statusText(listening);
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Recording status: ${text}${showElapsed && state !== "idle" ? `, ${formatClock(elapsed)}` : ""}`}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium",
        size === "sm" ? "h-6 px-2 text-caption" : "h-7 px-2.5 text-secondary",
        state === "listening" && "border-transparent bg-recording-soft text-recording",
        state === "paused" && "border-transparent bg-warning-soft text-warning",
        state === "loading_model" && "border-transparent bg-accent-soft text-accent",
        state === "error" && "border-transparent bg-danger-soft text-danger",
        state === "idle" && "border-border-subtle bg-surface-2 text-fg-2",
        className,
      )}
    >
      {state === "loading_model" ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : (
        <span
          aria-hidden
          className={cn(
            "inline-block rounded-full",
            size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2",
            state === "listening" && "zhu-pulse-dot bg-recording",
            state === "paused" && "bg-warning",
            state === "error" && "bg-danger",
            state === "idle" && "bg-fg-3",
          )}
        />
      )}
      <span>{text}</span>
      {showElapsed && state !== "idle" && state !== "loading_model" ? <span className="tabular-nums opacity-80">{formatClock(elapsed)}</span> : null}
    </span>
  );
}
