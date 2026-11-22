import "@/styles/chat.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, History, ImagePlus, KeyRound, MessageSquarePlus, Sparkles, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { useChat } from "@/app/state/chat";
import { latestQuestion, useQuestions } from "@/app/state/questions";
import { toast } from "@/app/state/ui";
import { Thumb } from "@/components/capture/Thumb";
import { Button, IconButton } from "@/components/primitives/Button";
import { Modal } from "@/components/primitives/Dialog";
import { Spinner } from "@/components/primitives/Display";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Menu";
import { ModelsSection } from "@/features/settings/ModelsSection";
import type { WebChatTab } from "@/features/webchat/services";
import { useDropZone } from "@/hooks/useDropZone";
import { pickAnswerModel, useProviders } from "@/hooks/useProviders";
import { api, EngineHttpError } from "@/services/engine";
import type { ChatConversation, ChatMessage, ProviderInfo } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage, formatRelative } from "@/utils/format";
import { questionCopyText } from "@/utils/questionPresentation";
import { MessageList } from "./Messages";
import { ModelPicker } from "./ModelPicker";
import { imageAlternative, imageSupportKnown, readsImages, resolveChatModel, type ChatModelOption } from "./models";
import { useSelectModel } from "./useModelChoice";

const NO_MESSAGES: ChatMessage[] = [];
const NO_ATTACHMENTS: string[] = [];
const STARTERS = ["Explain the CAP theorem with a real example", "Ask me a system design interview question", "What is the difference between a process and a thread?"];

/**
 * The built-in chat: a conversation with any model of the providers the user has connected.
 * One chat tab shows one conversation; "New chat" starts another and History reopens earlier ones.
 */
export function ChatPane({ tab, onConversation }: { tab: WebChatTab; onConversation: (conversationId: string | null) => void }) {
  const qc = useQueryClient();
  const providers = useProviders();
  const cid = tab.conversation ?? null;
  const messages = useChat((s) => (cid ? s.messages[cid] : undefined));
  const requestId = useChat((s) => (cid ? s.streaming[cid] : undefined));
  const sending = useChat((s) => (cid ? !!s.sending[cid] : false));
  const chosenProvider = usePrefs((p) => p.chatProvider);
  const chosenModel = usePrefs((p) => p.chatModel);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const list = providers.data ?? [];
  const answerProvider = usePrefs((p) => p.answerProvider);
  const model = useMemo(() => {
    if (chosenProvider && chosenModel) return resolveChatModel(list, { providerId: chosenProvider, model: chosenModel });
    // Nothing chosen in the chat yet: the model that answers on Home.
    const home = pickAnswerModel(list, answerProvider);
    return resolveChatModel(list, home?.model ? { providerId: home.id, model: home.model } : null);
  }, [list, chosenProvider, chosenModel, answerProvider]);
  const providerNames = useMemo(() => Object.fromEntries(list.map((p) => [p.id, p.name])), [list]);
  const busy = !!requestId || sending || starting;

  // A conversation that is not in memory yet (after a restart, or picked from History) is read from the engine.
  useEffect(() => {
    if (!cid || messages) return;
    let cancelled = false;
    setLoadError(null);
    api
      .chat(cid)
      .then((c) => {
        if (!cancelled) useChat.getState().load(cid, c.messages, c.streaming_request_id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        // The conversation was deleted (from History, or with "Delete all data"): start afresh.
        if (err instanceof EngineHttpError && err.status === 404) onConversation(null);
        else setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [cid, messages, onConversation]);

  const send = useCallback(
    async (text: string, regenerate = false, screenshotIds: string[] = []): Promise<boolean> => {
      if (!model) {
        setProvidersOpen(true);
        return false;
      }
      let conversation = cid;
      try {
        if (!conversation) {
          setStarting(true);
          conversation = (await api.createChat()).id;
          useChat.getState().load(conversation, [], null);
          onConversation(conversation);
        }
        useChat.getState().beginSend(conversation);
        const res = await api.sendChat(conversation, regenerate ? { provider_id: model.providerId, model: model.model, regenerate: true } : { provider_id: model.providerId, model: model.model, content: text, screenshot_ids: screenshotIds });
        useChat.getState().appendTurn(conversation, res.user_message, res.assistant_message, res.request_id);
        void qc.invalidateQueries({ queryKey: qk.chats });
        return true;
      } catch (err) {
        if (conversation) useChat.getState().endSend(conversation);
        toast.error("Could not send the message", errorMessage(err));
        return false;
      } finally {
        setStarting(false);
      }
    },
    [cid, model, onConversation, qc],
  );

  const stop = useCallback(() => {
    if (requestId) void api.cancelRequest(requestId).catch((e) => toast.error("Could not stop the answer", errorMessage(e)));
  }, [requestId]);

  const select = useSelectModel(); // the same model answers on Home
  const shown = messages ?? NO_MESSAGES;
  const loading = !!cid && !messages && !loadError;

  return (
    <div className="@container flex h-full min-h-0 flex-col bg-bg">
      <ChatHeader tab={tab} conversationId={cid} busy={busy} onConversation={onConversation} />
      {providers.isLoading || loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="Loading" />
        </div>
      ) : loadError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-body text-fg-2">This conversation could not be opened: {loadError}</p>
          <Button onClick={() => onConversation(null)}>Start a new chat</Button>
        </div>
      ) : shown.length > 0 ? (
        <MessageList messages={shown} providerNames={providerNames} canRegenerate={!busy && !!model} onRegenerate={() => void send("", true)} />
      ) : model ? (
        <Welcome onPick={(text) => useChat.getState().setDraft(tab.id, text)} />
      ) : (
        <ConnectFirst providers={list} onConnect={() => setProvidersOpen(true)} />
      )}
      <Composer tabId={tab.id} providers={list} model={model} streaming={!!requestId} busy={busy} onSend={(text, shots) => send(text, false, shots)} onStop={stop} onSelectModel={select} onManageProviders={() => setProvidersOpen(true)} />
      <Modal
        open={providersOpen}
        onOpenChange={setProvidersOpen}
        title="AI model providers"
        description="Paste a key and press Connect: ZHU lists the provider's models and marks the free ones. Add any other OpenAI-compatible service at the bottom."
        size="lg"
      >
        <div className="@container">
          <ModelsSection />
        </div>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------ header
function ChatHeader({ tab, conversationId, busy, onConversation }: { tab: WebChatTab; conversationId: string | null; busy: boolean; onConversation: (id: string | null) => void }) {
  const chats = useQuery({ queryKey: qk.chats, queryFn: api.chats, staleTime: 15_000 });
  const title = chats.data?.find((c) => c.id === conversationId)?.title;
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle px-3">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
      <span className="ml-1 min-w-0 flex-1 truncate text-secondary text-fg-2" title={title || undefined}>
        {title || "New chat"}
      </span>
      <Button size="sm" variant="ghost" icon={<MessageSquarePlus className="h-3.5 w-3.5" />} disabled={!conversationId} onClick={() => onConversation(null)} title="Start a new conversation in this tab">
        New chat
      </Button>
      <HistoryMenu conversations={chats.data ?? []} currentId={conversationId} currentBusy={busy} tabName={tab.name} onOpen={onConversation} />
    </div>
  );
}

function HistoryMenu({ conversations, currentId, currentBusy, tabName, onOpen }: { conversations: ChatConversation[]; currentId: string | null; currentBusy: boolean; tabName: string; onOpen: (id: string | null) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const remove = async (c: ChatConversation) => {
    try {
      await api.deleteChat(c.id);
      useChat.getState().forget(c.id);
      if (c.id === currentId) onOpen(null);
      await qc.invalidateQueries({ queryKey: qk.chats });
    } catch (err) {
      toast.error("Could not delete the conversation", errorMessage(err));
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Earlier conversations" size="sm" noTooltip>
          <History className="h-4 w-4" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="flex max-h-[min(440px,70vh)] w-[340px] flex-col p-0">
        <div className="shrink-0 border-b border-border-subtle px-3 py-2 text-caption text-fg-3">Conversations in {tabName}</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {conversations.length === 0 ? <p className="px-3 py-6 text-center text-secondary text-fg-2">No conversations yet.</p> : null}
          {conversations.map((c) => (
            <div key={c.id} className={cn("group flex items-center gap-1 rounded-sm pr-1 transition-colors duration-fast hover:bg-hover", c.id === currentId && "bg-active")}>
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col items-start px-2 py-1.5 text-left"
                onClick={() => {
                  onOpen(c.id);
                  setOpen(false);
                }}
              >
                <span className="w-full truncate text-body text-fg">{c.title || "New chat"}</span>
                <span className="text-caption text-fg-3">
                  {formatRelative(c.updated_at)} · {c.message_count} {c.message_count === 1 ? "message" : "messages"}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${c.title || "conversation"}`}
                title="Delete this conversation"
                disabled={c.id === currentId && currentBusy}
                onClick={() => void remove(c)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-fg-3 opacity-0 transition-[opacity,color,background-color] duration-fast hover:bg-danger-soft hover:text-danger focus-visible:opacity-100 disabled:pointer-events-none group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ------------------------------------------------------------------ empty states
function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const latest = useQuestions((s) => latestQuestion(s));
  const question = latest ? questionCopyText(latest, true).trim() : "";
  const starters = question ? [question, ...STARTERS.slice(0, 2)] : STARTERS;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8 text-center">
      <span className="zhu-chat-avatar zhu-chat-rise flex h-12 w-12 items-center justify-center rounded-2xl shadow-2" aria-hidden>
        <Sparkles className="h-5 w-5" />
      </span>
      <div className="zhu-chat-rise">
        <h1 className="zhu-display text-page text-fg">What would you like to ask?</h1>
        <p className="mt-1.5 text-body text-fg-2">Pick a model below and write your message. The conversation stays on this computer.</p>
      </div>
      <div className="zhu-chat-rise flex w-full max-w-[640px] flex-col gap-2">
        {starters.map((text, i) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-4 py-3 text-left text-body text-fg transition-colors duration-fast hover:border-border hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1 truncate">{text}</span>
            {question && i === 0 ? <span className="shrink-0 text-caption text-accent">Latest question</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConnectFirst({ providers, onConnect }: { providers: ProviderInfo[]; onConnect: () => void }) {
  const qc = useQueryClient();
  const [trying, setTrying] = useState(false);
  const free = providers.filter((p) => p.free_tier && p.key_required).map((p) => p.name);
  const names = free.length > 4 ? `${free.slice(0, 4).join(", ")} and ${free.length - 4} more` : free.join(", ");
  // Free services that answer without an account: connecting them only reads their model lists.
  const keyless = providers.filter((p) => p.free_tier && !p.key_required && !p.user_defined && p.status !== "disabled");

  const tryKeyless = async () => {
    setTrying(true);
    try {
      const results = await Promise.allSettled(keyless.map((p) => api.testProvider(p.id)));
      await qc.invalidateQueries({ queryKey: qk.providers });
      if (!results.some((r) => r.status === "fulfilled" && r.value.ok)) {
        toast.error("The free services did not answer", "Check your internet connection, or connect a provider with a key.");
      }
    } finally {
      setTrying(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-8 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent" aria-hidden>
        <KeyRound className="h-5 w-5" />
      </span>
      <div>
        <h1 className="zhu-display text-page text-fg">Connect a model to start chatting</h1>
        <p className="mx-auto mt-1.5 max-w-[520px] text-body text-fg-2">
          {names ? `${names} offer free API keys. ` : ""}Paste one key and ZHU finds the provider's models and marks the ones that are free. You can also add any OpenAI-compatible service, or a model running on your
          own computer.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" size="lg" icon={<KeyRound className="h-4 w-4" />} onClick={onConnect}>
          Connect a provider
        </Button>
        {keyless.length ? (
          <Button size="lg" icon={<Sparkles className="h-4 w-4" />} loading={trying} onClick={() => void tryKeyless()}>
            Start without a key
          </Button>
        ) : null}
      </div>
      {keyless.length ? (
        <p className="max-w-[520px] text-caption text-fg-3">
          “Start without a key” uses {keyless.map((p) => p.name).join(" and ")}: free public services that need no account. Their model providers may log what you send, so keep sensitive text for a
          provider you have a key for.
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ message box
function Composer({
  tabId,
  providers,
  model,
  streaming,
  busy,
  onSend,
  onStop,
  onSelectModel,
  onManageProviders,
}: {
  tabId: string;
  providers: ProviderInfo[];
  model: ChatModelOption | null;
  streaming: boolean;
  busy: boolean;
  onSend: (text: string, screenshotIds: string[]) => Promise<boolean>;
  onStop: () => void;
  onSelectModel: (o: ChatModelOption) => void;
  onManageProviders: () => void;
}) {
  const qc = useQueryClient();
  const draft = useChat((s) => s.drafts[tabId] ?? "");
  const attachments = useChat((s) => s.attachments[tabId] ?? NO_ATTACHMENTS);
  const ref = useRef<HTMLTextAreaElement>(null);
  const drop = useDropZone(`chat:${tabId}`, (ids) => {
    useChat.getState().attach(tabId, ids);
    ref.current?.focus();
  });
  const provider = model ? providers.find((p) => p.id === model.providerId) : undefined;
  // A gateway's model list says which models read images; elsewhere ZHU cannot know, and the
  // provider's switch says whether to send them.
  const imagesOff = attachments.length > 0 && !!provider && !!model && !readsImages(provider, model.model);
  const textOnly = imagesOff && !!provider && !!model && imageSupportKnown(provider, model.model);
  const alternative = textOnly && model ? imageAlternative(providers, model) : null;
  const canSend = (!!draft.trim() || attachments.length > 0) && !busy && !!model && !imagesOff;

  const allowImages = async () => {
    if (!provider) return;
    try {
      await api.updateProvider(provider.id, { images: true });
      await qc.invalidateQueries({ queryKey: qk.providers });
    } catch (err) {
      toast.error("Not saved", errorMessage(err));
    }
  };

  // The box grows with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 208)}px`;
  }, [draft]);

  useEffect(() => {
    ref.current?.focus();
    useChat.getState().markRead(tabId);
  }, [tabId]);

  const submit = async () => {
    if (!canSend) return;
    const text = draft.trim();
    const shots = attachments;
    useChat.getState().setDraft(tabId, "");
    useChat.getState().clearAttachments(tabId);
    // A message that could not be sent goes back into the box, unless something new was typed meanwhile.
    if (!(await onSend(text, shots))) {
      if (!useChat.getState().drafts[tabId]) useChat.getState().setDraft(tabId, text);
      useChat.getState().attach(tabId, shots);
    }
    ref.current?.focus();
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div {...drop.props} className={cn("zhu-chat-composer relative mx-auto flex w-full max-w-[820px] flex-col", drop.dragging && "is-drop-target", drop.over && "is-drop-over")}>
        {drop.dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[inherit] bg-[color-mix(in_srgb,var(--zhu-surface)_86%,transparent)] text-body font-medium text-accent">
            <ImagePlus className="h-4 w-4" aria-hidden />
            Drop to attach
          </div>
        ) : null}
        {attachments.length ? (
          <div className="flex flex-wrap items-center gap-2 px-3 pt-3" aria-label="Attached screenshots">
            {attachments.map((id, i) => (
              <div key={id} className={cn("group relative overflow-hidden rounded-md border border-border-subtle", imagesOff && "opacity-60")}>
                <Thumb id={id} alt={`Attached screenshot ${i + 1}`} className="h-14 w-[84px]" />
                <button
                  type="button"
                  aria-label={`Remove attached screenshot ${i + 1}`}
                  title="Remove"
                  onClick={() => useChat.getState().detach(tabId, id)}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-scrim text-fg opacity-90 hover:opacity-100"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {imagesOff && provider ? (
          <div role="status" className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-1.5 text-secondary text-warning">
            {textOnly ? (
              <>
                <span className="min-w-0 flex-1">
                  {model?.label} cannot read images. {alternative ? "Switch to a model that can, or remove the screenshot." : "Pick a model that can, or remove the screenshot."}
                </span>
                {alternative ? (
                  <Button size="sm" variant="secondary" onClick={() => onSelectModel(alternative)}>
                    Use {alternative.label}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1">{provider.name} is not set to read images. Allow it if this model can see screenshots, or pick another model.</span>
                <Button size="sm" variant="secondary" onClick={() => void allowImages()}>
                  Allow images
                </Button>
              </>
            )}
          </div>
        ) : null}
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          onChange={(e) => useChat.getState().setDraft(tabId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={model ? `Message ${model.label}` : "Connect a model to start"}
          aria-label="Message"
          className="max-h-52 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-body leading-relaxed text-fg placeholder:text-fg-3"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
          <div className="min-w-0 flex-1">
            <ModelPicker providers={providers} selected={model} onSelect={onSelectModel} onManageProviders={onManageProviders} />
          </div>
          <span className="hidden shrink-0 text-caption text-fg-3 @[640px]:inline">Enter to send · Shift+Enter for a new line</span>
          {streaming ? (
            <button type="button" onClick={onStop} aria-label="Stop the answer" title="Stop" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fg text-bg transition-transform duration-fast hover:scale-105 active:scale-95">
              <Square className="h-3 w-3 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send message"
              title="Send"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg shadow-1 transition-[transform,background-color,opacity] duration-fast hover:scale-105 hover:bg-accent-hover active:scale-95 disabled:pointer-events-none disabled:bg-surface-3 disabled:text-fg-3 disabled:shadow-none"
            >
              <ArrowUp className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
