import { ScanText, Trash2, Upload } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/primitives/Button";
import { ConfirmDialog, Modal } from "@/components/primitives/Dialog";
import { Field, Input, Textarea } from "@/components/primitives/Input";
import type { JobInfo } from "@/types/engine";
import { cn } from "@/utils/cn";

function Notice({ children, tone = "warning", icon }: { children: ReactNode; tone?: "warning" | "info"; icon?: ReactNode }) {
  return (
    <p className={cn("mb-3 flex items-start gap-2 rounded-md px-3 py-2 text-secondary", tone === "warning" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent")}>
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </p>
  );
}

function Counter({ length, limit }: { length: number; limit: number }) {
  const over = length > limit;
  return (
    <span className={cn("tabular-nums", over ? "text-danger" : "text-fg-3")} aria-live="polite">
      {length.toLocaleString()} of {limit.toLocaleString()} characters{over ? `: ${(length - limit).toLocaleString()} too many` : ""}
    </span>
  );
}

/** Closing with unsaved changes asks first; everything else closes at once. */
function useGuardedClose(dirty: boolean, close: () => void) {
  const [asking, setAsking] = useState(false);
  const request = (open: boolean) => {
    if (open) return;
    if (dirty) setAsking(true);
    else close();
  };
  const dialog = (
    <ConfirmDialog
      open={asking}
      onOpenChange={setAsking}
      title="Discard your changes?"
      description="What you changed here is not saved."
      confirmLabel="Discard"
      destructive
      onConfirm={close}
    />
  );
  return { request, dialog };
}

// ------------------------------------------------------------------ job
export function JobEditor(props: {
  open: boolean;
  job: JobInfo | null;
  limit: number;
  accept: string;
  onOpenChange: (open: boolean) => void;
  /** Remove the job (asks first); only for a job that is there. */
  onRemove?: () => void;
  onSave: (body: { title: string; text: string }) => Promise<boolean>;
  onUpload: (file: File, title?: string) => Promise<boolean>;
}) {
  return props.open ? <JobForm key={props.job?.updated_at ?? "new"} {...props} /> : null;
}

function JobForm({
  job,
  limit,
  accept,
  onOpenChange,
  onRemove,
  onSave,
  onUpload,
}: {
  job: JobInfo | null;
  limit: number;
  accept: string;
  onOpenChange: (open: boolean) => void;
  onRemove?: () => void;
  onSave: (body: { title: string; text: string }) => Promise<boolean>;
  onUpload: (file: File, title?: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(job?.title ?? "");
  const [text, setText] = useState(job?.text ?? "");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const textId = useId();
  const dirty = title.trim() !== (job?.title ?? "") || text !== (job?.text ?? "");
  const tooLong = text.trim().length > limit;
  const close = () => onOpenChange(false);
  const guard = useGuardedClose(dirty, close);

  const save = async () => {
    setBusy(true);
    const ok = await onSave({ title: title.trim(), text });
    setBusy(false);
    if (ok) close();
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const ok = await onUpload(file, title.trim() || undefined);
    setBusy(false);
    if (input.current) input.current.value = "";
    if (ok) close();
  };

  return (
    <Modal
      open
      onOpenChange={guard.request}
      size="lg"
      title={job ? "The job" : "Add the job you're applying for"}
      description="Answers about you connect your experience to what this role asks for. It goes with every question while its switch is on, next to your resume."
      footer={
        <>
          <input ref={input} type="file" accept={accept} className="hidden" aria-hidden tabIndex={-1} onChange={(e) => void upload(e.target.files?.[0])} />
          <Button variant="ghost" icon={<Upload className="h-4 w-4" />} className={onRemove ? undefined : "mr-auto"} disabled={busy} onClick={() => input.current?.click()}>
            Read it from a file
          </Button>
          {onRemove ? (
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} className="mr-auto text-danger" disabled={busy} onClick={onRemove}>
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => guard.request(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!dirty || tooLong || !text.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {job?.ocr ? <Notice icon={<ScanText className="h-4 w-4" />}>Read from a picture with Windows text recognition. Check it for misread words.</Notice> : null}
      {job?.truncated ? <Notice>The file was longer than ZHU uses. Only the text below is given to the model.</Notice> : null}
      <div className="flex flex-col gap-3">
        <Field label="Job title" htmlFor={titleId} hint="Optional. For example: Staff Engineer, Payments, at Acme.">
          <Input id={titleId} value={title} maxLength={120} placeholder="Job title and company" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Job description" htmlFor={textId} hint={<Counter length={text.trim().length} limit={limit} />}>
          <Textarea
            id={textId}
            value={text}
            spellCheck
            placeholder="Paste the job posting: what the role does, and what it asks for."
            rows={12}
            className="selectable"
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
      </div>
      {guard.dialog}
    </Modal>
  );
}
