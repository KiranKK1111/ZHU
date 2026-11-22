import { AnimatePresence, motion } from "framer-motion";
import { MousePointerClick } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EngineGate } from "@/app/providers/EngineGate";
import { usePrefs } from "@/app/state/prefs";
import { Kbd } from "@/components/primitives/Kbd";
import { SidecarCompactBar, SidecarFooter, SidecarHeader, SidecarLatestQuestion, SidecarTranscript } from "@/components/sidecar/SidecarParts";
import { applyCompact } from "@/components/sidecar/sidecarWindow";
import { useEventStream } from "@/hooks/useEventStream";
import { useSessionData } from "@/hooks/useSessionData";
import { onShellEvent } from "@/services/shell";

/**
 * Floating sidecar (UI prompt §12–13). It shares the engine event stream, so it
 * always shows the same live state as the main window. Components are shared
 * with the workspace (QuestionCard, TranscriptView, RecordingIndicator).
 */
export default function SidecarApp() {
  const opacity = usePrefs((p) => p.sidecarOpacity);
  useEffect(() => {
    // Edge snapping and off-screen recovery are owned by the Rust shell (src-tauri/src/sidecar.rs).
    document.documentElement.classList.add("zhu-transparent");
  }, []);
  return (
    <div className="h-full w-full p-px" style={{ opacity }}>
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2">
        <EngineGate compact>
          <SidecarConnected />
        </EngineGate>
      </div>
    </div>
  );
}

function SidecarConnected() {
  useEventStream("sidecar");
  useSessionData();
  const compact = usePrefs((p) => p.sidecarCompact);
  const set = usePrefs((p) => p.set);
  const hotkey = usePrefs((p) => p.hotkeys.toggle_click_through);
  const [clickThrough, setClickThrough] = useState(false);

  const first = useRef(true);
  useEffect(() => {
    // On first mount keep the size the shell restored, unless the sidecar starts compact.
    if (first.current) {
      first.current = false;
      if (!compact) return;
    }
    void applyCompact(compact);
  }, [compact]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onShellEvent<boolean>("zhu://click-through", setClickThrough).then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return (
    <div className="relative flex h-full flex-col">
      <AnimatePresence initial={false} mode="wait">
        {compact ? (
          <motion.div key="compact" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <SidecarCompactBar onExpand={() => set({ sidecarCompact: false })} />
          </motion.div>
        ) : (
          <motion.div key="full" className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}>
            <SidecarHeader onCompact={() => set({ sidecarCompact: true })} />
            <SidecarTranscript />
            <SidecarLatestQuestion />
            <SidecarFooter />
          </motion.div>
        )}
      </AnimatePresence>
      {clickThrough ? (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-caption text-fg-2 shadow-2" role="status">
          <MousePointerClick className="h-3.5 w-3.5" /> Click-through on · <Kbd>{hotkey}</Kbd>
        </div>
      ) : null}
    </div>
  );
}
