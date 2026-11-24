import { useState } from "react";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";

/** The pane sizes the user drags, each a share kept in the preferences. */
export type SplitPref = "questionsSplit" | "transcriptSplit";

/**
 * A pane size the user drags: saved in the preferences when the drag ends, followed live while it
 * goes on (without writing the preferences on every move). Spread it onto a SplitHandle.
 */
export function useSplitPref(key: SplitPref) {
  const saved = usePrefs((p) => p[key]);
  const set = usePrefs((p) => p.set);
  const [live, setLive] = useState<number | null>(null);
  return {
    value: live ?? saved,
    onChange: setLive,
    onCommit: (share: number) => {
      set({ [key]: share });
      setLive(null);
    },
    onReset: () => {
      set({ [key]: DEFAULT_PREFS[key] });
      setLive(null);
    },
  };
}
