/**
 * How see-through ZHU is (the opacity control in the title bar). The shell applies it to every
 * ZHU window with Windows' own transparency, so it covers the chat tabs too (src-tauri/src/opacity.rs).
 *
 * Two levels: the everyday one, saved in the preferences, and the one while ZHU is hidden (the eye
 * button). Hiding ZHU sets it to 80%; it can be changed from there, and showing ZHU again brings
 * back the everyday level.
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
  /** The opacity while hidden. */
  hiddenLevel: number;
  setHidden: (hidden: boolean) => void;
  setHiddenLevel: (level: number) => void;
}

export const useHiddenLook = create<HiddenLook>((set, get) => ({
  hidden: false,
  hiddenLevel: HIDDEN_OPACITY,
  // Every time ZHU becomes hidden, it starts at 80%.
  setHidden: (hidden) => set(hidden && !get().hidden ? { hidden, hiddenLevel: HIDDEN_OPACITY } : { hidden }),
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
  useEffect(() => {
    if (!inTauri) return;
    let off: (() => void) | undefined;
    let cancelled = false;
    void shell
      .hiddenFromBars()
      .then((hidden) => !cancelled && setHidden(hidden))
      .catch(() => undefined);
    void onShellEvent<boolean>("zhu://hidden-from-bars", setHidden).then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, [setHidden]);
  useEffect(() => {
    if (inTauri) void shell.setWindowOpacity(opacity).catch(() => undefined);
  }, [opacity]);
}
