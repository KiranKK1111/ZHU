import { ChevronDown, ChevronUp, Maximize2, MousePointerClick, Pause, Pin, Play, Settings2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { usePrefs } from "@/app/state/prefs";
import { latestQuestion, useQuestions } from "@/app/state/questions";
import { useSession } from "@/app/state/session";
import { useTranscript } from "@/app/state/transcript";
import { toast } from "@/app/state/ui";
import { Logo } from "@/components/layout/Logo";
import { Button, IconButton } from "@/components/primitives/Button";
import { Slider, Switch } from "@/components/primitives/Controls";
import { Kbd } from "@/components/primitives/Kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Menu";
import { QuestionCard } from "@/components/questions/QuestionCard";
import { RecordingIndicator, useElapsedMs } from "@/components/transcription/RecordingIndicator";
import { TranscriptView } from "@/components/transcription/TranscriptView";
import { openInWorkspace, useListeningActions } from "@/hooks/useActions";
import { useCurrentSession } from "@/hooks/useSessionData";
import { inTauri, shell } from "@/services/shell";
import { errorMessage, formatClock } from "@/utils/format";

export function SidecarHeader({ onCompact }: { onCompact: () => void }) {
  return (
    <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
      <Logo size={18} withWordmark />
      <span data-tauri-drag-region className="flex-1" />
      <RecordingIndicator size="sm" />
      <SidecarSettings />
      <IconButton label="Collapse to compact bar" size="sm" onClick={onCompact}>
        <ChevronUp className="h-4 w-4" />
      </IconButton>
      {inTauri ? (
        <IconButton label="Hide sidecar" size="sm" onClick={() => void shell.hideSidecar()}>
          <X className="h-4 w-4" />
        </IconButton>
      ) : null}
    </header>
  );
}

function SidecarSettings() {
  const opacity = usePrefs((p) => p.sidecarOpacity);
  const onTop = usePrefs((p) => p.sidecarAlwaysOnTop);
  const hotkey = usePrefs((p) => p.hotkeys.toggle_click_through);
  const set = usePrefs((p) => p.set);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label="Sidecar settings" size="sm">
          <Settings2 className="h-4 w-4" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-1.5 flex justify-between text-secondary">
              <span className="text-fg">Opacity</span>
              <span className="tabular-nums text-fg-3">{Math.round(opacity * 100)}%</span>
            </div>
            <Slider label="Sidecar opacity" value={opacity} min={0.4} max={1} step={0.01} onValueChange={(v) => set({ sidecarOpacity: Math.round(v * 100) / 100 })} />
          </div>
          {inTauri ? (
            <>
              <label className="flex items-center justify-between gap-3 text-secondary text-fg">
                <span className="flex items-center gap-1.5">
                  <Pin className="h-3.5 w-3.5 text-fg-3" /> Always on top
                </span>
                <Switch
                  checked={onTop}
                  label="Always on top"
                  onCheckedChange={async (v) => {
                    try {
                      await shell.setSidecarAlwaysOnTop(v);
                      set({ sidecarAlwaysOnTop: v });
                    } catch (err) {
                      toast.error("Could not change sidecar", errorMessage(err));
                    }
                  }}
                />
              </label>
              <div className="flex flex-col gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<MousePointerClick className="h-3.5 w-3.5" />}
                  onClick={() => void shell.setClickThrough(true).catch((e) => toast.error("Click-through unavailable", errorMessage(e)))}
                >
                  Enable click-through
                </Button>
                <p className="text-caption text-fg-3">
                  The sidecar ignores the mouse until you press <Kbd>{hotkey}</Kbd> or use the tray menu.
                </p>
              </div>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function SidecarTranscript() {
  const order = useTranscript((s) => s.order);
  const byId = useTranscript((s) => s.byId);
  const lines = 6;
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => order.slice(-(expanded ? lines * 3 : lines)).map((id) => byId[id]).filter(Boolean), [order, byId, lines, expanded]);
  const listening = useSession((s) => s.listening?.state);
  return (
    <section aria-label="Live transcript" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pt-2">
        <h2 className="text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">Live transcript</h2>
        <IconButton label={expanded ? "Show fewer lines" : "Show more lines"} size="sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </IconButton>
      </div>
      <TranscriptView
        items={items}
        compact
        className="min-h-0 flex-1"
        emptyState={<p className="px-3 py-3 text-secondary text-fg-3">{listening === "listening" ? "Listening…" : "Start a session to view live transcription."}</p>}
      />
    </section>
  );
}

export function SidecarLatestQuestion() {
  const byId = useQuestions((s) => s.byId);
  const q = useMemo(() => latestQuestion({ byId }), [byId]);
  if (!q) return null;
  return (
    <section aria-label="Detected question" className="shrink-0 border-t border-border-subtle p-2.5">
      <h2 className="mb-1.5 px-0.5 text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">Detected question</h2>
      <QuestionCard question={q} variant="compact" onOpenInWorkspace={() => void openInWorkspace("home", q.question_id)} />
    </section>
  );
}

export function ListeningButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const state = useSession((s) => s.listening?.state ?? "idle");
  const actions = useListeningActions();
  if (state === "listening")
    return (
      <Button size={size} variant="secondary" icon={<Pause className="h-3.5 w-3.5" />} onClick={() => void actions.pause()}>
        Pause
      </Button>
    );
  if (state === "paused")
    return (
      <Button size={size} variant="primary" icon={<Play className="h-3.5 w-3.5" />} onClick={() => void actions.resume()}>
        Resume
      </Button>
    );
  return (
    <Button size={size} variant="primary" icon={<Play className="h-3.5 w-3.5" />} loading={state === "loading_model"} onClick={() => void actions.start()}>
      {state === "loading_model" ? "Loading" : "Start"}
    </Button>
  );
}

export function SidecarFooter() {
  const session = useCurrentSession();
  const elapsed = useElapsedMs();
  const listening = useSession((s) => s.listening);
  const live = listening && listening.state !== "idle";
  return (
    <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-border-subtle px-3">
      <ListeningButton />
      <span className="min-w-0 flex-1 truncate text-caption text-fg-3" title={session.data?.name}>
        {session.data ? session.data.name : "No session"}
      </span>
      {live ? <span className="text-caption tabular-nums text-fg-2" aria-label={`Elapsed ${formatClock(elapsed)}`}>{formatClock(elapsed)}</span> : null}
      <IconButton label="Open workspace" size="sm" onClick={() => void openInWorkspace("home")}>
        <Maximize2 className="h-3.5 w-3.5" />
      </IconButton>
    </footer>
  );
}

/** Compact mode (UI prompt §13): ZHU ● Live 04:32 ⌄ */
export function SidecarCompactBar({ onExpand }: { onExpand: () => void }) {
  const state = useSession((s) => s.listening?.state ?? "idle");
  const actions = useListeningActions();
  return (
    <div data-tauri-drag-region className="flex h-[46px] items-center gap-2 px-3">
      <Logo size={18} withWordmark />
      <RecordingIndicator size="sm" showElapsed />
      <span data-tauri-drag-region className="flex-1" />
      {state === "listening" ? (
        <IconButton label="Pause listening" size="sm" onClick={() => void actions.pause()}>
          <Pause className="h-4 w-4" />
        </IconButton>
      ) : state === "paused" ? (
        <IconButton label="Resume listening" size="sm" onClick={() => void actions.resume()}>
          <Play className="h-4 w-4" />
        </IconButton>
      ) : null}
      <IconButton label="Expand sidecar" size="sm" onClick={onExpand}>
        <ChevronDown className="h-4 w-4" />
      </IconButton>
    </div>
  );
}
