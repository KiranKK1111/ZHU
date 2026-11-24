import { useQuery } from "@tanstack/react-query";
import { Check, Copy, GripVertical, ImagePlus, Images, Monitor, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { Thumb } from "@/components/capture/Thumb";
import { Button, IconButton } from "@/components/primitives/Button";
import { ConfirmDialog, Modal } from "@/components/primitives/Dialog";
import { Skeleton } from "@/components/primitives/Display";
import { useCaptureActions } from "@/hooks/useActions";
import { api } from "@/services/engine";
import { addScreenshotsTo, chatTargetLabel, copyScreenshot, currentChatTarget, deleteScreenshots } from "@/services/screenshotActions";
import { beginScreenshotDrag, useScreenshotDrag, wasDragged } from "@/services/screenshotDrag";
import type { Screenshot } from "@/types/engine";
import { cn } from "@/utils/cn";
import { formatBytes, formatDateTime, formatRelative } from "@/utils/format";

/**
 * Every screenshot ZHU has taken, newest first. A screenshot goes into a chat by dragging it onto
 * a message box or with its + button; nothing reaches a model until Send is pressed there.
 */
export function ScreenshotsSection() {
  const shots = useQuery({ queryKey: qk.screenshots(null), queryFn: () => api.screenshots(null) });
  const capture = useCaptureActions();
  const draggingIds = useScreenshotDrag((s) => s.ids);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);

  const list = useMemo(() => shots.data ?? [], [shots.data]);
  // A selection only ever holds screenshots that are still listed.
  useEffect(() => {
    setSelected((cur) => {
      const kept = new Set([...cur].filter((id) => list.some((s) => s.id === id)));
      return kept.size === cur.size ? cur : kept;
    });
  }, [list]);

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Selected screenshots in the order they are listed. */
  const selection = list.filter((s) => selected.has(s.id)).map((s) => s.id);
  const previewed = list.find((s) => s.id === preview) ?? null;

  return (
    <section aria-label="Screenshots" className="flex min-h-[17.5rem] flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 pb-2 pt-3">
        <h2 className="flex-1 text-card text-fg">
          Screenshots
          {list.length ? <span className="ml-2 text-secondary font-normal text-fg-3">{list.length}</span> : null}
        </h2>
        <IconButton label="Capture the whole screen" shortcut="Ctrl+Shift+A" size="sm" onClick={() => void capture.screen("monitor")}>
          <Monitor className="h-4 w-4" />
        </IconButton>
        <IconButton label="Delete all screenshots" size="sm" variant="danger" disabled={!list.length} onClick={() => setDeleting(list.map((s) => s.id))}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>

      {selection.length ? (
        <div className="mx-3 mb-2 flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface-2 py-1 pl-3 pr-1">
          <span className="flex-1 text-secondary text-fg">{selection.length} selected</span>
          <IconButton
            label={`Add to ${chatTargetLabel(currentChatTarget())}`}
            size="sm"
            onClick={() => {
              addScreenshotsTo(currentChatTarget(), selection);
              setSelected(new Set());
            }}
          >
            <ImagePlus className="h-4 w-4" />
          </IconButton>
          <IconButton label="Delete the selected screenshots" size="sm" variant="danger" onClick={() => setDeleting(selection)}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
          <IconButton label="Clear the selection" size="sm" onClick={() => setSelected(new Set())}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        {shots.isLoading ? (
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="aspect-[16/10] w-full" />
            <Skeleton className="aspect-[16/10] w-full" />
          </div>
        ) : list.length === 0 ? (
          // The whole area below the heading, so the box is always seen whole.
          <div className="flex min-h-[9rem] flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-5 text-center">
            <Images className="h-5 w-5 text-fg-3" aria-hidden />
            <p className="text-secondary text-fg-2">No screenshots yet.</p>
            <p className="text-caption text-fg-3">Capture the screen with the button above or Ctrl+Shift+A. Then drag it into a chat.</p>
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-2">
              {list.map((s) => (
                <ScreenshotTile
                  key={s.id}
                  shot={s}
                  selected={selected.has(s.id)}
                  selecting={selected.size > 0}
                  lifted={!!draggingIds?.includes(s.id)}
                  onToggle={() => toggle(s.id)}
                  onOpen={() => setPreview(s.id)}
                  onDelete={() => setDeleting([s.id])}
                  dragIds={selected.has(s.id) ? selection : [s.id]}
                />
              ))}
            </ul>
            <p className="mt-3 flex items-center justify-center gap-1 text-caption text-fg-3">
              <GripVertical className="h-3 w-3" aria-hidden />
              Drag into a message box to attach
            </p>
          </>
        )}
      </div>

      <Modal open={!!previewed} onOpenChange={(o) => !o && setPreview(null)} title="Screenshot" description={previewed ? `${formatDateTime(previewed.created_at)} · ${previewed.width} × ${previewed.height} · ${formatBytes(previewed.bytes)}` : undefined} size="xl">
        {previewed ? (
          <div className="flex flex-col gap-4">
            <Thumb id={previewed.id} alt="Screenshot" full className="max-h-[60vh] min-h-[240px] w-full rounded-lg border border-border-subtle" />
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => {
                  setDeleting([previewed.id]);
                  setPreview(null);
                }}
              >
                Delete
              </Button>
              <Button icon={<Copy className="h-4 w-4" />} onClick={() => void copyScreenshot(previewed.id)}>
                Copy image
              </Button>
              <Button
                variant="primary"
                icon={<ImagePlus className="h-4 w-4" />}
                onClick={() => {
                  addScreenshotsTo(currentChatTarget(), [previewed.id]);
                  setPreview(null);
                }}
              >
                Add to {chatTargetLabel(currentChatTarget())}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting && deleting.length > 1 ? (deleting.length === list.length ? `Delete all ${deleting.length} screenshots?` : `Delete ${deleting.length} screenshots?`) : "Delete this screenshot?"}
        description="The image is removed from this computer and from any message box it is waiting in. Messages already sent keep their text."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (deleting) await deleteScreenshots(deleting);
        }}
      />
    </section>
  );
}

function ScreenshotTile({
  shot,
  selected,
  selecting,
  lifted,
  onToggle,
  onOpen,
  onDelete,
  dragIds,
}: {
  shot: Screenshot;
  selected: boolean;
  selecting: boolean;
  lifted: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDelete: () => void;
  dragIds: string[];
}) {
  const label = `Screenshot from ${formatDateTime(shot.created_at)}`;
  return (
    <li className={cn("group relative overflow-hidden rounded-lg border bg-surface transition-[border-color,opacity,box-shadow] duration-fast", selected ? "border-accent shadow-[0_0_0_1px_var(--zhu-accent)]" : "border-border-subtle hover:border-border", lifted && "opacity-40")}>
      <button
        type="button"
        aria-label={`${label}. Open, or drag into a message box`}
        onPointerDown={(e) => beginScreenshotDrag(e, dragIds)}
        onClick={() => {
          if (wasDragged()) return;
          if (selecting) onToggle();
          else onOpen();
        }}
        className="block w-full touch-none"
      >
        <Thumb id={shot.id} alt={label} fill className="aspect-[16/10] w-full" />
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${label}`}
        onClick={onToggle}
        className={cn(
          "absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-xs border transition-opacity duration-fast",
          selected ? "border-accent bg-accent text-accent-fg opacity-100" : "border-border bg-surface/90 text-transparent opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          selecting && "opacity-100",
        )}
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
      </button>
      <div className="absolute right-1 top-1 flex gap-0.5 rounded-md bg-surface/95 p-0.5 opacity-0 shadow-1 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label={`Add to ${chatTargetLabel(currentChatTarget())}`} size="sm" className="h-6 w-6" onClick={() => addScreenshotsTo(currentChatTarget(), [shot.id])}>
          <ImagePlus className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Copy image" size="sm" className="h-6 w-6" onClick={() => void copyScreenshot(shot.id)}>
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Delete" size="sm" variant="danger" className="h-6 w-6" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-caption text-fg-3">
        <span className="truncate" title={formatDateTime(shot.created_at)}>
          {formatRelative(shot.created_at)}
        </span>
        <span className="shrink-0 tabular-nums">
          {shot.width}×{shot.height}
        </span>
      </div>
    </li>
  );
}
