import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Kbd } from "./Kbd";

export const TooltipProvider = RT.Provider;

export function Tip({
  label,
  shortcut,
  side = "bottom",
  children,
  disabled,
}: {
  label: ReactNode;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
  disabled?: boolean;
}) {
  if (disabled) return <>{children}</>;
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-popover flex max-w-xs items-center gap-2 rounded-sm border border-border bg-surface-2 px-2 py-1 text-caption text-fg shadow-2"
        >
          <span>{label}</span>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
