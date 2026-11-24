/**
 * The model Custom chat answers with. The chat remembers it in the preferences (provider + model);
 * picking one also makes it that provider's selected model in the engine, and the one a new
 * Custom chat starts with.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { useProviders } from "@/hooks/useProviders";
import { api } from "@/services/engine";
import type { ProviderInfo } from "@/types/engine";
import { errorMessage } from "@/utils/format";
import type { ChatModelChoice } from "./models";

/** Make this the model of its provider and the chat's choice. */
async function applyModelChoice(qc: QueryClient, providers: ProviderInfo[], choice: ChatModelChoice): Promise<void> {
  if (providers.find((p) => p.id === choice.providerId)?.model !== choice.model) {
    await api.updateProvider(choice.providerId, { model: choice.model });
    await qc.invalidateQueries({ queryKey: qk.providers });
  }
  usePrefs.getState().set({ chatProvider: choice.providerId, chatModel: choice.model, answerProvider: choice.providerId });
}

/** What the chat's model list calls when a model is picked. */
export function useSelectModel(): (choice: ChatModelChoice) => void {
  const qc = useQueryClient();
  const { data } = useProviders();
  return useCallback(
    (choice: ChatModelChoice) => {
      // The chat follows at once; the provider takes the model in the background.
      usePrefs.getState().set({ chatProvider: choice.providerId, chatModel: choice.model });
      void applyModelChoice(qc, data ?? [], choice).catch((err) => toast.error("The model was not changed", errorMessage(err)));
    },
    [qc, data],
  );
}
