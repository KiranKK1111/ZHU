import { cn } from "@/utils/cn";

/** Displays an accelerator ("CommandOrControl+Shift+S" -> "Ctrl Shift S"). */
export function Kbd({ children, className }: { children: string; className?: string }) {
  const keys = children.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl").split("+");
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((k, i) => (
        <kbd key={i} className="rounded-xs border border-border bg-surface px-1 font-sans text-[10.5px] leading-4 text-fg-2">
          {k}
        </kbd>
      ))}
    </span>
  );
}
