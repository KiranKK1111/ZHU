import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CircleStop, Mic, Pause, Play, Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { Button, IconButton } from "@/components/primitives/Button";
import { Tip } from "@/components/primitives/Tooltip";
import { RecordingIndicator } from "@/components/transcription/RecordingIndicator";
import { useListeningActions } from "@/hooks/useActions";
import { api } from "@/services/engine";
import { acceleratorLabel } from "@/utils/hotkeys";

/**
 * Listening, in the title bar, so it is at hand on every screen: Start listening when idle;
 * while listening, the live state with Pause (or Resume) and Stop; New session when nothing is
 * being recorded. The state is always written out (RecordingIndicator), never shown by colour alone.
 */
export function ListeningControl() {
  const listening = useSession((s) => s.listening);
  const sessionId = useSession((s) => s.currentSessionId);
  const actions = useListeningActions();
  const models = useQuery({ queryKey: qk.models, queryFn: api.models, staleTime: 60_000 });
  const setSetupOpen = useNav((s) => s.setSetupOpen);
  const hotkey = usePrefs((p) => p.hotkeys.toggle_listening);
  const state = listening?.state ?? "idle";
  const live = state === "listening" || state === "paused";
  const noModel = !!models.data?.setup_required;
  const shortcut = acceleratorLabel(hotkey);

  // A failure while listening is said once, whatever screen is open (it used to show on Home only).
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (state !== "error") {
      told.current = null;
      return;
    }
    const message = listening?.message ?? "Listening stopped.";
    if (told.current !== message) {
      told.current = message;
      toast.error("Listening stopped", message);
    }
  }, [state, listening?.message]);

  if (noModel && !live) {
    return (
      <Button size="sm" variant="primary" icon={<Mic className="h-3.5 w-3.5" />} onClick={() => setSetupOpen(true)}>
        Set up speech recognition
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {live ? (
        <>
          <RecordingIndicator showElapsed size="sm" />
          {state === "listening" ? (
            <IconButton label="Pause listening" shortcut={shortcut} onClick={() => void actions.pause()}>
              <Pause className="h-4 w-4" />
            </IconButton>
          ) : (
            <IconButton label="Resume listening" shortcut={shortcut} onClick={() => void actions.resume()}>
              <Play className="h-4 w-4" />
            </IconButton>
          )}
          <IconButton label="Stop listening" onClick={() => void actions.stop()}>
            <CircleStop className="h-4 w-4" />
          </IconButton>
        </>
      ) : (
        <>
          {state === "error" ? (
            <Tip label={listening?.message ?? "Listening stopped."}>
              <span className="flex h-7 items-center gap-1 rounded-full bg-danger-soft px-2 text-caption font-medium text-danger" role="status">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                Stopped
              </span>
            </Tip>
          ) : null}
          <Tip label="ZHU listens to your call and microphone, and picks out the questions" shortcut={shortcut}>
            <Button
              size="sm"
              variant="primary"
              icon={<Play className="h-3.5 w-3.5" />}
              loading={state === "loading_model"}
              onClick={() => void actions.start()}
            >
              {state === "loading_model" ? "Getting ready…" : "Start listening"}
            </Button>
          </Tip>
          {sessionId && state !== "loading_model" ? (
            <IconButton label="New session: a fresh, empty one" onClick={() => void actions.newSession()}>
              <Plus className="h-4 w-4" />
            </IconButton>
          ) : null}
        </>
      )}
    </div>
  );
}
