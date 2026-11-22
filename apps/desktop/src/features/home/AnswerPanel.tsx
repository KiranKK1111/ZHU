import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Copy, ImagePlus, KeyRound, MessagesSquare, Monitor, Sparkles, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { useComposer } from "@/app/state/composer";
import { usePrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { Thumb } from "@/components/capture/Thumb";
import { AttachmentStrip } from "@/components/composer/AttachmentStrip";
import { ResponseText, ResponseView } from "@/components/composer/ResponseView";
import { Button } from "@/components/primitives/Button";
import { Tip } from "@/components/primitives/Tooltip";
import { Switch } from "@/components/primitives/Controls";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { chatModelOption } from "@/features/chat/models";
import { useSelectModel } from "@/features/chat/useModelChoice";
import { useCaptureActions } from "@/hooks/useActions";
import { useDropZone } from "@/hooks/useDropZone";
import { useAnswerModel, useProviders } from "@/hooks/useProviders";
import { ask } from "@/services/ask";
import { api } from "@/services/engine";
import { copyText } from "@/services/shell";
import type { Interaction, ProviderInfo } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";

/** Right half of Home: the selected AI model, its answers for this session, and a box to ask anything. */
export function AnswerPanel() {
  const { model, loading } = useAnswerModel();
  const autoAnswer = usePrefs((p) => p.autoAnswer);
  const setPrefs = usePrefs((p) => p.set);
  const navigate = useNav((s) => s.navigate);

  return (
    <section aria-label="Answers" className="flex min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-5">
        <h2 className="text-card text-fg">Answers</h2>
        {model ? (
          <label className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-secondary text-fg-2" title="Ask the model as soon as a question is detected">
            Auto-answer
            <Switch checked={autoAnswer} label="Answer detected questions automatically" onCheckedChange={(v) => setPrefs({ autoAnswer: v })} />
          </label>
        ) : null}
      </div>
      {model ? (
        <>
          <Answers />
          <AskBox model={model} />
        </>
      ) : loading ? (
        <div className="flex-1" aria-busy />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <h3 className="text-section text-fg">Get answers here</h3>
            <p className="mx-auto mt-1 max-w-[380px] text-body text-fg-2">Connect an AI model with an API key. Google Gemini, Groq and OpenRouter have free tiers, and it takes about a minute.</p>
          </div>
          <Button variant="primary" icon={<KeyRound className="h-4 w-4" />} onClick={() => navigate("settings")}>
            Connect a model
          </Button>
          <button type="button" onClick={() => navigate("webchats")} className="inline-flex items-center gap-1.5 text-secondary text-fg-3 underline-offset-2 hover:text-fg-2 hover:underline">
            <MessagesSquare className="h-3.5 w-3.5" />
            Or use ChatGPT, Claude or Gemini with your own account in AI chats
          </button>
        </div>
      )}
    </section>
  );
}

/** This session's questions and answers, oldest first, following the newest like a chat. */
function Answers() {
  const sessionId = useSession((s) => s.currentSessionId);
  const { data: providers } = useProviders();
  const interactions = useQuery({ queryKey: qk.interactions(sessionId ?? "none"), queryFn: () => api.interactions(sessionId!), enabled: !!sessionId });
  const responses = useComposer((s) => s.responses);
  const order = useComposer((s) => s.responseOrder);
  const past = interactions.data ?? [];
  const stored = new Set(past.filter((i) => i.status === "completed" || i.status === "failed" || i.status === "cancelled").map((i) => i.id));
  // An answer is shown from the live stream until the stored copy of it has arrived.
  const live = order.map((id) => responses[id]).filter((r) => r && !stored.has(r.interactionId));
  const liveIds = new Set(live.map((r) => r.interactionId));
  const finished = past.filter((i) => !liveIds.has(i.id));
  const name = (id: string) => providers?.find((p) => p.id === id)?.name ?? "AI";

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const tail = `${finished.length}:${live.length}:${live[live.length - 1]?.text.length ?? 0}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [tail]);

  if (!finished.length && !live.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <p className="text-body text-fg-2">No answers yet</p>
        <p className="max-w-[340px] text-secondary text-fg-3">Press Answer on a question, switch on Auto-answer, or type your own question below.</p>
      </div>
    );
  }
  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-5 pb-3"
    >
      <div className="flex flex-col gap-4">
        {finished.map((i) => (
          <StoredAnswer key={i.id} interaction={i} providerName={name(i.provider_id)} />
        ))}
        {live.map((r) => (
          <div key={r.requestId} className="rounded-xl border border-border bg-surface p-4">
            <ResponseView response={r} providerName={name(r.providerId)} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StoredAnswer({ interaction: i, providerName }: { interaction: Interaction; providerName: string }) {
  return (
    <article className="flex flex-col gap-2">
      <div className="ml-auto max-w-[88%] rounded-xl bg-surface-2 px-3.5 py-2.5">
        <p className="selectable whitespace-pre-wrap break-words text-body text-fg">{i.prompt || "(screenshots only)"}</p>
        {i.screenshot_ids.length ? (
          <div className="mt-2 flex gap-1.5">
            {i.screenshot_ids.map((sid) => (
              <Thumb key={sid} id={sid} alt="Attached screenshot" className="h-10 w-16 rounded-sm" />
            ))}
          </div>
        ) : null}
      </div>
      <div className="group rounded-xl border border-border-subtle bg-surface p-4">
        {i.response ? <ResponseText text={i.response} /> : null}
        {i.status !== "completed" ? (
          <p className={cn("text-secondary", i.status === "failed" ? "text-danger" : "text-fg-3")}>{i.status === "failed" ? (i.error ?? "The request failed.") : i.status === "cancelled" ? "Cancelled." : "Answering…"}</p>
        ) : null}
        <div className="mt-2 flex items-center gap-3 text-caption text-fg-3">
          <span>
            {providerName}
            {i.model ? ` · ${i.model.replace(/^models\//, "")}` : ""}
          </span>
          {i.response ? (
            <button
              type="button"
              onClick={() =>
                void copyText(i.response)
                  .then(() => toast.success("Answer copied"))
                  .catch((e) => toast.error("Copy failed", errorMessage(e)))
              }
              className="inline-flex items-center gap-1 hover:text-fg"
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

const MAX_HEIGHT = 180;
const MIN_HEIGHT = 36;

/**
 * Type your own question. Enter sends; Shift+Enter starts a new line. The model that answers is
 * chosen in the box itself (the same list as in the chat): choosing one selects its provider for
 * Home and makes it that provider's model, as the model list in Settings does.
 */
function AskBox({ model }: { model: ProviderInfo }) {
  const modelName = model.name;
  const acceptsImages = model.capabilities.images;
  const { data: providers } = useProviders();
  const navigate = useNav((s) => s.navigate);
  const selected = model.model ? chatModelOption(model, model.model) : null;
  const selectModel = useSelectModel(); // the same model answers in Custom chat
  const draft = useComposer((s) => s.draft);
  const setDraft = useComposer((s) => s.setDraft);
  const attachments = useComposer((s) => s.attachments);
  const focusNonce = useComposer((s) => s.focusNonce);
  const streaming = useComposer((s) => s.responseOrder.map((id) => s.responses[id]).find((r) => r?.status === "streaming")?.requestId ?? null);
  const capture = useCaptureActions();
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  /** Take a screenshot of the whole screen and put it in the box, ready to go with the question. */
  const captureScreen = async () => {
    setCapturing(true);
    try {
      const shot = await capture.screen("monitor");
      if (shot?.id) useComposer.getState().attach([shot.id]);
      ref.current?.focus();
    } finally {
      setCapturing(false);
    }
  };
  // Screenshots dragged from the side panel land here.
  const drop = useDropZone("home", (ids) => {
    useComposer.getState().attach(ids);
    ref.current?.focus();
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, el.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    if (focusNonce) ref.current?.focus();
  }, [focusNonce]);

  const canSend = (!!draft.trim() || (acceptsImages && attachments.length > 0)) && !busy;
  const send = async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      if (await ask(draft, { screenshotIds: attachments })) {
        setDraft("");
        useComposer.getState().clearAttachments();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 px-5 pb-4">
      <div
        {...drop.props}
        className={cn(
          "relative rounded-xl border bg-surface shadow-1 transition-colors duration-fast focus-within:border-[var(--zhu-text-3)]",
          drop.over ? "border-accent ring-4 ring-[var(--zhu-accent-soft)]" : drop.dragging ? "border-dashed border-accent" : "border-border",
        )}
      >
        {drop.dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[inherit] bg-[color-mix(in_srgb,var(--zhu-surface)_86%,transparent)] text-body font-medium text-accent">
            <ImagePlus className="h-4 w-4" aria-hidden />
            Drop to attach
          </div>
        ) : null}
        <AttachmentStrip className="px-3 pt-3" disabledReason={attachments.length && !acceptsImages ? `${modelName} does not accept images; they will not be sent.` : null} />
        {/* The question on top; under it one row of controls: screenshot and model on the left, stop and send on the right. */}
        <div className="px-2 pt-2">
          <textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              // Enter sends, except while an input method is composing text (Chinese, Japanese, Korean…).
              if (e.key !== "Enter" || e.shiftKey || composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void send();
            }}
            rows={1}
            placeholder="Ask anything"
            aria-label="Your question"
            className="block max-h-[180px] min-h-[36px] w-full resize-none bg-transparent px-1.5 py-2 text-body leading-5 text-fg placeholder:text-fg-3 focus-visible:outline-none"
          />
        </div>
        <div className="@container flex items-center gap-1.5 p-2 pt-1">
          <Tip label="Capture the whole screen and attach it" side="top">
            <button
              type="button"
              aria-label="Capture the whole screen and attach it"
              disabled={capturing}
              onClick={() => void captureScreen()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-fg-2 transition-colors duration-fast hover:bg-hover hover:text-fg disabled:opacity-[var(--zhu-opacity-disabled)]"
            >
              <Monitor className={cn("h-[18px] w-[18px]", capturing && "animate-pulse")} aria-hidden />
            </button>
          </Tip>
          <div className="mr-auto flex min-w-0">
            <ModelPicker providers={providers ?? []} selected={selected} onSelect={selectModel} onManageProviders={() => navigate("settings")} />
          </div>
          {streaming ? (
            <Tip label="Stop answering" side="top">
              <button
                type="button"
                aria-label="Stop answering"
                onClick={() => void api.cancelRequest(streaming).catch((e) => toast.error("Could not stop", errorMessage(e)))}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 text-fg transition-colors duration-fast hover:bg-surface-3"
              >
                <Square className="h-3 w-3 fill-current" aria-hidden />
              </button>
            </Tip>
          ) : null}
          <Tip label="Send" shortcut="Enter" side="top">
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={() => void send()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-1 transition-[transform,background-color] duration-fast hover:scale-105 hover:bg-accent-hover active:scale-95 disabled:pointer-events-none disabled:bg-surface-3 disabled:text-fg-3 disabled:shadow-none"
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
