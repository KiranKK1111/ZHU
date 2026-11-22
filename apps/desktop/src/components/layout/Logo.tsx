import { cn } from "@/utils/cn";

/**
 * The ZHU mark. It is the same file as every other icon of the app (taskbar, tray, installer,
 * floating icon): public/zhu-mark.svg, from which `npm run icons` renders src-tauri/icons.
 */
export const MARK_URL = "/zhu-mark.svg";

export function Logo({ size = 22, withWordmark = false, className }: { size?: number; withWordmark?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)} aria-label="ZHU">
      <img src={MARK_URL} width={size} height={size} alt="" aria-hidden draggable={false} className="pointer-events-none shrink-0 select-none" />
      {withWordmark ? <span className="zhu-display text-[15px] font-[650] tracking-[0.08em] text-fg">ZHU</span> : null}
    </span>
  );
}
