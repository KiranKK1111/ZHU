import { useQuery } from "@tanstack/react-query";
import { AppWindow, Database, FileText, Keyboard, MessageSquareText, MessagesSquare, Mic, RotateCcw, Sparkles, Trash2, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { toast, useNav } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { Segmented, Select, Switch } from "@/components/primitives/Controls";
import { ConfirmDialog, Modal } from "@/components/primitives/Dialog";
import { Badge } from "@/components/primitives/Display";
import { Textarea } from "@/components/primitives/Input";
import { Kbd } from "@/components/primitives/Kbd";
import { WebChatOptions } from "@/features/webchat/WebChatOptions";
import { useProviders } from "@/hooks/useProviders";
import { api } from "@/services/engine";
import { autostart, inTauri, shell } from "@/services/shell";
import { DEFAULT_HOTKEYS, HOTKEY_ACTIONS, HOTKEY_LABELS, type HotkeyAction } from "@/types/shell";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";
import { toAccelerator } from "@/utils/hotkeys";
import { ModelsSection } from "./ModelsSection";
import { useEngineSettings } from "./useEngineSettings";

const SECTIONS: { id: string; label: string; icon: LucideIcon; description: string }[] = [
  { id: "answers", label: "Answers", icon: Sparkles, description: "Which AI models answer, and how the answers should read." },
  { id: "listening", label: "Listening", icon: Mic, description: "What ZHU listens to. Recording starts only when you press Start listening." },
  { id: "chats", label: "Chat tabs", icon: MessagesSquare, description: "How detected questions and screenshots reach the tabs under AI chats." },
  { id: "app", label: "App", icon: AppWindow, description: "Appearance, startup and keyboard shortcuts." },
  { id: "data", label: "Your data", icon: Database, description: "Everything is stored on this computer." },
];

/**
 * Settings: five groups, each a short list of rows. The two long lists (AI models and keyboard
 * shortcuts) open in their own dialog, so the page itself stays one screen of decisions.
 */
export default function SettingsScreen() {
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(SECTIONS[0].id);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // The section list follows the page: the last section whose heading has passed the top is current.
  const track = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top + 96;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
    let found = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = box.querySelector<HTMLElement>(`#settings-${s.id}`);
      if (el && el.getBoundingClientRect().top <= top) found = s.id;
    }
    setCurrent(atEnd ? SECTIONS[SECTIONS.length - 1].id : found);
  }, []);
  useEffect(track, [track]);

  const jump = (id: string) => scroller.current?.querySelector(`#settings-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div ref={scroller} onScroll={track} className="h-full overflow-y-auto scroll-pt-6">
      <div className="mx-auto flex w-full max-w-[1000px] items-start gap-8 px-6 py-6">
        <nav aria-label="Settings sections" className="sticky top-6 hidden w-40 shrink-0 flex-col gap-0.5 @[820px]:flex">
          <h1 className="zhu-display mb-3 px-3 text-page text-fg">Settings</h1>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jump(s.id)}
              aria-current={current === s.id ? "true" : undefined}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-lg px-3 text-left text-body transition-colors duration-fast",
                current === s.id ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <s.icon className={cn("h-4 w-4 shrink-0", current === s.id && "text-accent")} aria-hidden />
              {s.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-9">
          <h1 className="zhu-display text-page text-fg @[820px]:hidden">Settings</h1>
          <Section id="answers">
            <Answers onManageModels={() => setModelsOpen(true)} />
          </Section>
          <Section id="listening">
            <Listening />
          </Section>
          <Section id="chats">
            <Card>
              <WebChatOptions />
            </Card>
          </Section>
          <Section id="app">
            <General onEditShortcuts={() => setShortcutsOpen(true)} />
          </Section>
          <Section id="data">
            <Data />
          </Section>
        </div>
      </div>

      <Modal
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        title="AI models"
        description="Paste a key and press Connect: ZHU lists the provider's models and marks the free ones. Providers at the top can be used without paying."
        size="xl"
        footer={
          <Button variant="primary" onClick={() => setModelsOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="@container">
          <ModelsSection />
        </div>
      </Modal>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

function Section({ id, children }: { id: string; children: ReactNode }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`}>
      <div className="mb-3 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <s.icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id={`settings-${id}-title`} className="text-section text-fg">
            {s.label}
          </h2>
          <p className="text-secondary text-fg-2">{s.description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-[var(--zhu-border-subtle)] rounded-xl border border-border-subtle bg-surface px-4">{children}</div>;
}

function Row({ title, description, control, stacked }: { title: string; description?: ReactNode; control: ReactNode; stacked?: boolean }) {
  return (
    <div className={cn("py-3.5", stacked ? "flex flex-col gap-2.5" : "flex flex-wrap items-center justify-between gap-x-6 gap-y-2")}>
      <div className={cn("min-w-0", !stacked && "flex-1 basis-56")}>
        <div className="text-body font-medium text-fg">{title}</div>
        {description ? <div className="mt-0.5 text-secondary text-fg-2">{description}</div> : null}
      </div>
      <div className={cn(stacked ? "w-full" : "shrink-0")}>{control}</div>
    </div>
  );
}

// ------------------------------------------------------------------ answers
function Answers({ onManageModels }: { onManageModels: () => void }) {
  const providers = useProviders();
  const resume = useQuery({ queryKey: qk.resume, queryFn: api.resume, staleTime: 60_000 });
  const autoAnswer = usePrefs((p) => p.autoAnswer);
  const sidePanel = usePrefs((p) => p.sidePanelOpen);
  const set = usePrefs((p) => p.set);
  const connected = (providers.data ?? []).filter((p) => p.status === "ready");
  const names = connected.map((p) => p.name);
  return (
    <Card>
      <Row
        title="AI models"
        description={
          providers.isLoading ? (
            "Loading…"
          ) : connected.length ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone="success">{connected.length} connected</Badge>
              <span className="min-w-0 truncate">{names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ")}</span>
            </span>
          ) : (
            "None connected yet. Several providers are free, and two need no key at all."
          )
        }
        control={
          <Button variant={connected.length ? "secondary" : "primary"} icon={<Sparkles className="h-4 w-4" />} onClick={onManageModels}>
            {connected.length ? "Manage models" : "Connect a model"}
          </Button>
        }
      />
      <Row
        title="Answer questions automatically"
        description="Each question that is detected while listening is asked right away. Off: you press Answer."
        control={<Switch checked={autoAnswer} label="Answer detected questions automatically" onCheckedChange={(v) => set({ autoAnswer: v })} />}
      />
      <Row title="How answers should sound" description="Optional. One or two sentences that go with every question, for AI models and for chat websites." stacked control={<Instructions />} />
      <Row
        title="Your résumé"
        description={
          resume.data ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={resume.data.enabled ? "success" : "neutral"} icon={<FileText className="h-3 w-3" />}>
                {resume.data.enabled ? "Used in answers" : "Switched off"}
              </Badge>
              <span className="min-w-0 truncate">{resume.data.file_name}</span>
            </span>
          ) : (
            "Upload it once and questions about you (your experience, projects, strengths) are answered from it."
          )
        }
        control={
          <Button variant="secondary" disabled={sidePanel} title={sidePanel ? "The panel on the right is open: the résumé is at its bottom" : undefined} onClick={() => set({ sidePanelOpen: true })}>
            {sidePanel ? "In the panel on the right" : resume.data ? "Open the panel" : "Upload in the panel"}
          </Button>
        }
      />
    </Card>
  );
}

function Instructions() {
  const saved = usePrefs((p) => p.instructions);
  const set = usePrefs((p) => p.set);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  return (
    <Textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== saved && set({ instructions: draft.trim() })}
      rows={2}
      maxLength={2000}
      placeholder="For example: Answer briefly and clearly, the way I would say it in an interview."
      aria-label="How answers should sound"
      className="min-h-[60px]"
    />
  );
}

// ------------------------------------------------------------------ listening
const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "auto", label: "Detect automatically" },
  { value: "hi", label: "Hindi" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt", label: "Portuguese" },
  { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "ar", label: "Arabic" },
  { value: "ru", label: "Russian" },
  { value: "it", label: "Italian" },
  { value: "nl", label: "Dutch" },
  { value: "tr", label: "Turkish" },
];

function Listening() {
  const { settings, update } = useEngineSettings();
  const devices = useQuery({ queryKey: qk.audioDevices, queryFn: api.audioDevices });
  const models = useQuery({ queryKey: qk.models, queryFn: api.models, staleTime: 60_000 });
  const setSetupOpen = useNav((s) => s.setSetupOpen);
  if (!settings) return null;
  const a = settings.audio;
  const options = (kind: "microphone" | "system") => [{ value: "default", label: "Windows default" }, ...(devices.data ?? []).filter((d) => d.kind === kind).map((d) => ({ value: d.id, label: d.name }))];
  const model = models.data?.catalog.find((m) => m.name === settings.transcription.model);
  const installed = !!models.data?.installed.includes(settings.transcription.model);
  return (
    <Card>
      <Row
        title="The call (computer sound)"
        description="What you hear from the other person in Zoom, Teams, Meet or a browser."
        control={
          <div className="flex items-center gap-2">
            {a.system_enabled ? <Select label="Speaker to listen to" size="sm" value={a.system_device ?? "default"} onValueChange={(v) => void update({ audio: { system_device: v === "default" ? null : v } }, true)} className="w-52" options={options("system")} /> : null}
            <Switch checked={a.system_enabled} label="Listen to computer sound" onCheckedChange={(v) => void update({ audio: { system_enabled: v } }, true)} />
          </div>
        }
      />
      <Row
        title="Your microphone"
        description="What you say."
        control={
          <div className="flex items-center gap-2">
            {a.microphone_enabled ? <Select label="Microphone" size="sm" value={a.microphone_device ?? "default"} onValueChange={(v) => void update({ audio: { microphone_device: v === "default" ? null : v } }, true)} className="w-52" options={options("microphone")} /> : null}
            <Switch checked={a.microphone_enabled} label="Listen to the microphone" onCheckedChange={(v) => void update({ audio: { microphone_enabled: v } }, true)} />
          </div>
        }
      />
      <Row
        title="Language spoken"
        control={<Select label="Language spoken" value={settings.transcription.language ?? "auto"} onValueChange={(v) => void update({ transcription: { language: v === "auto" ? null : v } }, true)} className="w-52" options={LANGUAGES} />}
      />
      <Row
        title="Speech recognition"
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {model ? <Badge tone={installed ? "success" : "warning"}>{installed ? model.label : `${model.label}: not downloaded yet`}</Badge> : null}
            <span>Runs on this computer; your audio is never uploaded.</span>
          </span>
        }
        control={
          <Button variant="secondary" onClick={() => setSetupOpen(true)}>
            {installed ? "Change or remove" : "Download a model"}
          </Button>
        }
      />
    </Card>
  );
}

// ------------------------------------------------------------------ app
function General({ onEditShortcuts }: { onEditShortcuts: () => void }) {
  const theme = usePrefs((p) => p.theme);
  const closeToTray = usePrefs((p) => p.closeToTray);
  const minimizeToBubble = usePrefs((p) => p.minimizeToBubble);
  const customCursor = usePrefs((p) => p.customCursor);
  const sidePanel = usePrefs((p) => p.sidePanelOpen);
  const hotkeys = usePrefs((p) => p.hotkeys);
  const set = usePrefs((p) => p.set);
  const [startup, setStartup] = useState<boolean | null>(null);
  useEffect(() => {
    void autostart.isEnabled().then(setStartup).catch(() => setStartup(null));
  }, []);
  return (
    <Card>
      <Row
        title="Appearance"
        control={
          <Segmented
            label="Appearance"
            value={theme}
            onValueChange={(v) => set({ theme: v })}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "Match Windows" },
            ]}
          />
        }
      />
      <Row
        title="Screenshots and résumé panel"
        description="The panel on the right of every screen. The button in the title bar shows and hides it too."
        control={<Switch checked={sidePanel} label="Show the screenshots and résumé panel" onCheckedChange={(v) => set({ sidePanelOpen: v })} />}
      />
      <Row
        title="Keyboard shortcuts"
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            They work from any app. Listening
            <Kbd>{hotkeys.toggle_listening}</Kbd>
            and screenshot
            <Kbd>{hotkeys.capture_screen}</Kbd>
            are two of {HOTKEY_ACTIONS.length}.
          </span>
        }
        control={
          <Button variant="secondary" icon={<Keyboard className="h-4 w-4" />} onClick={onEditShortcuts}>
            Edit shortcuts
          </Button>
        }
      />
      {inTauri && startup !== null ? (
        <Row
          title="Start with Windows"
          description="ZHU waits in the system tray. It never records until you start listening."
          control={
            <Switch
              checked={startup}
              label="Start with Windows"
              onCheckedChange={async (v) => {
                try {
                  await autostart.set(v);
                  setStartup(v);
                } catch (err) {
                  toast.error("Could not change this setting", errorMessage(err));
                }
              }}
            />
          }
        />
      ) : null}
      <Row
        title="Custom pointer"
        description="While the mouse is over ZHU, the pointer takes ZHU's own look; it gains a spark over anything you can click. Outside ZHU it is your normal Windows pointer."
        control={<Switch checked={customCursor} label="Use ZHU's own pointer" onCheckedChange={(v) => set({ customCursor: v })} />}
      />
      <Row
        title="Floating icon when minimized"
        description="While ZHU is hidden from the taskbar (the eye button) and minimized, a small ZHU icon stays on top of other windows. Click it to come back; drag it anywhere. It shows a dot while ZHU is recording. With ZHU in the taskbar there is no icon: use the taskbar button."
        control={<Switch checked={minimizeToBubble} label="Show a floating icon when minimized" onCheckedChange={(v) => set({ minimizeToBubble: v })} />}
      />
      <Row title="Keep running when the window is closed" description="ZHU stays in the system tray. Choose Quit there to exit." control={<Switch checked={closeToTray} label="Keep running in the tray" onCheckedChange={(v) => set({ closeToTray: v })} />} />
      {inTauri ? <EngineRow /> : null}
    </Card>
  );
}

/** Restart the local engine by hand: when listening, questions or answers stop working. */
function EngineRow() {
  const [busy, setBusy] = useState(false);
  const restart = async () => {
    setBusy(true);
    try {
      const info = await shell.restartEngine();
      if (info.status === "ready") toast.success("The engine was restarted");
      // A failure is shown by the notice at the bottom of the window, with what to do next.
    } catch (err) {
      toast.error("The engine could not be restarted", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      title="Processing engine"
      description="It listens, finds the questions and asks the AI models; it runs inside ZHU. If any of that stops working, restart it. Your sessions and settings are kept. Listening stops."
      control={
        <Button variant="secondary" loading={busy} icon={<RotateCcw className="h-4 w-4" />} onClick={() => void restart()}>
          Restart engine
        </Button>
      }
    />
  );
}

/** Every global shortcut, one per row. Click a shortcut, then press the new keys. */
function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const hotkeys = usePrefs((p) => p.hotkeys);
  const set = usePrefs((p) => p.set);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const changed = HOTKEY_ACTIONS.some((a) => hotkeys[a] !== DEFAULT_HOTKEYS[a]);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setRecording(null);
        onOpenChange(o);
      }}
      title="Keyboard shortcuts"
      description="These work from any app, even when ZHU is in the background. Click a shortcut, then press the new keys (with Ctrl, Alt or Shift)."
      size="md"
      footer={
        <>
          <Button variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!changed} onClick={() => set({ hotkeys: { ...DEFAULT_HOTKEYS } })} className="mr-auto">
            Reset to defaults
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      <ul className="flex flex-col divide-y divide-[var(--zhu-border-subtle)]">
        {HOTKEY_ACTIONS.map((a) => (
          <li key={a} className="flex items-center justify-between gap-4 py-2.5">
            <span className="min-w-0 text-body text-fg">
              {HOTKEY_LABELS[a]}
              {hotkeys[a] !== DEFAULT_HOTKEYS[a] ? <span className="ml-2 text-caption text-fg-3">changed</span> : null}
            </span>
            <button
              type="button"
              aria-label={`Change shortcut: ${HOTKEY_LABELS[a]}`}
              onClick={() => setRecording(a)}
              onBlur={() => recording === a && setRecording(null)}
              onKeyDown={(e) => {
                if (recording !== a) return;
                e.preventDefault();
                if (e.key === "Escape") return setRecording(null);
                const acc = toAccelerator(e);
                if (!acc) return;
                const clash = HOTKEY_ACTIONS.find((other) => other !== a && hotkeys[other] === acc);
                if (clash) return toast.error("Already used", HOTKEY_LABELS[clash]);
                set({ hotkeys: { ...hotkeys, [a]: acc } });
                setRecording(null);
              }}
              className={cn(
                "flex h-8 min-w-[168px] shrink-0 items-center justify-center rounded-md border px-3 text-secondary text-fg transition-colors duration-fast",
                recording === a ? "border-accent bg-accent-soft" : "border-border-subtle bg-surface-2 hover:border-border",
              )}
            >
              {recording === a ? <span className="text-accent">Press the new keys…</span> : <Kbd>{hotkeys[a]}</Kbd>}
            </button>
          </li>
        ))}
      </ul>
      {!inTauri ? <p className="mt-3 text-caption text-fg-3">Global shortcuts are registered by the desktop app; in a browser they are only saved.</p> : null}
    </Modal>
  );
}

// ------------------------------------------------------------------ data
function Data() {
  const { settings, update } = useEngineSettings();
  const diag = useQuery({ queryKey: qk.diagnostics, queryFn: api.diagnostics, staleTime: 60_000 });
  const [purging, setPurging] = useState(false);
  if (!settings) return null;
  return (
    <>
      <Card>
        <Row
          title="Keep the full transcript"
          description="When off, only the questions and answers are kept."
          control={<Switch checked={settings.privacy.store_transcripts} label="Keep the full transcript" onCheckedChange={(v) => void update({ privacy: { store_transcripts: v } }, true)} />}
        />
        <Row
          title="Delete everything"
          description="All sessions, transcripts, questions, screenshots, answers, chats and your résumé. Keys and speech models stay."
          control={
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setPurging(true)}>
              Delete
            </Button>
          }
        />
      </Card>
      <p className="mt-3 flex items-start gap-2 text-caption text-fg-3">
        <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          ZHU's windows are visible in screen sharing and recordings, like any other app, unless you hide ZHU with the eye button in the title bar.
          {diag.data ? (
            <>
              {" "}
              Version {diag.data.engine_version} · data in <span className="selectable break-all font-mono">{diag.data.data_dir}</span>
            </>
          ) : null}
        </span>
      </p>
      <ConfirmDialog
        open={purging}
        onOpenChange={setPurging}
        title="Delete everything?"
        description="This cannot be undone."
        typedConfirmation="DELETE"
        confirmLabel="Delete everything"
        destructive
        onConfirm={async () => {
          try {
            await api.purgeAll();
            toast.success("Everything was deleted");
          } catch (err) {
            toast.error("Delete failed", errorMessage(err));
          }
        }}
      />
    </>
  );
}
