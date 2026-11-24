import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, FileText, Plus, Upload } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { qk } from "@/app/providers/queryKeys";
import { currentPrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { Switch } from "@/components/primitives/Controls";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { api, type ModelChoice } from "@/services/engine";
import type { Condensed, ResumesState } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";
import { JobEditor } from "./ResumeEditors";
import { fileKind, KIND_LABEL, ResumePreview } from "./ResumePreview";

/** What can be uploaded: documents, and pictures of a page (read with Windows text recognition). */
export const RESUME_ACCEPT = ".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp";

/** The model the Custom chat uses: it condenses the resume into its short profile, once. */
export function chatModel(): ModelChoice {
  const p = currentPrefs();
  return { provider_id: p.chatProvider, model: p.chatModel };
}

/** What the card says about the short profile models get. */
export function condensedLabel(c: Condensed | undefined, words: number): string {
  // An engine from before profiles (still running after an update) sends none: the words, as before.
  if (c?.state === "ready") return "Short profile ready";
  if (c?.state === "making") return "Making short profile…";
  if (c?.state === "failed") return "Full text for now";
  return `${words.toLocaleString()} words`;
}

/**
 * The user's resume and the job they are applying for, side by side as two cards of one size.
 * One resume is kept (a new upload replaces it); its card opens the file as it was uploaded. The
 * job's card opens the job to read and change. Each has a switch: while on, it goes to the model
 * with every question and to chat websites with the first question of a new chat, and the model
 * works out for itself which questions are about the user.
 */
export function ResumeSection() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.resume, queryFn: api.resumes, staleTime: 60_000 });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [editingJob, setEditingJob] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removingJob, setRemovingJob] = useState(false);
  const state = query.data ?? null;
  const resume = state?.items.find((r) => r.id === state.active_id) ?? null;
  const job = state?.job ?? null;

  const run = async (what: string, action: () => Promise<ResumesState>): Promise<ResumesState | null> => {
    try {
      const next = await action();
      qc.setQueryData(qk.resume, next);
      return next;
    } catch (err) {
      toast.error(what, errorMessage(err));
      return null;
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const replacing = !!resume;
      const next = await run("That file could not be used", () => api.uploadResume(file, chatModel()));
      const added = next?.items.find((r) => r.id === next.active_id);
      if (!added) return;
      const title = replacing ? "Resume replaced" : "Resume added";
      if (added.ocr) {
        toast.success(title, "It was read from a picture: check the text for misread names and numbers.");
        setPreviewing(true); // shown right away, with the text read from it, so it gets checked
      } else {
        toast.success(title, added.truncated ? "It is long: only the first part is used." : `${added.words.toLocaleString()} words read from ${added.file_name}.`);
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ""; // the same file can be chosen again
    }
  };
  const choose = () => input.current?.click();

  return (
    <section aria-label="Resume and job" className="shrink-0 border-t border-border-subtle px-3 pb-3 pt-3">
      <input ref={input} type="file" accept={RESUME_ACCEPT} className="hidden" aria-hidden tabIndex={-1} onChange={(e) => void upload(e.target.files?.[0])} />
      <h2 className="mb-2 text-card text-fg">Resume and job</h2>
      {query.isLoading ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="zhu-skeleton h-[152px] rounded-xl" />
          <div className="zhu-skeleton h-[152px] rounded-xl" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {resume ? (
            <Card
              icon={<FileText className="h-[18px] w-[18px]" />}
              caption="Resume"
              title={resume.label}
              detail={`${KIND_LABEL[fileKind(resume)]} · ${condensedLabel(resume.profile, resume.words)}`}
              open={`Open your resume: ${resume.label}`}
              onOpen={() => setPreviewing(true)}
              on={!!state?.enabled}
              switchLabel="Use the resume in answers"
              onToggle={(v) => void run("Not saved", () => api.selectResume({ enabled: v }))}
            />
          ) : (
            <AddCard icon={<Upload className={cn("h-[18px] w-[18px]", busy && "animate-pulse")} />} title={busy ? "Reading…" : "Your resume"} disabled={busy} onClick={choose}>
              PDF, Word, text or a picture of the page
            </AddCard>
          )}
          {job ? (
            <Card
              icon={<Briefcase className="h-[18px] w-[18px]" />}
              caption="Job"
              title={job.title || "Job description"}
              detail={condensedLabel(job.brief, job.words)}
              open={`Open the job: ${job.title || "job description"}`}
              onOpen={() => setEditingJob(true)}
              on={job.enabled}
              switchLabel="Use the job in answers"
              onToggle={(v) => void run("Not saved", () => api.enableJob(v))}
            />
          ) : (
            <AddCard icon={<Plus className="h-[18px] w-[18px]" />} title="The job" onClick={() => setEditingJob(true)}>
              Paste or upload the job description
            </AddCard>
          )}
        </div>
      )}

      <ResumePreview
        item={resume}
        open={previewing && !!resume}
        busy={busy}
        onOpenChange={setPreviewing}
        onReplace={choose}
        onRemove={() => setRemoving(true)}
        onMakeAgain={() => void run("The short profile was not made", () => api.condenseResume(chatModel()))}
      />
      <JobEditor
        open={editingJob}
        job={job}
        limit={state?.limits.job_chars ?? 12_000}
        accept={RESUME_ACCEPT}
        onOpenChange={setEditingJob}
        onRemove={job ? () => setRemovingJob(true) : undefined}
        onSave={async (body) => !!(await run("Not saved", () => api.setJob(body, chatModel())))}
        onUpload={async (file, title) => {
          const next = await run("That file could not be used", () => api.uploadJob(file, title, chatModel()));
          if (next?.job) toast.success("Job added", next.job.ocr ? "It was read from a picture: check the text." : `${next.job.words.toLocaleString()} words read from ${file.name}.`);
          return !!next;
        }}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove “${resume?.label ?? "your resume"}”?`}
        description="The file and its text are deleted from this computer. Answers no longer draw on a resume until you upload one again."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!resume) return;
          if (await run("Could not remove the resume", () => api.deleteResume(resume.id))) {
            setPreviewing(false);
            toast.success("Resume removed");
          }
        }}
      />
      <ConfirmDialog
        open={removingJob}
        onOpenChange={setRemovingJob}
        title="Remove the job?"
        description="The job description is deleted from this computer. Answers no longer refer to it."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (await run("Could not remove the job", () => api.deleteJob())) {
            setEditingJob(false);
            toast.success("Job removed");
          }
        }}
      />
    </section>
  );
}

/** A filled card: the whole card opens it; the switch at the bottom decides whether answers use it. */
function Card({
  icon,
  caption,
  title,
  detail,
  open,
  onOpen,
  on,
  switchLabel,
  onToggle,
}: {
  icon: ReactNode;
  caption: string;
  title: string;
  detail: string;
  open: string;
  onOpen: () => void;
  on: boolean;
  switchLabel: string;
  onToggle: (v: boolean) => void;
}) {
  return (
    <div className="group relative flex min-h-[152px] min-w-0 flex-col rounded-xl border border-border-subtle bg-surface p-3 transition-colors duration-fast hover:border-border hover:bg-surface-2">
      {/* The card itself is the button; the switch sits above it. */}
      <button type="button" aria-label={open} title={open} onClick={onOpen} className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors duration-fast",
          on ? "bg-accent-soft text-accent" : "bg-surface-2 text-fg-3",
        )}
      >
        {icon}
      </span>
      <div className="pointer-events-none mt-2.5 min-w-0 flex-1">
        <div className="text-caption font-medium text-fg-3">{caption}</div>
        <div className="mt-0.5 line-clamp-2 break-words text-secondary font-medium leading-snug text-fg" title={title}>
          {title}
        </div>
        <div className="mt-0.5 truncate text-caption text-fg-3" title={detail}>
          {detail}
        </div>
      </div>
      <div className="relative mt-2 flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
        <span className={cn("text-caption", on ? "text-fg-2" : "text-fg-3")}>{on ? "In answers" : "Not used"}</span>
        <Switch checked={on} label={switchLabel} onCheckedChange={onToggle} />
      </div>
    </div>
  );
}

/** An empty card: adds the resume (a file) or the job. */
function AddCard({ icon, title, children, disabled, onClick }: { icon: ReactNode; title: string; children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-[152px] min-w-0 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-center transition-colors duration-fast hover:border-accent hover:bg-accent-soft disabled:opacity-[var(--zhu-opacity-disabled)]"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent" aria-hidden>
        {icon}
      </span>
      <span className="text-secondary font-medium text-fg">{title}</span>
      <span className="text-caption leading-snug text-fg-3">{children}</span>
    </button>
  );
}
