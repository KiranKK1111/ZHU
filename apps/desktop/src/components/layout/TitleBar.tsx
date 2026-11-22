import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy as RestoreIcon, Minus, PanelRight, PictureInPicture2, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePrefs } from "@/app/state/prefs";
import { IconButton } from "@/components/primitives/Button";
import { RecordingIndicator } from "@/components/transcription/RecordingIndicator";
import { useCurrentSession } from "@/hooks/useSessionData";
import { inTauri, shell } from "@/services/shell";
import { HideFromBarsButton } from "./HideFromBarsButton";
import { Logo } from "./Logo";

/**
 * Custom title bar: the logo, the recording state, buttons for the floating sidecar, the taskbar
 * switch and the screenshots panel, and the window controls. data-tauri-drag-region marks the background as the native drag area, so Tauri
 * handles dragging, double-click maximize and Windows Snap.
 */
export function TitleBar() {
  const session = useCurrentSession();
  const sidePanel = usePrefs((p) => p.sidePanelOpen);
  const setPrefs = usePrefs((p) => p.set);
  return (
    <header data-tauri-drag-region className="relative z-10 flex h-titlebar shrink-0 items-center gap-3 border-b border-border-subtle bg-sidebar pl-3.5 pr-0">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5">
        <Logo size={20} withWordmark />
        {session.data ? (
          <span data-tauri-drag-region className="truncate text-secondary text-fg-3">
            {session.data.name}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <RecordingIndicator showElapsed size="sm" />
        {inTauri ? (
          <IconButton label="Show or hide the floating sidecar" shortcut="Ctrl+Shift+Space" onClick={() => void shell.toggleSidecar().catch(() => undefined)}>
            <PictureInPicture2 className="h-4 w-4" />
          </IconButton>
        ) : null}
        {inTauri ? <HideFromBarsButton /> : null}
        <IconButton label={sidePanel ? "Hide screenshots and résumé" : "Show screenshots and résumé"} active={sidePanel} onClick={() => setPrefs({ sidePanelOpen: !sidePanel })}>
          <PanelRight className="h-4 w-4" />
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
