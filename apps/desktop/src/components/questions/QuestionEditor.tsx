import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Textarea } from "@/components/primitives/Input";
import type { Question } from "@/types/engine";

/** Inline manual correction. Ctrl+Enter saves and Escape cancels; the raw transcript stays untouched. */
export function QuestionEditor({ question, onSave, onCancel }: { question: Question; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(question.display_text);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(text.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Edit question text"
        className="min-h-[96px] text-body"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!text.trim() || text.trim() === question.display_text} icon={<Check className="h-3.5 w-3.5" />} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto text-caption text-fg-3">Ctrl+Enter to save · Original transcript is preserved</span>
      </div>
    </div>
  );
}
