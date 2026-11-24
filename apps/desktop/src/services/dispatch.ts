/**
 * Routes engine events to the stores and the React Query cache. Store updates
 * are batched per animation frame by EventStream; each store applies a whole
 * batch at once to minimise re-renders.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useChat, type ChatEnding } from "@/app/state/chat";
import { useQuestions } from "@/app/state/questions";
import { useSession } from "@/app/state/session";
import { useTranscript } from "@/app/state/transcript";
import { toast, useDownloads } from "@/app/state/ui";
import { qk } from "@/app/providers/queryKeys";
import type {
  DownloadProgress,
  EngineSettings,
  Envelope,
  GpuInfo,
  ListeningStatus,
  ProviderErrorInfo,
  Question,
  Screenshot,
  TranscriptRow,
  TranscriptSegmentEvent,
} from "@/types/engine";
import type { WindowKind } from "@/types/shell";
import { api } from "./engine";
import { onQuestionEvent, onScreenshotEvent } from "./webchatDelivery";

export function dispatchEnvelopes(batch: Envelope[], qc: QueryClient, kind: WindowKind): void {
  const segmentsBySession = new Map<string, TranscriptSegmentEvent[]>();
  const questions: Question[] = [];
  let listening: ListeningStatus | null = null;
  const invalidate = new Set<string>();

  for (const env of batch) {
    const t = env.event_type;
    switch (t) {
      case "transcript.partial":
      case "transcript.final": {
        if (!env.session_id) break;
        const list = segmentsBySession.get(env.session_id) ?? [];
        list.push(env.data as TranscriptSegmentEvent);
        segmentsBySession.set(env.session_id, list);
        break;
      }
      case "transcript.corrected":
        useTranscript.getState().applyCorrection(env.data as TranscriptRow);
        break;
      case "transcript.cleared": {
        const sid = (env.data as { session_id: string }).session_id;
        // Lines that arrived earlier in this same batch were said before the clear: they go too.
        segmentsBySession.delete(sid);
        useTranscript.getState().clear(sid);
        qc.setQueryData(qk.transcript(sid), []);
        invalidate.add("sessions");
        break;
      }
      case "question.created":
      case "question.updated":
      case "question.completed":
      case "question.revised":
      case "question.discarded": {
        const q = env.data as Question;
        questions.push(q);
        // Embedded chat tabs: place the completed question in their message boxes (main window only).
        if (kind === "main" && (t === "question.completed" || t === "question.revised")) onQuestionEvent(q, t === "question.revised");
        invalidate.add("sessions");
        break;
      }
      case "question.error":
        if (kind === "main") toast.error("Question detection error", (env.data as { message?: string }).message);
        break;
      case "listening.status":
        listening = env.data as ListeningStatus;
        break;
      case "audio.level": {
        const d = env.data as { source: string; rms_db: number };
        useSession.getState().setLevel(d.source, d.rms_db);
        break;
      }
      case "speech.activity": {
        const d = env.data as { source: string; active: boolean };
        useSession.getState().setSpeech(d.source, d.active);
        break;
      }
      case "gpu.stats":
        useSession.getState().setGpu(env.data as GpuInfo);
        break;
      case "screenshot.created":
        if (kind === "main") {
          onScreenshotEvent(env.data as Screenshot);
        }
        invalidate.add("screenshots");
        invalidate.add("sessions");
        break;
      case "screenshot.deleted": {
        const id = (env.data as { id: string }).id;
        useChat.getState().forgetScreenshot(id);
        invalidate.add("screenshots");
        invalidate.add("sessions");
        break;
      }
      case "session.created":
      case "session.updated":
        invalidate.add("sessions");
        if (env.session_id) qc.setQueryData(qk.session(env.session_id), env.data);
        break;
      case "session.deleted": {
        const id = (env.data as { id: string }).id;
        invalidate.add("sessions");
        if (useSession.getState().currentSessionId === id) {
          useSession.getState().setCurrentSession(null);
          useQuestions.getState().reset(null);
          useTranscript.getState().reset(null);
        }
        qc.removeQueries({ queryKey: qk.session(id) });
        break;
      }
      case "provider.updated":
        invalidate.add("providers");
        break;
      // The built-in chat lives in the main window only.
      case "chat.delta": {
        if (kind !== "main") break;
        const d = env.data as { conversation_id: string; message_id: string; text: string };
        useChat.getState().delta(d.conversation_id, d.message_id, d.text);
        break;
      }
      case "chat.completed":
      case "chat.error": {
        if (kind !== "main") break;
        const d = env.data as { conversation_id: string; message_id: string; status?: "failed" | "cancelled"; model?: string | null; usage?: Record<string, unknown> | null; error?: ProviderErrorInfo };
        const ending: ChatEnding = t === "chat.completed" ? { status: "completed", model: d.model, usage: d.usage } : { status: d.status ?? "failed", error: d.error ?? null };
        const chat = useChat.getState();
        chat.finish(d.conversation_id, d.message_id, ending);
        // A conversation opened while its answer was already streaming missed the start of the text: read the stored answer.
        if (chat.joinedLate[d.conversation_id]) {
          void api
            .chat(d.conversation_id)
            .then((c) => useChat.getState().load(c.id, c.messages, c.streaming_request_id ?? null))
            .catch(() => undefined);
        }
        invalidate.add("chats");
        break;
      }
      case "chat.updated":
        invalidate.add("chats");
        break;
      case "resume.updated":
        invalidate.add("resume");
        break;
      case "chat.deleted":
        useChat.getState().forget((env.data as { id: string }).id);
        invalidate.add("chats");
        break;
      case "model.download": {
        const p = env.data as DownloadProgress;
        useDownloads.getState().update(p);
        if (p.state === "completed" || p.state === "failed" || p.state === "cancelled") invalidate.add("models");
        if (p.state === "completed" && kind === "main") toast.success("Speech model installed", p.model);
        break;
      }
      case "settings.updated":
        qc.setQueryData(qk.settings, env.data as EngineSettings);
        break;
      case "engine.error":
        if (kind === "main") toast.error("Engine error", (env.data as { message?: string }).message);
        break;
      case "data.purged":
        useChat.getState().reset();
        useQuestions.getState().reset(null);
        useTranscript.getState().reset(null);
        useSession.getState().setCurrentSession(null);
        void qc.invalidateQueries();
        break;
      default:
        break;
    }
  }

  for (const [sid, segs] of segmentsBySession) useTranscript.getState().apply(sid, segs);
  if (questions.length) useQuestions.getState().upsertMany(questions);
  if (listening) {
    useSession.getState().setListening(listening);
    qc.setQueryData(qk.listening, listening);
  }
  for (const key of invalidate) void qc.invalidateQueries({ queryKey: [key] });
}
