/**
 * How see-through ZHU is (the opacity control in the title bar). The shell applies it to every
 * ZHU window with Windows' own transparency, so it covers the chat tabs too (src-tauri/src/opacity.rs).
 *
 * Two levels: the everyday one, saved in the preferences, and the one while ZHU is hidden (the eye
 * button). Hiding ZHU sets it to 80%; it can be changed from there, and showing ZHU again brings
 * back the everyday level. A ZHU that closed hidden opens hidden, at the level it had then (the
 * shell keeps it, src-tauri/src/start_state.rs).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { usePrefs } from "@/app/state/prefs";
import { inTauri, onShellEvent, shell } from "@/services/shell";

/** Where the opacity starts when ZHU is hidden. */
export const HIDDEN_OPACITY = 0.8;
/** The least the slider offers; the window stays readable and cannot get lost. */
export const MIN_OPACITY = 0.4;

interface HiddenLook {
  /** ZHU is hidden from the taskbar, Alt+Tab and screen capture (as the shell reports). */
  hidden: boolean;
  /** The shell has said whether ZHU is hidden; until then no opacity is applied (a page loading
   * in a hidden ZHU would otherwise make it fully opaque for a moment, and the shell would keep
   * that as the hidden level). */
  known: boolean;
  /** The opacity while hidden. */
  hiddenLevel: number;
  /** `level`: the opacity to be hidden at, when ZHU is found hidden (it opened that way). */
  setHidden: (hidden: boolean, level?: number) => void;
  setHiddenLevel: (level: number) => void;
}

export const useHiddenLook = create<HiddenLook>((set, get) => ({
  hidden: false,
  known: false,
  hiddenLevel: HIDDEN_OPACITY,
  // Every time ZHU becomes hidden, it starts at 80%.
  setHidden: (hidden, level) =>
    set(hidden && !get().hidden ? { hidden, known: true, hiddenLevel: clampOpacity(level ?? HIDDEN_OPACITY) } : { hidden, known: true }),
  setHiddenLevel: (level) => set({ hiddenLevel: level }),
}));

export function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(1, Math.max(MIN_OPACITY, value)) * 100) / 100 : 1;
}

/** The opacity in effect now, and a way to change it (the level of the current mode). */
export function useWindowOpacity(): { opacity: number; hidden: boolean; setOpacity: (value: number) => void } {
  const everyday = usePrefs((p) => p.windowOpacity);
  const { hidden, hiddenLevel, setHiddenLevel } = useHiddenLook();
  const setPrefs = usePrefs((p) => p.set);
  return {
    opacity: hidden ? hiddenLevel : everyday,
    hidden,
    setOpacity: (value) => (hidden ? setHiddenLevel(clampOpacity(value)) : setPrefs({ windowOpacity: clampOpacity(value) })),
  };
}

/**
 * Keeps ZHU's windows at the opacity in effect, and follows the hide switch (the eye button or
 * the tray menu). Used once, by the main window, whether or not the engine is running.
 */
export function useOpacitySync(): void {
  const { opacity } = useWindowOpacity();
  const setHidden = useHiddenLook((s) => s.setHidden);
  const known = useHiddenLook((s) => s.known);
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    // Hidden already when the page loads (ZHU opened the way it closed): at the level it had.
    void shell
      .hiddenFromBars()
      .then(async (hidden) => {
        const level = hidden ? await Promise.resolve().then(() => shell.hiddenOpacity()).catch(() => null) : null;
        if (!cancelled) setHidden(hidden, level ?? undefined);
      })
      .catch(() => !cancelled && setHidden(false));
    void onShellEvent<boolean>("zhu://hidden-from-bars", setHidden).then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [setHidden]);
  useEffect(() => {
    if (inTauri && known) void shell.setWindowOpacity(opacity).catch(() => undefined);
  }, [opacity, known]);
}
