import { ROUTES, type RouteId } from "@/app/routing/routes";
import { useNav } from "@/app/state/ui";
import { Tip } from "@/components/primitives/Tooltip";
import { cn } from "@/utils/cn";

/** Four destinations. Labels are always shown, except in a narrow window where only the icons fit. */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const route = useNav((s) => s.route);
  const navigate = useNav((s) => s.navigate);
  return (
    <nav aria-label="Main navigation" className={cn("flex shrink-0 flex-col gap-0.5 border-r border-border-subtle bg-sidebar px-2.5 py-3", collapsed ? "w-sidebar-collapsed" : "w-[188px]")}>
      {ROUTES.map((r) => (
        <NavItem key={r.id} id={r.id} label={r.label} Icon={r.icon} active={route === r.id} collapsed={collapsed} last={r.id === "settings"} onSelect={() => navigate(r.id)} />
      ))}
    </nav>
  );
}

function NavItem({ id, label, Icon, active, collapsed, last, onSelect }: { id: RouteId; label: string; Icon: React.ComponentType<{ className?: string }>; active: boolean; collapsed: boolean; last: boolean; onSelect: () => void }) {
  const btn = (
    <button
      type="button"
      data-nav={id}
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "relative flex h-10 w-full items-center gap-3 rounded-lg text-body transition-colors duration-fast ease-standard",
        collapsed ? "justify-center px-0" : "px-3",
        last && "mt-auto",
        active ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      <Icon className={cn("h-[18px] w-[18px] shrink-0", active ? "text-accent" : "")} />
      {!collapsed ? <span className="truncate">{label}</span> : null}
    </button>
  );
  return collapsed ? (
    <Tip label={label} side="right">
      {btn}
    </Tip>
  ) : (
    btn
  );
}
