import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useNav, useToasts } from "@/app/state/ui";
import { cn } from "@/utils/cn";

/** Restrained toasts: at most three, top-right (clear of the ask box and Send buttons), announced politely to screen readers. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  // On the chats screen a native webview covers this corner; that screen shows the latest toast inline.
  const covered = useNav((s) => s.route === "webchats");
  if (covered) return null;
  return (
    <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed right-4 top-[calc(var(--zhu-titlebar-h)+10px)] z-toast flex w-[min(360px,calc(100vw-32px))] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            role={t.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-3 rounded-lg border border-border bg-surface-2 px-3.5 py-3 shadow-3"
          >
            <span className={cn("mt-0.5 flex", t.kind === "success" && "text-success", t.kind === "error" && "text-danger", t.kind === "info" && "text-accent")}>
              {t.kind === "success" ? <CheckCircle2 className="h-4 w-4" /> : t.kind === "error" ? <AlertCircle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-body font-medium text-fg">{t.title}</div>
              {t.description ? <div className="mt-0.5 line-clamp-3 break-words text-secondary text-fg-2">{t.description}</div> : null}
            </div>
            <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="rounded-xs p-0.5 text-fg-3 hover:bg-hover hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
