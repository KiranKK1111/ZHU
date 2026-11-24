import { AlertCircle, ArrowDown, Check, ChevronRight, Copy, RotateCcw, Sparkles } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "@/app/state/ui";
import { Thumb } from "@/components/capture/Thumb";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { useTypewriter } from "@/hooks/useTypewriter";
import { copyText } from "@/services/shell";
import type { ChatMessage } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage, formatTime } from "@/utils/format";
import { Markdown } from "./Markdown";
import { splitThinking } from "./chatText";
import { modelLabel } from "./models";

/**
 * The conversation, newest at the bottom. While the reader is at the bottom the view follows the
 * answer as it is written; once they scroll up it stays where they put it and offers a way back.
 */
export function MessageList({ messages, providerNames, onRegenerate, canRegenerate, children }: { messages: ChatMessage[]; providerNames: Record<string, string>; onRegenerate: () => void; canRegenerate: boolean; children?: ReactNode }) {
  // Follows the answer as it is written (gliding), until the reader scrolls up.
  const { scrollRef, contentRef, away, scrollToBottom } = useStickToBottom({ threshold: 96 });
  const count = messages.length;
  const lastId = messages[count - 1]?.id;
  const firstId = messages[0]?.id;

  // A new message (the user's own) glides into view; another conversation opens at its end.
  const before = useRef({ count, firstId });
  useLayoutEffect(() => {
    const same = before.current.firstId === firstId && count > before.current.count && count - before.current.count <= 2;
    scrollToBottom(same);
    before.current = { count, firstId };
  }, [count, lastId, firstId, scrollToBottom]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="zhu-chat-scroll absolute inset-0" tabIndex={-1}>
        <div ref={contentRef} className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-5 pb-6 pt-6" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantBubble key={m.id} message={m} providerName={m.provider_id ? (providerNames[m.provider_id] ?? m.provider_id) : ""} onRegenerate={i === count - 1 && canRegenerate ? onRegenerate : undefined} />
            ),
          )}
          {children}
        </div>
      </div>
      {away ? (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="zhu-chat-rise absolute bottom-3 left-1/2 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-secondary text-fg shadow-2 transition-colors duration-fast hover:bg-surface-3"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
          Latest
        </button>
      ) : null}
    </div>
  );
}

const UserBubble = memo(function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className="zhu-chat-rise group flex flex-col items-end gap-1">
      {message.screenshot_ids.length ? (
        <div className="flex max-w-[min(85%,640px)] flex-wrap justify-end gap-1.5">
          {message.screenshot_ids.map((id, i) => (
            <Thumb key={id} id={id} alt={`Screenshot ${i + 1} sent with this message`} className="h-20 w-[128px] rounded-lg border border-border-subtle" />
          ))}
        </div>
      ) : null}
      {message.content ? <div className="zhu-bubble-user selectable max-w-[min(85%,640px)] whitespace-pre-wrap break-words px-4 py-2.5 text-body leading-relaxed">{message.content}</div> : null}
      <div className="flex h-5 items-center gap-1 pr-1 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
        <span className="text-caption text-fg-3">{formatTime(message.created_at)}</span>
        {message.content ? <CopyButton text={message.content} label="Copy message" /> : null}
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({ message, providerName, onRegenerate }: { message: ChatMessage; providerName: string; onRegenerate?: () => void }) {
  const streaming = message.status === "streaming";
  const { thinking, open, answer: full } = splitThinking(message.content);
  // The answer is typed out at an even pace (the thinking is folded away, so it is not typed).
  const answer = useTypewriter(full, streaming);
  const typing = answer.length < full.length;
  const waiting = streaming && !answer && !thinking;
  return (
    <div className="zhu-chat-rise group flex items-start gap-3">
      <span className="zhu-chat-avatar mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" aria-hidden>
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <div className="flex max-w-full items-baseline gap-2 pl-1 text-caption text-fg-3">
          <span className="truncate font-medium text-fg-2">{message.model ? modelLabel(message.model) : "Assistant"}</span>
          {providerName ? <span className="shrink-0">{providerName}</span> : null}
        </div>
        <div className="zhu-bubble-assistant max-w-full px-4 py-3" aria-busy={streaming || typing}>
          {thinking !== null ? <ThinkingBlock text={thinking} open={open} /> : null}
          {waiting ? (
            <span className="zhu-typing" role="status" aria-label="Writing an answer">
              <i />
              <i />
              <i />
            </span>
          ) : null}
          {answer ? <Markdown text={answer} streaming={streaming || typing} /> : null}
          {message.status === "cancelled" && !typing ? <p className={cn("text-caption text-fg-3", (answer || thinking) && "mt-2")}>Stopped.</p> : null}
          {message.status === "failed" && !typing ? (
            <div role="alert" className={cn("flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-secondary text-danger", (answer || thinking) && "mt-3")}>
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="selectable">
                {message.error?.message ?? "The model did not answer."}
                {message.error?.retry_after_s ? ` Try again in about ${Math.ceil(message.error.retry_after_s)} s.` : ""}
                {message.error?.kind === "rate_limited" || message.error?.kind === "not_found" ? " You can also pick another model below." : ""}
              </span>
            </div>
          ) : null}
        </div>
        {!streaming && !typing ? (
          <div className={cn("flex h-6 items-center gap-0.5 pl-1 transition-opacity duration-fast", onRegenerate ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100")}>
            {full ? <CopyButton text={full} label="Copy answer" /> : null}
            {onRegenerate ? (
              <button type="button" onClick={onRegenerate} className="inline-flex h-6 items-center gap-1.5 rounded-sm px-1.5 text-caption text-fg-3 transition-colors duration-fast hover:bg-hover hover:text-fg">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                {message.status === "completed" ? "Answer again" : "Try again"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** A reasoning model's thinking: folded away, one click to read. */
function ThinkingBlock({ text, open }: { text: string; open: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="[&:not(:last-child)]:mb-2">
      <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="inline-flex items-center gap-1 rounded-sm text-secondary text-fg-3 transition-colors duration-fast hover:text-fg">
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-fast", expanded && "rotate-90")} aria-hidden />
        {open ? <span className="zhu-pulse-dot">Thinking…</span> : "Thought it through"}
      </button>
      {expanded && text ? <div className="selectable mt-1.5 whitespace-pre-wrap border-l-2 border-border pl-3 text-secondary text-fg-2">{text}</div> : null}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() =>
        void copyText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch((e) => toast.error("Copy failed", errorMessage(e)))
      }
      className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-3 transition-colors duration-fast hover:bg-hover hover:text-fg"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}
