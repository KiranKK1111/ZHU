/**
 * One model for Home and for Custom chat. The chat remembers its model in the preferences
 * (provider + model); Home answers with a provider's own selected model, which the engine keeps.
 * Choosing a model in either place sets both, and Home is brought to the chat's model when the
 * two differ (a choice made before they were one, or in another window).
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { useProviders } from "@/hooks/useProviders";
import { api } from "@/services/engine";
import type { ProviderInfo } from "@/types/engine";
import { errorMessage } from "@/utils/format";
import type { ChatModelChoice } from "./models";

/** Make this the model of its provider (what Home answers with) and the choice of both places. */
async function applyModelChoice(qc: QueryClient, providers: ProviderInfo[], choice: ChatModelChoice): Promise<void> {
  if (providers.find((p) => p.id === choice.providerId)?.model !== choice.model) {
    await api.updateProvider(choice.providerId, { model: choice.model });
    await qc.invalidateQueries({ queryKey: qk.providers });
  }
  usePrefs.getState().set({ chatProvider: choice.providerId, chatModel: choice.model, answerProvider: choice.providerId });
}

/** What the model lists on Home and in the chat call when a model is picked. */
export function useSelectModel(): (choice: ChatModelChoice) => void {
  const qc = useQueryClient();
  const { data } = useProviders();
  return useCallback(
    (choice: ChatModelChoice) => {
      // The chat follows at once; Home follows as soon as the provider has taken the model.
      usePrefs.getState().set({ chatProvider: choice.providerId, chatModel: choice.model });
      void applyModelChoice(qc, data ?? [], choice).catch((err) => toast.error("The model was not changed", errorMessage(err)));
    },
    [qc, data],
  );
}

/** Keeps Home on the model chosen in the chat. Mounted once, in the main window. */
export function useModelSync(): void {
  const qc = useQueryClient();
  const { data } = useProviders();
  const providerId = usePrefs((p) => p.chatProvider);
  const model = usePrefs((p) => p.chatModel);
  const answerProvider = usePrefs((p) => p.answerProvider);
  /** The choice last applied from here, so one that the engine does not take is not sent again and again. */
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (!data || !providerId || !model) return;
    const provider = data.find((p) => p.id === providerId);
    // Only a model that is still offered; a stale choice leaves Home as it is.
    if (!provider || provider.status === "disabled" || !provider.config.known_models.includes(model)) return;
    if (answerProvider === providerId && provider.model === model) return;
    const key = `${providerId}\n${model}`;
    if (applied.current === key) return;
    applied.current = key;
    void applyModelChoice(qc, data, { providerId, model }).catch(() => undefined);
  }, [qc, data, providerId, model, answerProvider]);
}
