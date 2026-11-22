import { ArrowDown, Check, Pencil, X } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranscriptItem } from "@/app/state/transcript";
import { Button, IconButton } from "@/components/primitives/Button";
import { Textarea } from "@/components/primitives/Input";
import { cn } from "@/utils/cn";
import { formatClock } from "@/utils/format";
import { isNearBottom, onNewContent } from "@/utils/scroll";
import { highlightMatches, markUncertainWords } from "@/utils/text";

const UNCERTAIN_P = 0.45;

export interface TranscriptViewProps {
  items: TranscriptItem[];
  query?: string;
  compact?: boolean;
  onCorrect?: (item: TranscriptItem, text: string) => Promise<boolean>;
  className?: string;
  emptyState?: React.ReactNode;
}

/**
 * Live transcript. Auto-scrolls only while the user is near the bottom. When the
 * user scrolls up, their position is kept and "Jump to live" appears (UI prompt §10).
 */
export function TranscriptView({ items, query = "", compact, onCorrect, className, emptyState }: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const lastKey = items.length ? `${items[items.length - 1].segment_id}:${items[items.length - 1].revision}:${items.length}` : "";

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    nearBottomRef.current = near;
    if (near) setShowJump(false);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !lastKey) return;
    if (onNewContent(nearBottomRef.current) === "follow") {
      el.scrollTop = el.scrollHeight;
    } else {
      setShowJump(true);
    }
  }, [lastKey]);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    nearBottomRef.current = true;
    setShowJump(false);
  };

  return (
    <div className={cn("relative min-h-0", className)}>
      <div ref={scrollRef} onScroll={onScroll} className="selectable h-full overflow-y-auto overscroll-contain" aria-label="Live transcript" role="log" aria-live="off">
        {items.length === 0 ? (
          emptyState ?? null
        ) : (
          <ol className={cn("flex flex-col", compact ? "gap-1.5 px-3 py-2" : "gap-3 px-1 py-2")}>
            {items.map((it) => (
              <TranscriptLine key={it.segment_id} item={it} query={query} compact={compact} onCorrect={onCorrect} />
            ))}
          </ol>
        )}
      </div>
      {showJump ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button size="sm" variant="primary" className="pointer-events-auto shadow-2" icon={<ArrowDown className="h-3.5 w-3.5" />} onClick={jump}>
            Jump to live
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const TranscriptLine = memo(function TranscriptLine({
  item,
  query,
  compact,
  onCorrect,
}: {
  item: TranscriptItem;
  query: string;
  compact?: boolean;
  onCorrect?: (item: TranscriptItem, text: string) => Promise<boolean>;
}) {
  const showLabels = true;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const text = item.corrected_text ?? item.text;
  const uncertain = useMemo(
    () => (item.corrected_text ? [] : item.words.filter((w) => w.probability != null && w.probability < UNCERTAIN_P).map((w) => ({ text: w.text, reason: `Low recognition confidence (${Math.round((w.probability ?? 0) * 100)}%)` }))),
    [item.words, item.corrected_text],
  );

  useEffect(() => {
    if (editing) setDraft(text);
  }, [editing, text]);

  return (
    <li className={cn("group flex gap-3", compact && "gap-2")}>
      {!compact ? (
        <span className="w-12 shrink-0 pt-0.5 text-right font-mono text-caption tabular-nums text-fg-3">{formatClock(item.start_ms)}</span>
      ) : null}
      <div className="min-w-0 flex-1">
        {!compact && showLabels ? (
          <div className="mb-0.5 flex items-center gap-2 text-caption text-fg-3">
            <span>{item.source_label}</span>
            {!item.is_final ? <span className="italic">provisional</span> : null}
            {item.corrected_text ? <span>corrected</span> : null}
          </div>
        ) : null}
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
              aria-label="Correct transcript segment"
              onKeyDown={async (e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && onCorrect) {
                  if (await onCorrect(item, draft)) setEditing(false);
                }
              }}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} disabled={!draft.trim() || draft === text} onClick={async () => onCorrect && (await onCorrect(item, draft)) && setEditing(false)}>
                Save correction
              </Button>
              <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
            <p className="text-caption text-fg-3">The original recognition is kept; the correction is stored separately.</p>
          </div>
        ) : (
          <p className={cn("break-words", compact ? "text-secondary leading-relaxed" : "text-body leading-relaxed", item.is_final ? "text-fg" : "zhu-provisional italic")}>
            <SegmentText text={text} uncertain={uncertain} query={query} />
          </p>
        )}
      </div>
      {!compact && onCorrect && item.is_final && !editing ? (
        <IconButton label="Correct this segment" size="sm" className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />
        </IconButton>
      ) : null}
    </li>
  );
});

function SegmentText({ text, uncertain, query }: { text: string; uncertain: { text: string; reason: string }[]; query: string }) {
  const parts = markUncertainWords(text, uncertain);
  return (
    <>
      {parts.map((p, i) =>
        p.uncertain ? (
          <span key={i} className="zhu-uncertain" title={p.reason}>
            <Highlighted text={p.text} query={query} />
          </span>
        ) : (
          <Highlighted key={i} text={p.text} query={query} />
        ),
      )}
    </>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  return (
    <>
      {highlightMatches(text, query).map((m, i) =>
        m.match ? (
          <mark key={i} className="rounded-xs bg-accent-soft px-0.5 text-fg">
            {m.text}
          </mark>
        ) : (
          <span key={i}>{m.text}</span>
        ),
      )}
    </>
  );
}
