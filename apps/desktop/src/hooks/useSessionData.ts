/**
 * Keeps the question and transcript stores in sync with the current session.
 * REST provides the initial snapshot; WebSocket events keep it live.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { qk } from "@/app/providers/queryKeys";
import { useQuestions } from "@/app/state/questions";
import { CURRENT_SESSION_KEY, useSession } from "@/app/state/session";
import { onShellEvent } from "@/services/shell";
import { useTranscript } from "@/app/state/transcript";
import { api, EngineHttpError } from "@/services/engine";
import type { EngineSettings } from "@/types/engine";

export function useSettingsQuery() {
  return useQuery({ queryKey: qk.settings, queryFn: api.settings, staleTime: 60_000 });
}

export function useSourceLabels(): Record<string, string> {
  const { data } = useSettingsQuery();
  return (data as EngineSettings | undefined)?.audio.source_labels ?? { microphone: "Microphone", system: "System audio" };
}

export function useSessionData(): void {
  const currentId = useSession((s) => s.currentSessionId);
  const listeningSession = useSession((s) => s.listening?.session_id ?? null);
  const setCurrent = useSession((s) => s.setCurrentSession);
  const labels = useSourceLabels();

  // Follow session switches made in another window (Tauri event, plus storage events as a fallback).
  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onShellEvent<{ id: string | null }>("zhu://session", ({ id }) => useSession.getState().applyRemoteSession(id)).then((u) => (cancelled ? u() : (off = u)));
    const onStorage = (e: StorageEvent) => {
      if (e.key === CURRENT_SESSION_KEY) useSession.getState().applyRemoteSession(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      off?.();
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // The live session takes precedence: when the engine is recording, show that session.
  useEffect(() => {
    if (listeningSession && listeningSession !== currentId) setCurrent(listeningSession);
  }, [listeningSession, currentId, setCurrent]);

  const sessionQuery = useQuery({
    queryKey: qk.session(currentId ?? "none"),
    queryFn: () => api.session(currentId!),
    enabled: !!currentId,
    retry: (count, err) => !(err instanceof EngineHttpError && err.status === 404) && count < 2,
  });

  // Session deleted elsewhere (or stale id from a previous install): clear it.
  useEffect(() => {
    if (sessionQuery.error instanceof EngineHttpError && sessionQuery.error.status === 404) setCurrent(null);
  }, [sessionQuery.error, setCurrent]);

  const questions = useQuery({ queryKey: qk.questions(currentId ?? "none"), queryFn: () => api.questions(currentId!), enabled: !!currentId });
  const transcript = useQuery({ queryKey: qk.transcript(currentId ?? "none"), queryFn: () => api.transcript(currentId!), enabled: !!currentId });

  useEffect(() => {
    if (!currentId) {
      useQuestions.getState().reset(null);
      useTranscript.getState().reset(null);
      return;
    }
    if (useQuestions.getState().sessionId !== currentId) useQuestions.getState().reset(currentId);
    if (useTranscript.getState().sessionId !== currentId) useTranscript.getState().reset(currentId);
  }, [currentId]);

  useEffect(() => {
    if (currentId && questions.data) useQuestions.getState().load(currentId, questions.data);
  }, [currentId, questions.data]);

  useEffect(() => {
    if (currentId && transcript.data) useTranscript.getState().load(currentId, transcript.data, labels);
  }, [currentId, transcript.data, labels]);
}

export function useCurrentSession() {
  const currentId = useSession((s) => s.currentSessionId);
  return useQuery({ queryKey: qk.session(currentId ?? "none"), queryFn: () => api.session(currentId!), enabled: !!currentId });
}
