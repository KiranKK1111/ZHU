import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/utils/cn";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";

/** Modal dialog with focus trapping, Escape to close and a labelled title (Radix). */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-modal bg-scrim backdrop-blur-[2px] data-[state=open]:animate-[zhu-fade_var(--zhu-motion-normal)_var(--zhu-ease-standard)]" />
        <RD.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-modal flex max-h-[85vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-surface shadow-3",
            "data-[state=open]:animate-[zhu-pop_var(--zhu-motion-normal)_var(--zhu-ease-emphasized)]",
            width,
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <div className="min-w-0">
              <RD.Title className="text-section text-fg">{title}</RD.Title>
              {description ? <RD.Description className="mt-0.5 text-secondary text-fg-2">{description}</RD.Description> : <RD.Description className="sr-only">{title}</RD.Description>}
            </div>
            <RD.Close asChild>
              <IconButton label="Close" size="sm" noTooltip>
                <X className="h-4 w-4" />
              </IconButton>
            </RD.Close>
          </div>
          {children ? <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div> : null}
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">{footer}</div> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  onConfirm,
  typedConfirmation,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void> | void;
  typedConfirmation?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const blocked = !!typedConfirmation && typed !== typedConfirmation;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) setTyped("");
        onOpenChange(o);
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
                setTyped("");
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {typedConfirmation ? (
        <label className="block text-secondary text-fg-2">
          Type <span className="font-mono text-fg">{typedConfirmation}</span> to confirm
          <Input className="mt-2" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label={`Type ${typedConfirmation} to confirm`} />
        </label>
      ) : null}
    </Modal>
  );
}

/** Right-side drawer (context panel in compact layouts). */
export function Drawer({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-drawer bg-scrim" />
        <RD.Content className="fixed bottom-0 right-0 top-[var(--zhu-titlebar-h)] z-drawer flex w-[min(340px,92vw)] flex-col border-l border-border bg-sidebar shadow-3 data-[state=open]:animate-[zhu-slide-in_var(--zhu-motion-normal)_var(--zhu-ease-standard)]">
          <RD.Title className="sr-only">{title}</RD.Title>
          <RD.Description className="sr-only">{title}</RD.Description>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
