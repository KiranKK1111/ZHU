import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { fetchBlob, getConnection } from "@/services/engine";

/** Debounced value (search inputs). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Re-render every `ms` while active (elapsed timers). */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

/**
 * Authenticated image -> object URL. The URL is revoked when the component unmounts
 * or the path changes, so thumbnails do not leak memory.
 */
export function useBlobUrl(path: string | null): { url: string | null; error: boolean; loading: boolean } {
  const [state, setState] = useState<{ url: string | null; error: boolean; loading: boolean }>({ url: null, error: false, loading: !!path });
  useEffect(() => {
    if (!path || !getConnection()) {
      setState({ url: null, error: false, loading: false });
      return;
    }
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    setState({ url: null, error: false, loading: true });
    fetchBlob(path, ctrl.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, error: false, loading: false });
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setState({ url: null, error: true, loading: false });
      });
    return () => {
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return state;
}

export type LayoutMode = "wide" | "standard" | "compact";

/** Layout mode from the element's own width (window size, not display resolution). */
export function useLayoutMode(ref: RefObject<HTMLElement>): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("standard");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = (w: number) => setMode(w >= 1400 ? "wide" : w >= 1100 ? "standard" : "compact");
    compute(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => compute(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return mode;
}

/** Track whether a reduced-motion preference is active (OS or app). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const fn = () => setReduced(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return reduced;
}

/** Latest value in a ref (stable callbacks that read fresh state). */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
