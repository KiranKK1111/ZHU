import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { Tip } from "./Tooltip";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-1",
  secondary: "bg-surface-2 text-fg hover:bg-surface-3 border border-border-subtle",
  outline: "bg-transparent text-fg border border-border hover:bg-hover",
  ghost: "bg-transparent text-fg-2 hover:text-fg hover:bg-hover",
  subtle: "bg-accent-soft text-accent hover:brightness-110",
  danger: "bg-danger-soft text-danger hover:brightness-110 border border-transparent",
};
const sizes: Record<Size, string> = {
  sm: "h-[var(--zhu-control-h-sm)] px-2.5 text-secondary gap-1.5 rounded-sm",
  md: "h-[var(--zhu-control-h)] px-3 text-body gap-2 rounded-md",
  lg: "h-10 px-4 text-body gap-2 rounded-md",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,filter,box-shadow,transform] duration-fast ease-standard",
        "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-[var(--zhu-opacity-disabled)]",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary" | "danger" | "subtle";
  active?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  noTooltip?: boolean;
}

/** Icon-only button: always has an accessible name and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, size = "md", variant = "ghost", active, className, children, tooltipSide = "bottom", noTooltip, type = "button", ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm transition-[background-color,color,transform] duration-fast ease-standard active:scale-[0.96]",
        "disabled:pointer-events-none disabled:opacity-[var(--zhu-opacity-disabled)]",
        size === "sm" ? "h-7 w-7" : "h-8 w-8",
        variant === "ghost" && (active ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg"),
        variant === "secondary" && "border border-border-subtle bg-surface-2 text-fg hover:bg-surface-3",
        variant === "danger" && "text-fg-2 hover:bg-danger-soft hover:text-danger",
        variant === "subtle" && "bg-accent-soft text-accent hover:brightness-110",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  if (noTooltip) return btn;
  return (
    <Tip label={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tip>
  );
});
