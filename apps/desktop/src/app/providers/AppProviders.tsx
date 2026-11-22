import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { currentPrefs, usePrefs, type Prefs } from "@/app/state/prefs";
import { Toaster } from "@/components/layout/Toaster";
import { installZhuCursors } from "@/styles/cursors";
import { TooltipProvider } from "@/components/primitives/Tooltip";
import { EngineHttpError } from "@/services/engine";
import { bindQueryClient } from "@/services/ask";
import { onShellEvent, shell } from "@/services/shell";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, err) => {
          if (err instanceof EngineHttpError && err.status >= 400 && err.status < 500) return false;
          return count < 2;
        },
      },
    },
  });
}

/** Whether ZHU is hidden (the eye button, or the tray menu). The shell holds the state and announces changes. */
function useHiddenFromBars(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void Promise.resolve()
      .then(() => shell.hiddenFromBars())
      .then((h) => {
        if (!cancelled) setHidden(h === true);
      })
      .catch(() => undefined); // not in the desktop app
    void Promise.resolve()
      .then(() => onShellEvent<boolean>("zhu://hidden-from-bars", setHidden))
      .then((u) => (cancelled ? u() : (off = u)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  return hidden;
}

/** Applies the theme and the pointer style to <html>. Reduced motion follows the Windows setting. */
function ThemeEffect() {
  const theme = usePrefs((p) => p.theme);
  const customCursor = usePrefs((p) => p.customCursor);
  const hidden = useHiddenFromBars();
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const fn = () => setSystemDark(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
    root.dataset.density = "comfortable";
  }, [theme, systemDark]);

  // ZHU's own pointer, for as long as the preference is on and ZHU is not hidden. A screen share
  // or recording shows the mouse pointer as it is, so over a hidden ZHU it stays the Windows one.
  useEffect(() => (customCursor && !hidden ? installZhuCursors() : undefined), [customCursor, hidden]);
  return null;
}

/** Receives preference changes made in another window. */
function PrefsSync() {
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onShellEvent<Prefs>("zhu://prefs", (p) => {
      const mine = JSON.stringify(currentPrefs());
      if (JSON.stringify(p) !== mine) usePrefs.getState().applyRemote(p);
    }).then((u) => (cancelled ? u() : (off = u)));
    const onStorage = (e: StorageEvent) => {
      if (e.key === "zhu.prefs.v1" && e.newValue) {
        try {
          usePrefs.getState().applyRemote(JSON.parse(e.newValue) as Prefs);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      off?.();
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}

export function AppProviders({ children, toasts = true }: { children: ReactNode; toasts?: boolean }) {
  const [client] = useState(() => {
    const c = makeClient();
    bindQueryClient(c);
    return c;
  });
  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={450} skipDelayDuration={200}>
          <ThemeEffect />
          <PrefsSync />
          {children}
          {toasts ? <Toaster /> : null}
        </TooltipProvider>
      </MotionConfig>
    </QueryClientProvider>
  );
}
