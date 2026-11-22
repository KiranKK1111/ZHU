import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/utils/cn";

const base =
  "w-full rounded-md border border-border bg-surface-2 text-body text-fg placeholder:text-fg-3 transition-[border-color,box-shadow] duration-fast ease-standard " +
  "hover:border-[var(--zhu-text-3)] focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--zhu-accent-soft)] disabled:opacity-[var(--zhu-opacity-disabled)]";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, leading, trailing, ...rest }, ref) {
  if (!leading && !trailing) {
    return <input ref={ref} className={cn(base, "h-[var(--zhu-control-h)] px-3", className)} {...rest} />;
  }
  return (
    <div className={cn("relative flex items-center", className)}>
      {leading ? <span className="pointer-events-none absolute left-2.5 flex text-fg-3">{leading}</span> : null}
      <input ref={ref} className={cn(base, "h-[var(--zhu-control-h)]", leading ? "pl-8" : "pl-3", trailing ? "pr-8" : "pr-3")} {...rest} />
      {trailing ? <span className="absolute right-1.5 flex">{trailing}</span> : null}
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(base, "min-h-[80px] resize-y px-3 py-2 leading-relaxed", className)} {...rest} />;
});

export function Field({ label, hint, children, htmlFor, className }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-secondary font-medium text-fg">
        {label}
      </label>
      {children}
      {hint ? <p className="text-caption text-fg-3">{hint}</p> : null}
    </div>
  );
}
