/** Badge, Card, EmptyState, Spinner, Skeleton, ScrollArea, Section header. */
import * as RSA from "@radix-ui/react-scroll-area";
import { Loader2 } from "lucide-react";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/utils/cn";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "recording";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2 border-border-subtle",
  accent: "bg-accent-soft text-accent border-transparent",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  recording: "bg-recording-soft text-recording border-transparent",
};

export function Badge({ children, tone = "neutral", icon, className, title }: { children: ReactNode; tone?: Tone; icon?: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-xs border px-1.5 text-caption", tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card({ className, ...rest }, ref) {
  return <div ref={ref} className={cn("zhu-card", className)} {...rest} />;
});

export function CardHeader({ title, icon, actions, subtitle }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {icon ? <span className="flex text-fg-3">{icon}</span> : null}
        <div className="min-w-0">
          <h3 className="truncate text-card text-fg">{title}</h3>
          {subtitle ? <div className="truncate text-caption text-fg-3">{subtitle}</div> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, compact }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 px-4 py-6" : "gap-3 px-6 py-14")}>
      {icon ? <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-3">{icon}</div> : null}
      <div>
        <div className="text-card text-fg">{title}</div>
        {description ? <div className="mx-auto mt-1 max-w-sm text-secondary text-fg-2">{description}</div> : null}
      </div>
      {action}
    </div>
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-secondary text-fg-2", className)}>
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label ? <span>{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("zhu-skeleton", className)} aria-hidden />;
}

export function ErrorState({ title = "Something went wrong", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-transparent bg-danger-soft px-4 py-3">
      <div className="text-body font-medium text-danger">{title}</div>
      <div className="text-secondary text-fg-2">{message}</div>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="text-secondary font-medium text-fg underline-offset-2 hover:underline">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export const ScrollArea = forwardRef<HTMLDivElement, { children: ReactNode; className?: string; viewportClassName?: string; onScroll?: React.UIEventHandler<HTMLDivElement> }>(function ScrollArea(
  { children, className, viewportClassName, onScroll },
  ref,
) {
  return (
    <RSA.Root type="hover" className={cn("relative overflow-hidden", className)}>
      <RSA.Viewport ref={ref} onScroll={onScroll} className={cn("h-full w-full [&>div]:!block", viewportClassName)}>
        {children}
      </RSA.Viewport>
      <RSA.Scrollbar orientation="vertical" className="flex w-2.5 touch-none select-none p-0.5 transition-opacity duration-fast">
        <RSA.Thumb className="relative flex-1 rounded-full bg-surface-3 hover:bg-border" />
      </RSA.Scrollbar>
      <RSA.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none select-none flex-col p-0.5">
        <RSA.Thumb className="relative flex-1 rounded-full bg-surface-3" />
      </RSA.Scrollbar>
    </RSA.Root>
  );
});

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="zhu-display text-page text-fg">{title}</h1>
        {description ? <p className="mt-1 text-secondary text-fg-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">{children}</h2>
      {actions}
    </div>
  );
}
