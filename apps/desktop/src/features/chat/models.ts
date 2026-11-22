/**
 * The models the built-in chat can answer with: every model of every provider the user has
 * connected, with the free ones marked. All pure; the picker and the chat pane share it.
 */
import type { FreeBasis, ProviderInfo } from "@/types/engine";

export interface ChatModelOption {
  providerId: string;
  providerName: string;
  model: string;
  /** The model id without routing prefixes, for display. */
  label: string;
  free: boolean;
  /**
   * What the model takes besides text, as its provider's model list states it: "image", "file",
   * "audio", "video". An empty list is a text-only model; null means the provider does not say.
   */
  inputs: string[] | null;
}

/** What a model takes besides text, where the provider's model list says so (see ChatModelOption.inputs). */
export function modelInputs(p: ProviderInfo, model: string): string[] | null {
  return p.config.model_inputs?.[model] ?? null;
}

/** The entry for one model of a provider, also for a model its list does not (or no longer does) contain. */
export function chatModelOption(p: ProviderInfo, model: string): ChatModelOption {
  return { providerId: p.id, providerName: p.name, model, label: modelLabel(model), free: p.config.free_models.includes(model), inputs: modelInputs(p, model) };
}

export interface ChatModelGroup {
  provider: ProviderInfo;
  /** Why the provider's free models are free, in a few words (null when it has none). */
  freeNote: string | null;
  options: ChatModelOption[];
}

export interface ChatModelChoice {
  providerId: string;
  model: string;
}

/** A provider the chat can call: switched on, with a key (or none needed) and a known model. */
export function usableForChat(p: ProviderInfo): boolean {
  return p.status !== "disabled" && (p.has_api_key || !p.key_required) && providerModels(p).length > 0;
}

function providerModels(p: ProviderInfo): string[] {
  if (p.config.known_models.length) return p.config.known_models;
  return p.model ? [p.model] : [];
}

export function modelLabel(model: string): string {
  return model.replace(/^models\//, "");
}

export function freeNote(basis: FreeBasis | null, count: number): string | null {
  if (!count) return null;
  if (basis === "free_tier") return "Free tier";
  if (basis === "local") return "Runs on your computer";
  return count === 1 ? "1 free model" : `${count} free models`;
}

/** Connected providers and their models, free providers first, each with its free models first. */
export function chatModelGroups(providers: ProviderInfo[], freeOnly: boolean): ChatModelGroup[] {
  const groups: ChatModelGroup[] = [];
  for (const p of providers) {
    if (!usableForChat(p)) continue;
    const free = new Set(p.config.free_models);
    const all = providerModels(p).map((model) => ({ providerId: p.id, providerName: p.name, model, label: modelLabel(model), free: free.has(model), inputs: modelInputs(p, model) }));
    const options = (freeOnly ? all.filter((o) => o.free) : all).sort((a, b) => Number(b.free) - Number(a.free));
    if (options.length) groups.push({ provider: p, freeNote: freeNote(p.config.free_basis, free.size), options });
  }
  return groups.sort((a, b) => Number(!!b.freeNote) - Number(!!a.freeNote));
}

export function filterGroups(groups: ChatModelGroup[], query: string, input: string | null = null): ChatModelGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length && !input) return groups;
  return groups
    .map((g) => ({
      ...g,
      options: g.options.filter(
        (o) => (!input || (input === "text" ? o.inputs?.length === 0 : !!o.inputs?.includes(input))) && words.every((w) => o.model.toLowerCase().includes(w) || o.providerName.toLowerCase().includes(w)),
      ),
    }))
    .filter((g) => g.options.length);
}

/**
 * The model that answers: the user's choice while it is still offered; otherwise a free model
 * (each provider's own selected model first), so a fresh install never starts on a paid one.
 */
export function resolveChatModel(providers: ProviderInfo[], chosen: ChatModelChoice | null): ChatModelOption | null {
  const all = chatModelGroups(providers, false).flatMap((g) => g.options);
  if (chosen) {
    const match = all.find((o) => o.providerId === chosen.providerId && o.model === chosen.model);
    if (match) return match;
  }
  const selected = new Map(providers.map((p) => [p.id, p.model]));
  const free = all.filter((o) => o.free);
  return free.find((o) => selected.get(o.providerId) === o.model) ?? free[0] ?? all.find((o) => selected.get(o.providerId) === o.model) ?? all[0] ?? null;
}

/**
 * Whether the provider's model list says if this model reads images. A gateway lists models that
 * do next to models that reject an image; most other providers do not say.
 */
export function imageSupportKnown(p: ProviderInfo, model: string): boolean {
  return p.id === "claude" || modelInputs(p, model) !== null || (!!p.config.image_models && p.config.known_models.includes(model));
}

/** Whether screenshots are sent to this model: what the model list says, else the provider's own switch. */
export function readsImages(p: ProviderInfo, model: string): boolean {
  if (p.id === "claude") return true;
  const inputs = modelInputs(p, model);
  if (inputs) return inputs.includes("image");
  if (p.config.image_models && p.config.known_models.includes(model)) return p.config.image_models.includes(model);
  return p.config.images ?? p.default_images;
}

/** A model of the same provider that is known to read images; a free one when the current model is free. */
export function imageAlternative(providers: ProviderInfo[], current: ChatModelOption): ChatModelOption | null {
  const group = chatModelGroups(providers, false).find((g) => g.provider.id === current.providerId);
  if (!group) return null;
  const able = group.options.filter((o) => imageSupportKnown(group.provider, o.model) && readsImages(group.provider, o.model));
  return (current.free ? able.find((o) => o.free) : undefined) ?? (current.free ? null : (able[0] ?? null));
}

/** What "Add provider" reports after connecting: how many models were found and how many are free. */
export function describeConnection(name: string, models: number, free: number, basis: FreeBasis | null | undefined): { title: string; detail: string } {
  const found = models === 1 ? "1 model" : `${models} models`;
  if (basis === "local") return { title: `${name} connected`, detail: `${found} found. They run on your computer, so they are free to use.` };
  if (basis === "free_tier") return { title: `${name} connected`, detail: `${found} found, usable on the provider's free tier.` };
  if (basis === "listed") return { title: `${name} connected`, detail: free ? `${found} found, ${free} of them free.` : `${found} found. None of them is free.` };
  return { title: `${name} connected`, detail: `${found} found. This provider does not publish prices, so ZHU cannot tell which are free.` };
}
