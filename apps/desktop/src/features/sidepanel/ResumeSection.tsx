import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FileText, RefreshCw, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { toast } from "@/app/state/ui";
import { Button, IconButton } from "@/components/primitives/Button";
import { Switch } from "@/components/primitives/Controls";
import { ConfirmDialog, Modal } from "@/components/primitives/Dialog";
import { api } from "@/services/engine";
import type { ResumeInfo } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage, formatRelative } from "@/utils/format";

const ACCEPT = ".pdf,.docx,.txt,.md";

/**
 * The user's résumé. Its text is given to the model with every question while it is switched on,
 * and the model works out for itself which questions are about the user. ZHU holds no prepared
 * answers and no list of "profile questions".
 */
export function ResumeSection() {
  const qc = useQueryClient();
  const resume = useQuery({ queryKey: qk.resume, queryFn: api.resume, staleTime: 60_000 });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const info = resume.data ?? null;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const saved = await api.uploadResume(file);
      qc.setQueryData(qk.resume, saved);
      toast.success("Résumé added", saved.truncated ? "It is long: only the first part is used." : `${saved.words.toLocaleString()} words read from ${saved.file_name}.`);
    } catch (err) {
      toast.error("That file could not be used", errorMessage(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ""; // the same file can be chosen again
    }
  };

  const setEnabled = async (enabled: boolean) => {
    try {
      qc.setQueryData(qk.resume, await api.enableResume(enabled));
    } catch (err) {
      toast.error("Not saved", errorMessage(err));
    }
  };

  return (
    <section aria-label="Résumé" className="shrink-0 border-t border-border-subtle px-3 pb-3 pt-3">
      <input ref={input} type="file" accept={ACCEPT} className="hidden" aria-hidden tabIndex={-1} onChange={(e) => void upload(e.target.files?.[0])} />
      <h2 className="mb-2 text-card text-fg">Your résumé</h2>
      {resume.isLoading ? (
        <div className="zhu-skeleton h-[76px] w-full" />
      ) : info ? (
        <ResumeCard info={info} busy={busy} onToggle={(v) => void setEnabled(v)} onView={() => setViewing(true)} onReplace={() => input.current?.click()} onRemove={() => setRemoving(true)} />
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
          className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-4 text-center transition-colors duration-fast hover:border-accent hover:bg-accent-soft disabled:opacity-[var(--zhu-opacity-disabled)]"
        >
          <Upload className={cn("h-4 w-4 text-accent", busy && "animate-pulse")} aria-hidden />
          <span className="text-secondary font-medium text-fg">{busy ? "Reading…" : "Upload your résumé"}</span>
          <span className="text-caption text-fg-3">PDF, Word or text. Questions about you are then answered from it.</span>
        </button>
      )}

      <Modal
        open={viewing && !!info}
        onOpenChange={setViewing}
        title={info?.file_name ?? "Résumé"}
        description="This is the text ZHU read from your file, and exactly what the model receives. Check that nothing important is missing."
        size="lg"
        footer={
          <Button variant="primary" onClick={() => setViewing(false)}>
            Done
          </Button>
        }
      >
        {info?.truncated ? <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-secondary text-warning">The file is longer than ZHU uses. Only the text below is given to the model.</p> : null}
        <pre className="selectable whitespace-pre-wrap break-words font-sans text-secondary leading-relaxed text-fg-2">{info?.text}</pre>
      </Modal>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove your résumé?"
        description="Its text is deleted from this computer. Answers will no longer draw on it."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          try {
            await api.deleteResume();
            qc.setQueryData(qk.resume, null);
            toast.success("Résumé removed");
          } catch (err) {
            toast.error("Could not remove the résumé", errorMessage(err));
          }
        }}
      />
    </section>
  );
}

function ResumeCard({ info, busy, onToggle, onView, onReplace, onRemove }: { info: ResumeInfo; busy: boolean; onToggle: (v: boolean) => void; onView: () => void; onReplace: () => void; onRemove: () => void }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface">
      <div className="flex items-center gap-2.5 px-3 pt-2.5">
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", info.enabled ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-3")}>
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-secondary font-medium text-fg" title={info.file_name}>
            {info.file_name}
          </div>
          <div className="truncate text-caption text-fg-3">
            {info.words.toLocaleString()} words{info.uploaded_at ? ` · ${formatRelative(info.uploaded_at)}` : ""}
            {info.truncated ? " · shortened" : ""}
          </div>
        </div>
        <Switch checked={info.enabled} label="Use the résumé in answers" onCheckedChange={onToggle} />
      </div>
      <p className="px-3 pt-1.5 text-caption text-fg-3">
        {info.enabled ? "Sent with each question, so the model can answer the ones about you in your own voice." : "Kept on this computer, but not sent to any model."}
      </p>
      <div className="mt-1.5 flex items-center gap-0.5 border-t border-border-subtle px-1.5 py-1">
        <Button size="sm" variant="ghost" icon={<Eye className="h-3.5 w-3.5" />} onClick={onView}>
          View text
        </Button>
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />} disabled={busy} onClick={onReplace}>
          Replace
        </Button>
        <IconButton label="Remove the résumé" size="sm" variant="danger" className="ml-auto" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
    </div>
  );
}
