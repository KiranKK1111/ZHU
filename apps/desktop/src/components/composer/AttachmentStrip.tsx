import { X } from "lucide-react";
import { useComposer } from "@/app/state/composer";
import { toast } from "@/app/state/ui";
import { Thumb } from "@/components/capture/Thumb";
import { Tip } from "@/components/primitives/Tooltip";
import { cn } from "@/utils/cn";

/** Attachment chips with thumbnails, always shown before submission (master prompt §14). */
export function AttachmentStrip({ disabledReason, className }: { disabledReason?: string | null; className?: string }) {
  const attachments = useComposer((s) => s.attachments);
  const detach = useComposer((s) => s.detach);
  if (!attachments.length) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} aria-label="Attached screenshots">
      {attachments.map((id, i) => (
        <div key={id} className={cn("group relative overflow-hidden rounded-md border border-border-subtle", disabledReason && "opacity-60")}>
          <Thumb id={id} alt={`Attachment ${i + 1}`} className="h-12 w-[72px]" />
          <span className="absolute bottom-0.5 left-1 rounded-xs bg-scrim px-1 text-[10px] text-fg">{i + 1}</span>
          <Tip label="Remove attachment">
            <button
              type="button"
              aria-label={`Remove attachment ${i + 1}`}
              onClick={() => {
                detach(id);
                toast.info("Attachment removed");
              }}
              className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-scrim text-fg opacity-90 hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </Tip>
        </div>
      ))}
      {disabledReason ? <span className="text-caption text-warning">{disabledReason}</span> : null}
    </div>
  );
}
