import { AudioLines, CircleHelp, Eraser } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { sortedQuestions, useQuestions } from "@/app/state/questions";
import { useSession } from "@/app/state/session";
import { useTranscript } from "@/app/state/transcript";
import { toast } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { EmptyState } from "@/components/primitives/Display";
import { SplitHandle, type SplitLimits } from "@/components/primitives/SplitHandle";
import { QuestionCard } from "@/components/questions/QuestionCard";
import { TranscriptView } from "@/components/transcription/TranscriptView";
import { api } from "@/services/engine";
import { errorMessage } from "@/utils/format";
import { AnswerPanel } from "./AnswerPanel";

/** Questions next to answers: neither narrower than this, whatever the window. */
const COLUMN_LIMITS: SplitLimits = { min: 0.25, max: 0.75, minPx: 300 };
/** The transcript under the questions. */
const TRANSCRIPT_LIMITS: SplitLimits = { min: 0.12, max: 0.8, minPx: 110 };

/**
 * A pane size the user drags: saved in the preferences when the drag ends, followed live while it
 * goes on (without writing the preferences on every move).
 */
function useSplit(key: "homeSplit" | "transcriptSplit") {
  const saved = usePrefs((p) => p[key]);
  const set = usePrefs((p) => p.set);
  const [live, setLive] = useState<number | null>(null);
  return {
    value: live ?? saved,
    onChange: setLive,
    onCommit: (share: number) => {
      set({ [key]: share });
      setLive(null);
    },
    onReset: () => {
      set({ [key]: DEFAULT_PREFS[key] });
      setLive(null);
    },
  };
}

/**
 * Home: everything you need during a conversation on one screen. Left: the questions ZHU heard.
 * Right: the AI's answers. The bar between them, and the one above the transcript, can be dragged.
 * Listening itself is started and stopped in the title bar, which every screen has.
 */
export default function HomeScreen() {
  const columns = useRef<HTMLDivElement>(null);
  const split = useSplit("homeSplit");
  // Side by side only when there is room (a container query); narrower, the two are stacked.
  const shares = { "--zhu-questions": `${split.value}fr`, "--zhu-answers": `${1 - split.value}fr` } as CSSProperties;
  return (
    <div className="flex h-full flex-col">
      <div ref={columns} style={shares} className="grid min-h-0 flex-1 grid-cols-1 @3xl:grid-cols-[minmax(0,var(--zhu-questions))_auto_minmax(0,var(--zhu-answers))]">
        <QuestionsPane />
        <SplitHandle
          direction="columns"
          label="Width of the questions and the answers"
          containerRef={columns}
          limits={COLUMN_LIMITS}
          className="hidden @3xl:block"
          {...split}
        />
        <AnswerPanel />
      </div>
    </div>
  );
}

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
  const transcriptSplit = useSplit("transcriptSplit");

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
    <section ref={pane} aria-label="Questions" className="flex min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-5">
        <h2 className="text-card text-fg">Questions</h2>
        {questions.length ? <span className="text-caption tabular-nums text-fg-3">{questions.length}</span> : null}
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Eraser className="h-3.5 w-3.5" />} disabled={!questions.length || !sessionId} onClick={() => setClearingQuestions(true)} title="Remove every question from this list">
          Clear
        </Button>
        <Button size="sm" variant="ghost" aria-pressed={showTranscript} icon={<AudioLines className="h-3.5 w-3.5" />} onClick={() => setPrefs({ showTranscript: !showTranscript })}>
          {showTranscript ? "Hide transcript" : "Show transcript"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
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
      {showTranscript ? (
        <SplitHandle direction="rows" label="Height of the transcript" containerRef={pane} limits={TRANSCRIPT_LIMITS} {...transcriptSplit} />
      ) : null}
      {showTranscript ? (
        <div style={{ height: `${transcriptSplit.value * 100}%` }} className="flex min-h-[110px] shrink-0 flex-col">
          <div className="flex h-9 shrink-0 items-center justify-between pl-5 pr-3">
            <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">Transcript</h3>
            <Button size="sm" variant="ghost" icon={<Eraser className="h-3.5 w-3.5" />} disabled={!transcript.length || !sessionId} onClick={() => setClearing(true)} title="Delete everything transcribed in this session so far">
              Clear
            </Button>
          </div>
          <TranscriptView
            items={transcript}
            compact
            className="min-h-0 flex-1 px-2"
            emptyState={<p className="px-3 py-2 text-secondary text-fg-3">{live ? "Listening…" : "Everything that is said appears here while you are listening."}</p>}
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
