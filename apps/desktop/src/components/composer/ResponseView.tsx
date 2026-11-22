import { AlertCircle, Copy, RotateCcw, Square } from "lucide-react";
import { lazy, Suspense } from "react";
import { useComposer, type ResponseState } from "@/app/state/composer";
import { useSession } from "@/app/state/session";
import { toast } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { Badge, Spinner } from "@/components/primitives/Display";
import { api } from "@/services/engine";
import { copyText } from "@/services/shell";
import { errorMessage } from "@/utils/format";
import { splitThinking } from "@/features/chat/chatText";
import { parseInlineCode } from "@/utils/text";

// The Markdown renderer (with code highlighting and formulas) is large; it loads with the first answer.
const Markdown = lazy(() => import("@/features/chat/Markdown").then((m) => ({ default: m.Markdown })));

/** Streaming provider response, with cancel, retry and copy. */
export function ResponseView({ response, providerName }: { response: ResponseState; providerName: string }) {
  const sessionId = useSession((s) => s.currentSessionId);
  const streaming = response.status === "streaming";

  const retry = async () => {
    try {
      const res = await api.submitPrompt(response.providerId, { session_id: sessionId, prompt: response.prompt, screenshot_ids: response.screenshotIds });
      useComposer.getState().started({ requestId: res.request_id, interactionId: res.interaction_id, providerId: response.providerId, model: res.model, prompt: response.prompt, screenshotIds: response.screenshotIds });
    } catch (err) {
      toast.error("Retry failed", errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-2" aria-busy={streaming}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="accent">{providerName}</Badge>
        {response.model ? <Badge>{response.model}</Badge> : null}
        {streaming ? <Spinner label="Responding" className="ml-1" /> : null}
        {response.status === "cancelled" ? <Badge tone="warning">Cancelled</Badge> : null}
        {response.status === "failed" ? <Badge tone="danger">Failed</Badge> : null}
      </div>
      {response.prompt ? <p className="selectable line-clamp-3 border-l-2 border-border pl-2 text-secondary text-fg-2">{response.prompt}</p> : null}
      {response.text ? <ResponseText text={response.text} streaming={streaming} /> : streaming ? <div className="zhu-skeleton h-16 w-full" /> : null}
      {response.error && response.status === "failed" ? (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-secondary text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {response.error.message}
            {response.error.retry_after_s ? ` Retry after about ${Math.ceil(response.error.retry_after_s)} s.` : ""}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {streaming ? (
          <Button size="sm" variant="secondary" icon={<Square className="h-3.5 w-3.5" />} onClick={() => void api.cancelRequest(response.requestId).catch((e) => toast.error("Could not cancel", errorMessage(e)))}>
            Cancel
          </Button>
        ) : null}
        {!streaming && response.prompt && (response.status === "failed" || response.status === "cancelled") ? (
          <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => void retry()}>
            Retry
          </Button>
        ) : null}
        {response.text ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy className="h-3.5 w-3.5" />}
            onClick={() =>
              void copyText(response.text)
                .then(() => toast.success("Response copied"))
                .catch((e) => toast.error("Copy failed", errorMessage(e)))
            }
          >
            Copy
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * An answer, rendered as Markdown: headings, lists, tables, highlighted code and formulas. A
 * reasoning model's thinking (a leading <think> block) is left out; the answer is what is shown.
 */
export function ResponseText({ text, streaming }: { text: string; streaming?: boolean }) {
  const { answer, open } = splitThinking(text);
  if (!answer) return open ? <p className="text-secondary text-fg-3">Thinking…</p> : null;
  return (
    <Suspense fallback={<PlainText text={answer} />}>
      <Markdown text={answer} streaming={streaming} />
    </Suspense>
  );
}

/** Shown for the moment the Markdown renderer takes to load: the text with code blocks kept apart. */
function PlainText({ text }: { text: string }) {
  const blocks = text.split(/```/);
  return (
    <div className="selectable flex flex-col gap-2 text-body leading-relaxed text-fg">
      {blocks.map((b, i) => {
        if (i % 2 === 1) {
          const nl = b.indexOf("\n");
          const code = nl >= 0 ? b.slice(nl + 1) : b;
          const lang = nl >= 0 ? b.slice(0, nl).trim() : "";
          return (
            <pre key={i} className="overflow-x-auto rounded-md border border-border-subtle bg-surface-2 p-3 font-mono text-secondary text-fg" aria-label={lang ? `${lang} code` : "code"}>
              <code>{code.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        return b.trim() ? (
          <p key={i} className="whitespace-pre-wrap break-words">
            {parseInlineCode(b.replace(/^\n+|\n+$/g, "")).map((p, j) =>
              p.kind === "code" ? (
                <code key={j} className="zhu-code">
                  {p.text}
                </code>
              ) : (
                <span key={j}>{p.text}</span>
              ),
            )}
          </p>
        ) : null;
      })}
    </div>
  );
}
