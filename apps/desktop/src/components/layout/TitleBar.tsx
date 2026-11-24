import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy as RestoreIcon, House, Minus, PanelRight, Settings, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePrefs } from "@/app/state/prefs";
import { useNav } from "@/app/state/ui";
import { IconButton } from "@/components/primitives/Button";
import { inTauri } from "@/services/shell";
import { HideFromBarsButton } from "./HideFromBarsButton";
import { ListeningControl } from "./ListeningControl";
import { OpacityButton } from "./OpacityButton";
import { Logo } from "./Logo";

/**
 * Custom title bar: the logo, listening (start, pause, stop, with the recording state), buttons
 * for opacity, the taskbar switch, the screenshots panel and Settings, and the window controls.
 * data-tauri-drag-region marks the background as the native drag area, so Tauri handles dragging,
 * double-click maximize and Windows Snap.
 */
export function TitleBar() {
  const sidePanel = usePrefs((p) => p.sidePanelOpen);
  const setPrefs = usePrefs((p) => p.set);
  const inSettings = useNav((s) => s.route === "settings");
  const navigate = useNav((s) => s.navigate);
  return (
    <header data-tauri-drag-region className="relative z-10 flex h-titlebar shrink-0 items-center gap-3 border-b border-border-subtle bg-sidebar pl-3.5 pr-0">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5">
        <Logo size={20} withWordmark />
      </div>
      <div className="flex items-center gap-1">
        <ListeningControl />
        <span aria-hidden className="mx-1 h-5 w-px bg-border-subtle" />
        {inTauri ? <OpacityButton /> : null}
        {inTauri ? <HideFromBarsButton /> : null}
        <IconButton label={sidePanel ? "Hide screenshots and resume" : "Show screenshots and resume"} active={sidePanel} onClick={() => setPrefs({ sidePanelOpen: !sidePanel })}>
          <PanelRight className="h-4 w-4" />
        </IconButton>
        {/* Settings in place of the chats; there, the same button is a house that goes back (Esc does too, see SettingsScreen). */}
        <IconButton label={inSettings ? "Back to the chats" : "Settings"} onClick={() => navigate(inSettings ? "webchats" : "settings")}>
          {inSettings ? <House className="h-4 w-4" /> : <Settings className="h-4 w-4" />}
        </IconButton>
      </div>
      <WindowControls />
    </header>
  );
}

/** Minimize / maximize-restore / close. Used by every full-window header (title bar, setup, splash). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri) return;
    const win = getCurrentWindow();
    let off: (() => void) | undefined;
    let cancelled = false;
    void win.isMaximized().then(setMaximized).catch(() => undefined);
    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized).catch(() => undefined);
      })
      .then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  if (!inTauri) return <div className="w-2" />;
  return (
    <div className="ml-1 flex h-full items-stretch">
      <WindowButton label="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <Minus className="h-4 w-4" />
      </WindowButton>
      <WindowButton label={maximized ? "Restore" : "Maximize"} onClick={() => void getCurrentWindow().toggleMaximize()}>
        {maximized ? <RestoreIcon className="h-3.5 w-3.5 -scale-x-100" /> : <Square className="h-3.5 w-3.5" />}
      </WindowButton>
      <WindowButton label="Close" danger onClick={() => void getCurrentWindow().close()}>
        <X className="h-4 w-4" />
      </WindowButton>
    </div>
  );
}

function WindowButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        "flex w-11 items-center justify-center text-fg-2 transition-colors duration-fast " +
        (danger ? "hover:bg-[var(--zhu-window-close)] hover:text-[var(--zhu-window-close-fg)]" : "hover:bg-hover hover:text-fg")
      }
    >
      {children}
    </button>
  );
}
