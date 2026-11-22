import { useQuery } from "@tanstack/react-query";
import { AudioLines, CircleHelp, CircleStop, Eraser, Mic, Pause, Play, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { sortedQuestions, useQuestions } from "@/app/state/questions";
import { useSession } from "@/app/state/session";
import { useTranscript } from "@/app/state/transcript";
import { toast, useNav } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { EmptyState } from "@/components/primitives/Display";
import { QuestionCard } from "@/components/questions/QuestionCard";
import { TranscriptView } from "@/components/transcription/TranscriptView";
import { useListeningActions } from "@/hooks/useActions";
import { api } from "@/services/engine";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";
import { AnswerPanel } from "./AnswerPanel";

/**
 * Home: everything you need during a conversation on one screen.
 * Top: one button to listen. Left: the questions ZHU heard. Right: the AI's answers.
 */
export default function HomeScreen() {
  return (
    <div className="flex h-full flex-col">
      <ListeningBar />
      <div className="grid min-h-0 flex-1 grid-cols-1 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <QuestionsPane />
        <AnswerPanel />
      </div>
    </div>
  );
}

function ListeningBar() {
  const listening = useSession((s) => s.listening);
  const sessionId = useSession((s) => s.currentSessionId);
  const actions = useListeningActions();
  const models = useQuery({ queryKey: qk.models, queryFn: api.models, staleTime: 60_000 });
  const setSetupOpen = useNav((s) => s.setSetupOpen);
  const state = listening?.state ?? "idle";
  const live = state === "listening" || state === "paused";
  const noModel = !!models.data?.setup_required;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border-subtle px-5 py-3">
      {noModel ? (
        <Button size="lg" variant="primary" icon={<Mic className="h-4 w-4" />} onClick={() => setSetupOpen(true)}>
          Set up speech recognition
        </Button>
      ) : state === "listening" ? (
        <Button size="lg" variant="secondary" icon={<Pause className="h-4 w-4" />} onClick={() => void actions.pause()}>
          Pause
        </Button>
      ) : state === "paused" ? (
        <Button size="lg" variant="primary" icon={<Play className="h-4 w-4" />} onClick={() => void actions.resume()}>
          Resume
        </Button>
      ) : (
        <Button size="lg" variant="primary" icon={<Play className="h-4 w-4" />} loading={state === "loading_model"} onClick={() => void actions.start()}>
          {state === "loading_model" ? "Getting ready…" : "Start listening"}
        </Button>
      )}
      {live ? (
        <Button size="lg" variant="ghost" icon={<CircleStop className="h-4 w-4" />} onClick={() => void actions.stop()}>
          Stop
        </Button>
      ) : null}
      <p className={cn("min-w-0 flex-1 truncate text-secondary", state === "error" ? "text-danger" : "text-fg-3")} role={state === "error" ? "alert" : undefined}>
        {state === "error"
          ? listening?.message
          : noModel
            ? "Download a speech model once. It runs on this computer."
            : live
              ? "Questions appear on the left as they are asked."
              : "ZHU listens to your call and microphone, and picks out the questions."}
      </p>
      {!live && sessionId ? (
        <Button variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => void actions.newSession()} title="Start a fresh, empty session">
          New session
        </Button>
      ) : null}
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
    <section aria-label="Questions" className="flex min-h-0 flex-col border-border-subtle @3xl:border-r">
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
            description={live ? "When someone asks a question, it appears here, written out clearly." : "Press Start listening. Every question that is asked will be collected here."}
          />
        )}
      </div>
      {showTranscript ? (
        <div className="flex h-[34%] min-h-[120px] shrink-0 flex-col border-t border-border-subtle">
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
