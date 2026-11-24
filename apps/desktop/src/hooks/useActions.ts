/**
 * Shared user actions (listening, screenshots, questions), used by every part of the main window
 * that offers them, so the logic is never duplicated.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { qk } from "@/app/providers/queryKeys";
import { latestQuestion, useQuestions } from "@/app/state/questions";
import { useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { askQuestion } from "@/services/ask";
import { api } from "@/services/engine";
import { copyText, inTauri, shell } from "@/services/shell";
import type { Question } from "@/types/engine";
import { errorMessage } from "@/utils/format";
import { questionCopyText } from "@/utils/questionPresentation";
import { sendQuestionToChats } from "@/services/webchatDelivery";

export function useListeningActions() {
  const qc = useQueryClient();

  const ensureSession = useCallback(async (): Promise<string> => {
    const { currentSessionId, setCurrentSession } = useSession.getState();
    if (currentSessionId) {
      try {
        const s = await api.session(currentSessionId);
        if (s.status === "active") return s.id;
      } catch {
        /* fall through: create a new session */
      }
    }
    const created = await api.createSession();
    setCurrentSession(created.id);
    void qc.invalidateQueries({ queryKey: qk.sessionsAll });
    return created.id;
  }, [qc]);

  /** Without sources: what was chosen last (the hotkey and the tray start that way). */
  const start = useCallback(async (sources?: ("microphone" | "system")[]) => {
    try {
      const sid = await ensureSession();
      const status = await api.startListening(sid, sources);
      useSession.getState().setListening(status);
      toast.success("Listening started", status.device === "cpu" ? "Local transcription is running in CPU mode." : undefined);
    } catch (err) {
      const msg = errorMessage(err);
      toast.error("Could not start listening", msg);
      if (/No speech model/i.test(msg)) useNav.getState().setSetupOpen(true);
    }
  }, [ensureSession]);

  const pause = useCallback(async () => {
    try {
      useSession.getState().setListening(await api.pauseListening());
      toast.info("Listening paused");
    } catch (err) {
      toast.error("Could not pause", errorMessage(err));
    }
  }, []);

  const resume = useCallback(async () => {
    try {
      useSession.getState().setListening(await api.resumeListening());
    } catch (err) {
      toast.error("Could not resume", errorMessage(err));
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      useSession.getState().setListening(await api.stopListening());
    } catch (err) {
      toast.error("Could not stop listening", errorMessage(err));
    }
  }, []);

  const toggle = useCallback(async () => {
    const s = useSession.getState().listening?.state ?? "idle";
    if (s === "listening") await pause();
    else if (s === "paused") await resume();
    else if (s === "idle" || s === "error") await start();
  }, [pause, resume, start]);

  const newSession = useCallback(
    async (name?: string) => {
      try {
        const st = useSession.getState().listening?.state;
        if (st === "listening" || st === "paused") await api.stopListening();
        const s = await api.createSession(name);
        useSession.getState().setCurrentSession(s.id);
        void qc.invalidateQueries({ queryKey: qk.sessionsAll });
        toast.success("Session created", s.name);
        return s;
      } catch (err) {
        toast.error("Could not create session", errorMessage(err));
        return null;
      }
    },
    [qc],
  );

  return { start, pause, resume, stop, toggle, newSession, ensureSession };
}

export function useQuestionActions() {
  const copy = useCallback(async (q: Question) => {
    try {
      await copyText(questionCopyText(q, true));
      toast.success("Question copied");
    } catch (err) {
      toast.error("Copy failed", errorMessage(err));
    }
  }, []);

  const copyLatest = useCallback(async () => {
    const q = latestQuestion(useQuestions.getState());
    if (!q) {
      toast.info("No question detected yet");
      return;
    }
    await copy(q);
  }, [copy]);

  const edit = useCallback(async (q: Question, text: string) => {
    try {
      await api.editQuestion(q.question_id, text);
      toast.success("Question updated");
      return true;
    } catch (err) {
      toast.error("Could not update question", errorMessage(err));
      return false;
    }
  }, []);

  const discard = useCallback(async (q: Question) => {
    try {
      await api.discardQuestion(q.question_id);
      toast.info("Question discarded");
    } catch (err) {
      toast.error("Could not discard question", errorMessage(err));
    }
  }, []);

  /** Ask the connected AI model; the answer streams into the Answers panel on Home. */
  const answer = useCallback((q: Question) => void askQuestion(q), []);

  /** Put the question into the message boxes of the embedded chat tabs (never submits). */
  const sendToChats = useCallback((q: Question) => void sendQuestionToChats(q), []);

  return { copy, copyLatest, edit, discard, answer, sendToChats };
}

/** How long to wait after switching the shield on before capturing. */
const SHIELD_SETTLE_MS = 150;

export function useCaptureActions() {
  /**
   * Capture the screen without ZHU in it, and without any notice: the windows are left out of the
   * picture only while it is taken, and the result simply appears in the screenshots panel.
   */
  const screen = useCallback(async (mode: "monitor" | "all" | "window" = "monitor", monitor?: number) => {
    try {
      if (inTauri) {
        await shell.captureShield(true);
        await new Promise((r) => setTimeout(r, SHIELD_SETTLE_MS)); // Windows applies it on the next frame
      }
      const sid = useSession.getState().currentSessionId;
      return await api.capture(mode, monitor, sid);
    } catch (err) {
      toast.error("Capture failed", errorMessage(err));
      return null;
    } finally {
      if (inTauri) void shell.captureShield(false).catch(() => undefined);
    }
  }, []);

  return { screen };
}


