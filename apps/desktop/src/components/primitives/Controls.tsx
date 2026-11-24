/** Switch, Slider, Select, SegmentedControl, Tabs: Radix-based, token-styled. */
import * as RS from "@radix-ui/react-select";
import * as RSl from "@radix-ui/react-slider";
import * as RSw from "@radix-ui/react-switch";
import * as RTabs from "@radix-ui/react-tabs";
import * as RTG from "@radix-ui/react-toggle-group";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export function Switch({ checked, onCheckedChange, label, disabled, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <RSw.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-surface-3 transition-colors duration-fast ease-standard data-[state=checked]:border-transparent data-[state=checked]:bg-accent disabled:opacity-[var(--zhu-opacity-disabled)]"
    >
      <RSw.Thumb className="block h-3.5 w-3.5 translate-x-[3px] rounded-full bg-fg shadow-1 transition-transform duration-fast ease-standard data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-accent-fg" />
    </RSw.Root>
  );
}

export function SwitchRow({ title, description, checked, onCheckedChange, disabled }: { title: string; description?: ReactNode; checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-body text-fg">{title}</div>
        {description ? <div className="text-secondary text-fg-2">{description}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} label={title} disabled={disabled} />
    </div>
  );
}

export function Slider({ value, onValueChange, min, max, step, label, onValueCommit }: { value: number; onValueChange: (v: number) => void; onValueCommit?: (v: number) => void; min: number; max: number; step: number; label: string }) {
  return (
    <RSl.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onValueChange(v[0])}
      onValueCommit={onValueCommit ? (v) => onValueCommit(v[0]) : undefined}
      className="relative flex h-5 w-full touch-none select-none items-center"
      aria-label={label}
    >
      <RSl.Track className="relative h-1 grow overflow-hidden rounded-full bg-surface-3">
        <RSl.Range className="absolute h-full bg-accent" />
      </RSl.Track>
      <RSl.Thumb aria-label={label} className="block h-4 w-4 rounded-full border-2 border-accent bg-surface shadow-1 transition-transform duration-fast hover:scale-110" />
    </RSl.Root>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

const NONE = "__none__";

export function Select({ value, onValueChange, options, placeholder, label, className, disabled, size = "md" }: { value: string | null; onValueChange: (v: string) => void; options: SelectOption[]; placeholder?: string; label: string; className?: string; disabled?: boolean; size?: "sm" | "md" }) {
  return (
    <RS.Root value={value ?? NONE} onValueChange={(v) => v !== NONE && onValueChange(v)} disabled={disabled}>
      <RS.Trigger
        aria-label={label}
        className={cn(
          "inline-flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-surface-2 text-fg transition-colors duration-fast hover:border-[var(--zhu-text-3)] data-[placeholder]:text-fg-3 disabled:opacity-[var(--zhu-opacity-disabled)]",
          size === "sm" ? "h-7 px-2.5 text-secondary" : "h-[var(--zhu-control-h)] px-3 text-body",
          className,
        )}
      >
        <span className="truncate">
          <RS.Value placeholder={placeholder ?? "Select"} />
        </span>
        <RS.Icon>
          <ChevronDown className="h-4 w-4 shrink-0 text-fg-3" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content position="popper" sideOffset={4} className="z-popover max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-surface-2 shadow-2">
          <RS.Viewport className="p-1">
            {value === null ? (
              <RS.Item value={NONE} disabled className="hidden">
                <RS.ItemText>{placeholder ?? "Select"}</RS.ItemText>
              </RS.Item>
            ) : null}
            {options.map((o) => (
              <RS.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-default select-none flex-col rounded-sm py-1.5 pl-7 pr-3 text-body text-fg outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover"
              >
                <RS.ItemIndicator className="absolute left-2 top-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </RS.ItemIndicator>
                <RS.ItemText>{o.label}</RS.ItemText>
                {o.description ? <span className="text-caption text-fg-3">{o.description}</span> : null}
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}

export function Segmented<T extends string>({ value, onValueChange, options, label, size = "md" }: { value: T | null; onValueChange: (v: T) => void; options: { value: T; label: ReactNode; ariaLabel?: string }[]; label: string; size?: "sm" | "md" }) {
  return (
    <RTG.Root
      type="single"
      value={value ?? ""}
      onValueChange={(v) => v && onValueChange(v as T)}
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-md border border-border-subtle bg-surface-2 p-0.5"
    >
      {options.map((o) => (
        <RTG.Item
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm px-2.5 text-secondary text-fg-2 transition-colors duration-fast hover:text-fg data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-1",
            size === "sm" ? "h-6" : "h-7",
          )}
        >
          {o.label}
        </RTG.Item>
      ))}
    </RTG.Root>
  );
}

export const Tabs = RTabs.Root;
export const TabsContent = RTabs.Content;

export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <RTabs.List aria-label={label} className={cn("flex items-center gap-1 border-b border-border-subtle", className)}>
      {children}
    </RTabs.List>
  );
}

export function TabsTrigger({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RTabs.Trigger
      value={value}
      className={cn(
        "relative inline-flex h-9 items-center gap-2 px-3 text-secondary font-medium text-fg-2 transition-colors duration-fast hover:text-fg data-[state=active]:text-fg",
        "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors data-[state=active]:after:bg-accent",
        className,
      )}
    >
      {children}
    </RTabs.Trigger>
  );
}
