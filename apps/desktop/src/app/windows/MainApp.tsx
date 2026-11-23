import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { EngineGate } from "@/app/providers/EngineGate";
import { useOpacitySync } from "@/app/state/opacity";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { isRecording, useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { useWebChat } from "@/app/state/webchat";
import { AppShell } from "@/components/layout/AppShell";
import { ModelSetup } from "@/components/setup/ModelSetup";
import { useCaptureActions, useListeningActions, useQuestionActions } from "@/hooks/useActions";
import { useEventStream } from "@/hooks/useEventStream";
import { useLatest } from "@/hooks/useMisc";
import { useSessionData } from "@/hooks/useSessionData";
import { api } from "@/services/engine";
import { inTauri, onShellEvent, shell } from "@/services/shell";
import { preloadTargetTabs } from "@/services/webchatDelivery";
import { useModelSync } from "@/features/chat/useModelChoice";
import { HOTKEY_LABELS, type HotkeyAction, type TrayAction, type WebChatEvent } from "@/types/shell";
import { errorMessage } from "@/utils/format";

/** The graphics driver warning has been shown since ZHU started. */
let gpuWarned = false;

export default function MainApp() {
  useOpacitySync(); // before the engine is ready too: the window itself is see-through or not
  return (
    <EngineGate>
      <MainConnected />
    </EngineGate>
  );
}

function MainConnected() {
  useEventStream("main");
  useSessionData();
  useShellIntegration();
  const models = useQuery({ queryKey: qk.models, queryFn: api.models, staleTime: 60_000 });
  const skipped = usePrefs((p) => p.modelSetupSkipped);
  const setupOpen = useNav((s) => s.setupOpen);
  const setSetupOpen = useNav((s) => s.setSetupOpen);

  // One-time first-run setup: only while no model is installed and the user has not skipped it.
  const firstRun = !!models.data?.setup_required && !skipped;

  // A graphics card without its driver is said once per start (the setup screen and Settings →
  // Listening show the whole warning, with where to get the driver).
  const gpuWarning = models.data?.gpu.warning;
  useEffect(() => {
    if (!gpuWarning || gpuWarned || firstRun) return;
    gpuWarned = true;
    toast.error(gpuWarning.title, "Settings → Listening says what to do.");
  }, [gpuWarning, firstRun]);

  // Wait for the model status so the workspace never flashes before first-run setup.
  if (models.isLoading) return <div className="h-full bg-bg" aria-busy />;

  if (firstRun || (setupOpen && models.data)) {
    return (
      <ModelSetup
        status={models.data!}
        onDone={() => {
          setSetupOpen(false);
          void models.refetch();
        }}
        onSkip={() => {
          usePrefs.getState().set({ modelSetupSkipped: true });
          setSetupOpen(false);
        }}
        dismissible={!firstRun}
      />
    );
  }
  return <AppShell />;
}

/** Hotkeys, tray actions, tray state, close-to-tray and cross-window navigation. */
function useShellIntegration() {
  const listening = useListeningActions();
  const capture = useCaptureActions();
  const questions = useQuestionActions();
  const hotkeys = usePrefs((p) => p.hotkeys);
  const closeToTray = usePrefs((p) => p.closeToTray);
  const state = useSession((s) => s.listening?.state);
  const actions = useLatest({ listening, capture, questions });

  useEffect(() => {
    if (!inTauri) return;
    const recording = isRecording(useSession.getState().listening);
    void shell.setTrayState(recording, state === "paused").catch(() => undefined);
  }, [state]);

  useEffect(() => {
    if (!inTauri) return;
    void shell.setCloseToTray(closeToTray).catch(() => undefined);
  }, [closeToTray]);

  const freezePointer = usePrefs((p) => p.freezePointer);
  useEffect(() => {
    if (!inTauri) return;
    void shell.setFreezePointer(freezePointer).catch(() => undefined);
  }, [freezePointer]);

  const minimizeToBubble = usePrefs((p) => p.minimizeToBubble);
  useEffect(() => {
    if (!inTauri) return;
    void shell.setMinimizeBubble(minimizeToBubble).catch(() => undefined);
  }, [minimizeToBubble]);

  // Listening started: load the chat tabs that will receive questions, so the first one is not
  // delayed by a page load.
  useEffect(() => {
    if (state === "listening") preloadTargetTabs();
  }, [state]);

  useModelSync(); // Home answers with the model chosen in Custom chat

  useEffect(() => {
    if (!inTauri) return;
    void shell
      .setHotkeys(hotkeys)
      .then((res) => {
        const failed = Object.entries(res ?? {}).filter(([, v]) => v);
        if (failed.length) {
          const names = failed.map(([k, v]) => `${HOTKEY_LABELS[k as HotkeyAction] ?? k}: ${v}`).join("; ");
          toast.error(failed.length === 1 ? "A keyboard shortcut is not available" : "Some keyboard shortcuts are not available", `${names}. Choose other keys in Settings → App → Keyboard shortcuts.`);
        }
      })
      .catch((err) => toast.error("Shortcuts unavailable", errorMessage(err)));
  }, [hotkeys]);

  useEffect(() => {
    const offs: Promise<() => void>[] = [];
    offs.push(
      onShellEvent<{ action: HotkeyAction }>("zhu://hotkey", ({ action }) => {
        const a = actions.current;
        if (action === "toggle_listening") void a.listening.toggle();
        if (action === "capture_screen") void a.capture.screen("monitor");
        if (action === "copy_latest_question") void a.questions.copyLatest();
      }),
    );
    offs.push(
      onShellEvent<{ action: TrayAction }>("zhu://tray", ({ action }) => {
        const a = actions.current;
        if (action === "toggle_listening") void a.listening.toggle();
        if (action === "open_settings") useNav.getState().navigate("settings");
        if (action === "new_session") void a.listening.newSession();
      }),
    );
    // Page loads and titles of the embedded chat tabs (tracked on every screen, since questions
    // are delivered to the tabs in the background).
    offs.push(
      onShellEvent<WebChatEvent>("zhu://webchat", (e) => {
        const patch = useWebChat.getState().patch;
        if (e.kind === "title") patch(e.id, { loaded: true, title: e.title, url: e.url });
        else patch(e.id, { loaded: true, loading: e.kind === "loading", url: e.url });
      }),
    );
    if (inTauri) {
      // After a reload of this window no chat page may stay on top of whatever screen comes up;
      // the AI chats screen shows its tab again when it mounts.
      if (useNav.getState().route !== "webchats") void shell.webchatHide().catch(() => undefined);
      void shell
        .webchatTabs()
        .then((tabs) => tabs.forEach((t) => useWebChat.getState().patch(t.id, { loaded: true, loading: t.loading, url: t.url })))
        .catch(() => undefined);
    }
    return () => {
      for (const p of offs) void p.then((off) => off());
    };
  }, [actions]);
}
