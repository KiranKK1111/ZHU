import { AnimatePresence, motion } from "framer-motion";
import { Suspense, useRef } from "react";
import { ROUTE_BY_ID } from "@/app/routing/routes";
import { usePrefs } from "@/app/state/prefs";
import { useNav } from "@/app/state/ui";
import { Skeleton } from "@/components/primitives/Display";
import { SidePanel } from "@/features/sidepanel/SidePanel";
import { useLayoutMode } from "@/hooks/useMisc";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";

/**
 * Title bar, a four-item sidebar, the current screen, and the panel for screenshots and the résumé
 * on the right. The sidebar shrinks to icons in a narrow window.
 */
export function AppShell() {
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useLayoutMode(rootRef);
  const route = useNav((s) => s.route);
  const sidePanel = usePrefs((p) => p.sidePanelOpen);
  const def = ROUTE_BY_ID[route] ?? ROUTE_BY_ID.home;
  const Screen = def.component;

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-bg text-fg">
      <TitleBar />
      <div className="relative flex min-h-0 flex-1">
        <Sidebar collapsed={mode === "compact"} />
        <main className="@container flex min-w-0 flex-1 flex-col" aria-label={def.label}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={def.id} className="min-h-0 flex-1 overflow-hidden" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}>
              <Suspense fallback={<ScreenSkeleton />}>
                <Screen />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
        {sidePanel ? <SidePanel narrow={mode === "compact"} /> : null}
      </div>
    </div>
  );
}

function ScreenSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-6" aria-busy>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
