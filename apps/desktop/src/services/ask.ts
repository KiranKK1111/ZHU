/**
 * Asking the connected AI model: from a question card, from the ask box, or automatically when a
 * question is detected. One code path, so the three always behave the same.
 */
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/app/providers/queryKeys";
import { useComposer } from "@/app/state/composer";
import { currentPrefs } from "@/app/state/prefs";
import { useSession } from "@/app/state/session";
import { toast, useNav } from "@/app/state/ui";
import { pickAnswerModel } from "@/hooks/useProviders";
import { api } from "@/services/engine";
import type { ProviderInfo, Question } from "@/types/engine";
import { errorMessage } from "@/utils/format";
import { questionCopyText } from "@/utils/questionPresentation";

let queryClient: QueryClient | null = null;
/** Called once by the app shell, so asking can read the provider list outside React. */
export function bindQueryClient(qc: QueryClient): void {
  queryClient = qc;
}

async function currentModel(): Promise<ProviderInfo | null> {
  let providers = queryClient?.getQueryData<ProviderInfo[]>(qk.providers);
  if (!providers) {
    try {
      providers = await api.providers();
      queryClient?.setQueryData(qk.providers, providers);
    } catch {
      providers = [];
    }
  }
  return pickAnswerModel(providers, currentPrefs().answerProvider);
}

export interface AskOptions {
  screenshotIds?: string[];
  /** Automatic asks stay quiet when no model is connected. */
  quiet?: boolean;
}

/** Send a prompt to the selected model. Returns false when nothing was sent. */
export async function ask(text: string, opts: AskOptions = {}): Promise<boolean> {
  const prompt = text.trim();
  const model = await currentModel();
  if (!model) {
    if (!opts.quiet) {
      toast.info("Connect an AI model first", "Add a key under Settings. Several providers have a free tier.");
      useNav.getState().navigate("settings");
    }
    return false;
  }
  const shots = model.capabilities.images ? (opts.screenshotIds ?? []) : [];
  if (!prompt && !shots.length) return false;
  if ((opts.screenshotIds?.length ?? 0) > 0 && !model.capabilities.images && !opts.quiet) {
    toast.info(`${model.name} does not accept images`, "The question was sent without the screenshots.");
  }
  try {
    const res = await api.submitPrompt(model.id, {
      session_id: useSession.getState().currentSessionId,
      prompt,
      screenshot_ids: shots,
      system: currentPrefs().instructions.trim() || null,
    });
    useComposer.getState().started({ requestId: res.request_id, interactionId: res.interaction_id, providerId: model.id, model: res.model, prompt, screenshotIds: shots });
    return true;
  } catch (err) {
    if (!opts.quiet) toast.error("Could not ask the model", errorMessage(err));
    return false;
  }
}

export function askQuestion(q: Question): Promise<boolean> {
  asked.add(q.question_id);
  return ask(questionCopyText(q, true));
}

// ------------------------------------------------------------------ automatic answers
const asked = new Set<string>();

/** A question completed while listening: ask the model when "Auto-answer" is on. Each question is asked once. */
export function onQuestionForAutoAnswer(q: Question): void {
  if (!currentPrefs().autoAnswer || q.state === "DISCARDED" || asked.has(q.question_id)) return;
  const state = useSession.getState().listening?.state;
  if (state !== "listening" && state !== "paused") return; // replayed or historical events
  asked.add(q.question_id);
  if (asked.size > 500) asked.delete(asked.values().next().value as string);
  void ask(questionCopyText(q, true), { quiet: true });
}
