import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBlobUrl } from "@/hooks/useMisc";
import { imagePaths } from "@/services/engine";
import { cn } from "@/utils/cn";

/**
 * Authenticated thumbnail. It fetches only once it scrolls into view, and the
 * object URL is revoked on unmount. `fill` crops to the frame from the top-left corner (where a
 * screenshot's content usually starts) instead of fitting the whole image inside it.
 */
export function Thumb({ id, alt, className, full = false, fill = false }: { id: string; alt: string; className?: string; full?: boolean; fill?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { url, error, loading } = useBlobUrl(visible ? (full ? imagePaths.image(id) : imagePaths.thumbnail(id)) : null);
  return (
    <div ref={ref} className={cn("relative flex items-center justify-center overflow-hidden bg-surface-2", className)}>
      {url ? <img src={url} alt={alt} className={cn("h-full w-full", fill ? "object-cover object-left-top" : "object-contain")} draggable={false} /> : null}
      {loading || (!url && !error) ? <div className="zhu-skeleton absolute inset-0 rounded-none" /> : null}
      {error ? (
        <span className="flex flex-col items-center gap-1 text-caption text-fg-3">
          <ImageOff className="h-4 w-4" aria-hidden />
          Unavailable
        </span>
      ) : null}
    </div>
  );
}
