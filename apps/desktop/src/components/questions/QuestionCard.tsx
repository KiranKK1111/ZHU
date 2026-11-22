import { Copy, ExternalLink, MessagesSquare, MoreHorizontal, Pencil, Sparkles, Trash2 } from "lucide-react";
import { memo, useState } from "react";
import { usePrefs } from "@/app/state/prefs";
import { Button, IconButton } from "@/components/primitives/Button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/primitives/Menu";
import { useQuestionActions } from "@/hooks/useActions";
import type { Question } from "@/types/engine";
import { cn } from "@/utils/cn";
import { formatClock } from "@/utils/format";
import { categoryLabel, isOpen } from "@/utils/questionPresentation";
import { QuestionEditor } from "./QuestionEditor";
import { MathBlock, QuestionText } from "./QuestionText";

export interface QuestionCardProps {
  question: Question;
  /** Sidecar variant: smaller, with a link back to the main window instead of the Answer button. */
  variant?: "full" | "compact";
  onOpenInWorkspace?: () => void;
}

/**
 * One detected question: the text, and the three things you do with it (get an answer, copy it,
 * send it to the chat tabs). Shared by the Home screen and the sidecar.
 */
export const QuestionCard = memo(function QuestionCard({ question: q, variant = "full", onOpenInWorkspace }: QuestionCardProps) {
  const actions = useQuestionActions();
  const hasChatTabs = usePrefs((p) => p.webChatTabs.length > 0);
  const [editing, setEditing] = useState(false);
  const compact = variant === "compact";
  const open = isOpen(q);
  const discarded = q.state === "DISCARDED";

  return (
    <article
      aria-label={`Question: ${q.display_text}`}
      className={cn(
        "group rounded-xl border bg-surface transition-colors duration-fast",
        compact ? "p-3" : "p-4",
        open ? "border-dashed border-border" : "border-border-subtle hover:border-border",
        discarded && "opacity-60",
      )}
    >
      <header className="mb-1.5 flex items-center gap-2 text-caption text-fg-3">
        {open ? (
          <span className="inline-flex items-center gap-1.5 text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
            Still listening…
          </span>
        ) : (
          <span>{categoryLabel(q.category)}</span>
        )}
        {q.needs_review && !open ? <span className="text-warning" title={q.review_reasons.join(" · ")}>Check wording</span> : null}
        {discarded ? <span>Discarded</span> : null}
        <span className="ml-auto tabular-nums" title="Time in session">
          {formatClock(q.started_at_ms)}
        </span>
      </header>

      {editing ? (
        <QuestionEditor
          question={q}
          onCancel={() => setEditing(false)}
          onSave={async (t) => {
            if (await actions.edit(q, t)) setEditing(false);
          }}
        />
      ) : (
        <>
          <QuestionText text={q.display_text} className={cn(compact ? "text-body" : "text-card font-medium leading-snug", open ? "text-fg-2" : "text-fg")} clamp={compact ? 6 : undefined} />
          {q.subquestions.length > 0 ? (
            <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-secondary text-fg-2 marker:text-fg-3">
              {q.subquestions.map((s, i) => (
                <li key={i} className="selectable">
                  <QuestionText text={s} className="inline" />
                </li>
              ))}
            </ol>
          ) : null}
          {q.math_latex && !compact ? (
            <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-body">
              <MathBlock latex={q.math_latex} />
            </div>
          ) : null}
        </>
      )}

      {!editing ? (
        <footer className="mt-3 flex items-center gap-1">
          {onOpenInWorkspace ? (
            <Button size="sm" variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={onOpenInWorkspace}>
              Open in ZHU
            </Button>
          ) : (
            <Button size="sm" variant="subtle" icon={<Sparkles className="h-3.5 w-3.5" />} disabled={discarded} onClick={() => actions.answer(q)}>
              Answer
            </Button>
          )}
          <IconButton label="Copy question" size="sm" onClick={() => void actions.copy(q)}>
            <Copy className="h-3.5 w-3.5" />
          </IconButton>
          {hasChatTabs && !compact ? (
            <IconButton label="Send to chat tabs" size="sm" disabled={discarded} onClick={() => actions.sendToChats(q)}>
              <MessagesSquare className="h-3.5 w-3.5" />
            </IconButton>
          ) : null}
          {!compact ? (
            <div className="ml-auto opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label="More" size="sm" noTooltip>
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onSelect={() => setEditing(true)} disabled={discarded}>
                    Edit wording
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onSelect={() => void actions.discard(q)} disabled={discarded}>
                    Not a question
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
});
