import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, CircleStop, Mic, Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { Button, IconButton } from "@/components/primitives/Button";
import { Menu, MenuContent, MenuLabel, MenuOption, MenuSeparator, MenuTrigger } from "@/components/primitives/Menu";
import { Tip } from "@/components/primitives/Tooltip";
import { RecordingIndicator } from "@/components/transcription/RecordingIndicator";
import { useEngineSettings } from "@/features/settings/useEngineSettings";
import { useListeningActions } from "@/hooks/useActions";
import { api } from "@/services/engine";
import { acceleratorLabel } from "@/utils/hotkeys";
import { LISTEN_SOURCES, listenSources, listenSourcesList, listenSourcesOption, listenSourcesPatch, type ListenSources } from "@/utils/listenSources";

/**
 * Listening, in the title bar, so it is at hand on every screen: Start listening when idle, which
 * asks what to listen to (system audio, the microphone, or both); while listening, the live state
 * with Pause (or Resume) and Stop. The state is always
 * written out (RecordingIndicator), never shown by colour alone.
 */
export function ListeningControl() {
  const listening = useSession((s) => s.listening);
  const actions = useListeningActions();
  const models = useQuery({ queryKey: qk.models, queryFn: api.models, staleTime: 60_000 });
  const { settings, update } = useEngineSettings();
  const setSetupOpen = useNav((s) => s.setSetupOpen);
  const hotkey = usePrefs((p) => p.hotkeys.toggle_listening);
  const state = listening?.state ?? "idle";
  const live = state === "listening" || state === "paused";
  const noModel = !!models.data?.setup_required;
  const shortcut = acceleratorLabel(hotkey);
  const sources = settings ? listenSources(settings.audio) : null;

  // A failure while listening is said once, whatever screen is open.
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

  // Listening to what was chosen; the hotkey and the tray start with the last choice.
  const startWith = async (choice: ListenSources) => {
    if (choice !== sources) await update(listenSourcesPatch(choice), true);
    await actions.start(listenSourcesList(choice));
  };
  const heard = listening?.sources ? Object.keys(listening.sources) : [];
  const listeningTo: ListenSources | null = heard.length === 2 ? "both" : heard[0] === "system" || heard[0] === "microphone" ? heard[0] : sources;

  return (
    <div className="flex items-center gap-1">
      {live ? (
        <>
          <Tip label={listeningTo ? `Listening to ${listenSourcesOption(listeningTo).listensTo}` : "Listening"}>
            <span className="inline-flex">
              <RecordingIndicator showElapsed size="sm" />
            </span>
          </Tip>
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
          {state === "loading_model" ? (
            <Button size="sm" variant="primary" loading>
              Getting ready…
            </Button>
          ) : (
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm" variant="primary" icon={<Play className="h-3.5 w-3.5" />}>
                  Start listening
                  <ChevronDown className="-mr-0.5 h-3.5 w-3.5 opacity-80" aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent align="end" className="w-[320px]">
                <MenuLabel>Listen to</MenuLabel>
                {LISTEN_SOURCES.map((o) => (
                  <MenuOption
                    key={o.value}
                    icon={<ListenSourcesIcons value={o.value} className="h-4 w-4" />}
                    title={o.label}
                    description={o.description}
                    marked={o.value === sources}
                    markLabel="(last used)"
                    onSelect={() => void startWith(o.value)}
                  />
                ))}
                {shortcut ? (
                  <>
                    <MenuSeparator />
                    <div className="px-2.5 pb-1 pt-0.5 text-caption text-fg-3">{shortcut} starts with the ticked one</div>
                  </>
                ) : null}
              </MenuContent>
            </Menu>
          )}
        </>
      )}
    </div>
  );
}

/** The icons of a choice: a speaker for system audio, a microphone, or both. */
export function ListenSourcesIcons({ value, className = "h-3.5 w-3.5" }: { value: ListenSources; className?: string }) {
  return (
    <>
      {value !== "microphone" ? <Volume2 className={className} aria-hidden /> : null}
      {value !== "system" ? <Mic className={className} aria-hidden /> : null}
    </>
  );
}
