import { AudioLines, CircleHelp, Eraser, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { usePrefs } from "@/app/state/prefs";
import { sortedQuestions, useQuestions } from "@/app/state/questions";
import { useSession } from "@/app/state/session";
import { useTranscript } from "@/app/state/transcript";
import { toast } from "@/app/state/ui";
import { Button, IconButton } from "@/components/primitives/Button";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { EmptyState } from "@/components/primitives/Display";
import { SplitHandle, type SplitLimits } from "@/components/primitives/SplitHandle";
import { Tip } from "@/components/primitives/Tooltip";
import { QuestionCard } from "@/components/questions/QuestionCard";
import { TranscriptView } from "@/components/transcription/TranscriptView";
import { useSplitPref } from "@/hooks/useSplitPref";
import { api } from "@/services/engine";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";
import { isOpen } from "@/utils/questionPresentation";

/**
 * The questions column, beside the chat tabs: its width, whether it is collapsed and whether the
 * transcript is under it are preferences, kept across restarts.
 */

/** The column's width: a share of the screen, never narrower than `minPx`, and the other side never narrower either. */
export const QUESTIONS_LIMITS: SplitLimits = { min: 0.2, max: 0.6, minPx: 300 };
/** The transcript under the questions. */
const TRANSCRIPT_LIMITS: SplitLimits = { min: 0.12, max: 0.8, minPx: 110 };

/**
 * The grid's columns: the questions, the line, and the chats. The questions get their share of
 * the width, kept between the minimum and what leaves the chats the minimum (half each in a window
 * too narrow for both), and the chats always take all the rest. Both minimums hold in the layout
 * itself, whatever width was saved and however narrow the window is, not only while dragging.
 * (Two shares of fr would leave part of the width empty: once one side sits at its minimum, the
 * other's share is less than 1fr, and a grid gives such a track only that part of the space.)
 */
export function columnsFor(share: number): string {
  const least = `min(${QUESTIONS_LIMITS.minPx}px, 50%)`;
  return `clamp(${least}, ${+(share * 100).toFixed(2)}%, calc(100% - ${least})) auto minmax(0, 1fr)`;
}

/**
 * The questions on the left and `children` (one element: the chats) on the right, with a line
 * between them to drag. Collapsed, `children` has the whole width and shows `ShowQuestionsButton`
 * before the tabs. `children` stays the same element whether the column is open or not (a
 * website's native page is placed over an element inside it, which must not be replaced).
 */
export function QuestionsColumn({ children }: { children: ReactNode }) {
  const collapsed = usePrefs((p) => p.questionsCollapsed);
  const row = useRef<HTMLDivElement>(null);
  const split = useSplitPref("questionsSplit");
  // A width saved under older limits (up to 75 % once) is kept within them.
  const share = Math.min(QUESTIONS_LIMITS.max, Math.max(QUESTIONS_LIMITS.min, split.value));
  return (
    <div
      ref={row}
      style={collapsed ? undefined : { gridTemplateColumns: columnsFor(share) }}
      className={cn("grid h-full min-h-0 grid-rows-[minmax(0,1fr)]", collapsed && "grid-cols-1")}
    >
      {collapsed ? null : <QuestionsPane key="questions" />}
      {collapsed ? null : (
        <SplitHandle key="split" direction="columns" label="Width of the questions" containerRef={row} limits={QUESTIONS_LIMITS} {...split} value={share} />
      )}
      <div key="beside" className="grid min-h-0 min-w-0 grid-cols-1 grid-rows-[minmax(0,1fr)]">
        {children}
      </div>
    </div>
  );
}

/**
 * The questions folded away: a quiet button before the chat tabs that keeps the count, shows when
 * a question is being asked, and brings the column back.
 */
export function ShowQuestionsButton({ className }: { className?: string }) {
  const byId = useQuestions((s) => s.byId);
  const questions = useMemo(() => sortedQuestions({ byId }), [byId]);
  const asking = questions.some(isOpen);
  const setPrefs = usePrefs((p) => p.set);
  const count = questions.length === 1 ? "1 question" : `${questions.length} questions`;
  return (
    <>
      <Tip label="Show the questions">
        <Button
          size="sm"
          variant="ghost"
          className={cn("shrink-0", className)}
          aria-expanded={false}
          aria-label={`Show the questions (${count}${asking ? ", one being asked" : ""})`}
          icon={<PanelLeftOpen aria-hidden className="h-3.5 w-3.5" />}
          onClick={() => setPrefs({ questionsCollapsed: false })}
        >
          Questions
          {questions.length ? <span className="rounded-full bg-surface-3 px-1.5 text-caption leading-[18px] tabular-nums text-fg-2">{questions.length}</span> : null}
          {asking ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> : null}
        </Button>
      </Tip>
      <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
    </>
  );
}

/** The questions ZHU heard, newest first, with the transcript under them when it is switched on. */
function QuestionsPane() {
  const byId = useQuestions((s) => s.byId);
  // Newest first: the question being asked right now is always at the top, without scrolling.
  const questions = useMemo(() => sortedQuestions({ byId }).reverse(), [byId]);
  const showTranscript = usePrefs((p) => p.showTranscript);
  const setPrefs = usePrefs((p) => p.set);
  const order = useTranscript((s) => s.order);
  const segments = useTranscript((s) => s.byId);
  const transcript = useMemo(() => order.map((id) => segments[id]).filter(Boolean), [order, segments]);
  const live = useSession((s) => s.listening?.state === "listening");
  const sessionId = useSession((s) => s.currentSessionId);
  const [clearing, setClearing] = useState(false);
  const [clearingQuestions, setClearingQuestions] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const transcriptSplit = useSplitPref("transcriptSplit");

  /** Take every question off the list. The engine sends one update per question, which empties the list in every window. */
  const clearQuestions = async () => {
    if (!sessionId) return;
    try {
      const { removed } = await api.clearQuestions(sessionId);
      toast.success(removed === 1 ? "1 question cleared" : `${removed} questions cleared`);
    } catch (err) {
      toast.error("Could not clear the questions", errorMessage(err));
    }
  };

  /** Delete everything transcribed in this session so far. Questions and answers stay; listening goes on. */
  const clearTranscript = async () => {
    if (!sessionId) return;
    try {
      await api.clearTranscript(sessionId);
      useTranscript.getState().clear(sessionId); // the engine's event does the same for the other windows
      toast.success("Transcript cleared");
    } catch (err) {
      toast.error("Could not clear the transcript", errorMessage(err));
    }
  };

  return (
    <section ref={pane} aria-label="Questions" className="flex min-h-0 min-w-0 flex-col">
      {/* It lines up with the Answers header and the chat tab strip beside it. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle pl-4 pr-2">
        <h2 className="text-card text-fg">Questions</h2>
        {questions.length ? <span className="text-caption tabular-nums text-fg-3">{questions.length}</span> : null}
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser className="h-3.5 w-3.5" />} disabled={!questions.length || !sessionId} onClick={() => setClearingQuestions(true)} title="Remove every question from this list">
          Clear
        </Button>
        <IconButton label={showTranscript ? "Hide transcript" : "Show transcript"} size="sm" active={showTranscript} onClick={() => setPrefs({ showTranscript: !showTranscript })}>
          <AudioLines className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton label="Collapse the questions" size="sm" aria-expanded onClick={() => setPrefs({ questionsCollapsed: true })}>
          <PanelLeftClose className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {questions.length ? (
          <div className="flex flex-col gap-2.5">
            {questions.map((q) => (
              <QuestionCard key={q.question_id} question={q} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<CircleHelp className="h-5 w-5" />}
            title={live ? "Listening for questions…" : "No questions yet"}
            description={live ? "When someone asks a question, it appears here, written out clearly." : "Press Start listening at the top. Every question that is asked will be collected here."}
          />
        )}
      </div>
      {showTranscript ? <SplitHandle direction="rows" label="Height of the transcript" containerRef={pane} limits={TRANSCRIPT_LIMITS} {...transcriptSplit} /> : null}
      {showTranscript ? (
        <div style={{ height: `${transcriptSplit.value * 100}%` }} className="flex min-h-[110px] shrink-0 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-between pl-4 pr-3">
            <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">Transcript</h3>
            <Button size="sm" variant="ghost" icon={<Eraser className="h-3.5 w-3.5" />} disabled={!transcript.length || !sessionId} onClick={() => setClearing(true)} title="Delete everything transcribed in this session so far">
              Clear
            </Button>
          </div>
          <TranscriptView
            items={transcript}
            compact
            className="min-h-0 flex-1 px-1"
            emptyState={
              <div className="flex h-full items-center justify-center px-4 py-2 text-center">
                <p className="max-w-[260px] text-secondary text-fg-3">{live ? "Listening…" : "Everything that is said appears here while you are listening."}</p>
              </div>
            }
          />
        </div>
      ) : null}
      <ConfirmDialog
        open={clearingQuestions}
        onOpenChange={setClearingQuestions}
        title={questions.length === 1 ? "Clear this question?" : `Clear all ${questions.length} questions?`}
        description={`They are removed from this list. The transcript and your answers stay${live ? ", and questions asked from now on appear as usual" : ""}.`}
        confirmLabel="Clear questions"
        destructive
        onConfirm={clearQuestions}
      />
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Clear the transcript?"
        description={`The transcript of this session is deleted for good. Your questions and answers stay${live ? ", and listening goes on" : ""}.`}
        confirmLabel="Clear transcript"
        destructive
        onConfirm={clearTranscript}
      />
    </section>
  );
}
