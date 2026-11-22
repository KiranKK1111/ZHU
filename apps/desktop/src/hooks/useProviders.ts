import { useQuery } from "@tanstack/react-query";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { api } from "@/services/engine";
import type { ProviderInfo } from "@/types/engine";

export function useProviders() {
  return useQuery({ queryKey: qk.providers, queryFn: api.providers, staleTime: 30_000 });
}

/** Pure: the model that answers. The chosen one when it is connected, otherwise the first connected one. */
export function pickAnswerModel(providers: ProviderInfo[], chosen: string | null): ProviderInfo | null {
  const ready = providers.filter((p) => p.status === "ready");
  return ready.find((p) => p.id === chosen) ?? ready[0] ?? null;
}

/** Connected models and the one currently selected to answer questions. */
export function useAnswerModel(): { model: ProviderInfo | null; connected: ProviderInfo[]; loading: boolean } {
  const { data, isLoading } = useProviders();
  const chosen = usePrefs((p) => p.answerProvider);
  const providers = data ?? [];
  return { model: pickAnswerModel(providers, chosen), connected: providers.filter((p) => p.status === "ready"), loading: isLoading };
}

/** A key is stored, or none is needed (your own local endpoint). */
export function canCallApi(p: ProviderInfo): boolean {
  return p.has_api_key || !p.key_required;
}

export function modelLabel(p: ProviderInfo): string {
  return p.model ? `${p.name} · ${p.model.replace(/^models\//, "")}` : p.name;
}
