import * as RDM from "@radix-ui/react-dropdown-menu";
import * as RP from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

export const Menu = RDM.Root;
export const MenuTrigger = RDM.Trigger;

export function MenuContent({ children, align = "end", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <RDM.Portal>
      <RDM.Content align={align} sideOffset={4} collisionPadding={8} className={cn("z-popover min-w-[180px] rounded-md border border-border bg-surface-2 p-1 shadow-2", className)}>
        {children}
      </RDM.Content>
    </RDM.Portal>
  );
}

export function MenuItem({ children, onSelect, danger, disabled, icon }: { children: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; icon?: ReactNode }) {
  return (
    <RDM.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover",
        danger ? "text-danger" : "text-fg",
      )}
    >
      {icon ? <span className="flex h-4 w-4 items-center justify-center text-fg-2">{icon}</span> : null}
      {children}
    </RDM.Item>
  );
}

export function MenuSeparator() {
  return <RDM.Separator className="my-1 h-px bg-border-subtle" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RDM.Label className="px-2 py-1 text-caption text-fg-3">{children}</RDM.Label>;
}

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export function PopoverContent({ children, className, align = "end", side = "bottom" }: { children: ReactNode; className?: string; align?: "start" | "end" | "center"; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RP.Portal>
      <RP.Content align={align} side={side} sideOffset={6} collisionPadding={8} className={cn("z-popover rounded-lg border border-border bg-surface-2 p-3 shadow-2 outline-none", className)}>
        {children}
      </RP.Content>
    </RP.Portal>
  );
}
