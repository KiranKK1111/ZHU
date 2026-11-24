import { ExternalLink, Loader2, RefreshCw, ScanText, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { Modal } from "@/components/primitives/Dialog";
import { Spinner } from "@/components/primitives/Display";
import { api } from "@/services/engine";
import type { ResumeInfo } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage, formatRelative } from "@/utils/format";

/** What kind of file a resume is, from its media type: how it is shown and what it is called. */
export type FileKind = "pdf" | "word" | "picture" | "text";

export function fileKind(item: Pick<ResumeInfo, "media_type" | "file_name">): FileKind {
  const type = item.media_type ?? "";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "picture";
  if (type.includes("wordprocessingml") || /\.docx$/i.test(item.file_name)) return "word";
  return "text";
}

export const KIND_LABEL: Record<FileKind, string> = { pdf: "PDF", word: "Word", picture: "Picture", text: "Text" };

/**
 * The resume as it was uploaded. A PDF and a picture are shown as they are (a picture with the
 * text read from it underneath, to check); a Word file is shown as the text ZHU read from it, and
 * opens in Word for its layout; a text file as itself. A resume uploaded before ZHU kept files
 * shows its text. From here it can be opened in its own program, replaced or removed.
 */
export function ResumePreview({
  item,
  open,
  busy,
  onOpenChange,
  onReplace,
  onRemove,
  onMakeAgain,
}: {
  item: ResumeInfo | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onReplace: () => void;
  onRemove: () => void;
  /** Make the short profile now (after it failed). */
  onMakeAgain: () => void;
}) {
  if (!item) return null;
  const kind = fileKind(item);
  const details = [KIND_LABEL[kind], `${item.words.toLocaleString()} words`, item.uploaded_at ? `added ${formatRelative(item.uploaded_at)}` : ""].filter(Boolean).join(" · ");
  const openIn = async () => {
    try {
      await api.openResumeFile(item.id);
    } catch (err) {
      toast.error("The file could not be opened", errorMessage(err));
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={item.label}
      description={
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="truncate">{item.file_name}</span>
          <span aria-hidden>·</span>
          <span>{details}</span>
        </span>
      }
      footer={
        <>
          {item.has_file ? (
            <Button variant="ghost" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void openIn()}>
              {kind === "word" ? "Open in Word" : "Open in its app"}
            </Button>
          ) : null}
          <Button variant="ghost" icon={<RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />} disabled={busy} className="mr-auto" onClick={onReplace}>
            {busy ? "Reading…" : "Replace"}
          </Button>
          <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="text-danger" onClick={onRemove}>
            Remove
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      {/* A new view for each file, so one file's picture never shows for another. */}
      {open ? <FileView key={item.id} item={item} kind={kind} /> : null}
      {open ? <WhatModelsGet item={item} onMakeAgain={onMakeAgain} /> : null}
    </Modal>
  );
}

function FileView({ item, kind }: { item: ResumeInfo; kind: FileKind }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Word is shown as its text (no layout in a browser); everything else is fetched and shown as it is.
  const fetched = item.has_file && kind !== "word";

  useEffect(() => {
    if (!fetched) return;
    const ctrl = new AbortController();
    let made: string | null = null;
    api
      .resumeFile(item.id, ctrl.signal)
      .then(async (blob) => {
        if (kind === "text") setText(await blob.text());
        else setUrl((made = URL.createObjectURL(blob)));
      })
      .catch((err) => !ctrl.signal.aborted && setError(errorMessage(err)));
    return () => {
      ctrl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [item.id, kind, fetched]);

  const notes: ReactNode[] = [];
  if (!item.has_file) notes.push("This resume was added before ZHU kept the files themselves, so here is the text read from it. Replace it with the same file to see the file.");
  else if (kind === "word") notes.push("Word files are shown here as the text ZHU read from them, which is what models and chat sites receive. Open in Word to see the layout.");
  if (item.ocr) notes.push("The text was read from a picture with Windows text recognition: check names, numbers, dates and email addresses.");
  if (item.truncated) notes.push("The file is longer than ZHU uses: only the first part goes to models and chat sites.");

  return (
    <div className="flex flex-col gap-3">
      {notes.map((n, i) => (
        <p key={i} className="flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-secondary text-accent">
          {i === 0 && item.ocr && notes.length === 1 ? <ScanText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : null}
          <span>{n}</span>
        </p>
      ))}
      {error ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-secondary text-warning">{error}</p>
      ) : fetched && !url && text === null ? (
        <div className="flex h-[60vh] items-center justify-center">
          <Spinner label="Opening the file" />
        </div>
      ) : kind === "pdf" && url ? (
        <iframe title={`${item.file_name} (PDF)`} src={url} className="h-[70vh] w-full rounded-lg border border-border-subtle bg-white" />
      ) : kind === "picture" && url ? (
        <>
          <img src={url} alt={`${item.label}, as uploaded`} className="mx-auto max-h-[60vh] max-w-full rounded-lg border border-border-subtle object-contain" />
          <ReadText title="The text ZHU read from it" text={item.text} />
        </>
      ) : (
        <ReadText text={text ?? item.text} />
      )}
    </div>
  );
}

/**
 * What AI models get with every question: the short profile made from the file once (by one model
 * call), and not the whole file each time. Chat websites get the whole resume, once per new chat.
 */
function WhatModelsGet({ item, onMakeAgain }: { item: ResumeInfo; onMakeAgain: () => void }) {
  const p = item.profile as ResumeInfo["profile"] | undefined;
  if (!p) return null; // an engine from before profiles, still running after an update
  const say = (text: string) => <p className="text-secondary text-fg-2">{text}</p>;
  return (
    <section aria-label="What AI models receive" className="mt-4 flex flex-col gap-2 border-t border-border-subtle pt-4">
      <h3 className="flex items-center gap-2 text-card text-fg">
        <Sparkles className="h-4 w-4 text-accent" aria-hidden />
        What AI models receive
      </h3>
      {p.state === "ready" && p.text ? (
        <>
          {say(`A short profile, made once from your file${p.model ? ` by ${p.model}` : ""}: ${p.words.toLocaleString()} words instead of ${item.words.toLocaleString()}. It goes with every question in place of the whole resume; chat websites get the whole file, once per new chat.`)}
          <div className="selectable max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-2 px-4 py-3 text-body leading-relaxed text-fg">{p.text}</div>
        </>
      ) : p.state === "making" ? (
        <p className="flex items-center gap-2 text-secondary text-fg-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Making a short profile from it. Until it is ready, models get the full text.
        </p>
      ) : p.state === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          {say("The short profile could not be made yet (the model may be busy). Models get the full text for now.")}
          <Button size="sm" variant="secondary" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onMakeAgain}>
            Make it again
          </Button>
        </div>
      ) : p.state === "waiting" ? (
        say("A short profile is made with your next Custom chat answer (or as soon as an AI model is connected). Until then models get the full text.")
      ) : (
        say("It is short already, so models get it as it is.")
      )}
    </section>
  );
}

function ReadText({ text, title }: { text: string; title?: string }) {
  return (
    <section aria-label={title ?? "Resume text"} className="flex flex-col gap-1.5">
      {title ? <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">{title}</h3> : null}
      <div className="selectable max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-2 px-4 py-3 text-body leading-relaxed text-fg">{text}</div>
    </section>
  );
}
