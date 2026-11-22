import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus, RefreshCw, Search, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { Switch } from "@/components/primitives/Controls";
import { Badge } from "@/components/primitives/Display";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Menu";
import { api } from "@/services/engine";
import type { ProviderInfo } from "@/types/engine";
import { cn } from "@/utils/cn";
import { INPUT_KINDS, INPUT_META, InputIcons, inputKinds, type InputKind } from "./ModelInputs";
import { chatModelGroups, filterGroups, usableForChat, type ChatModelOption } from "./models";

/** Rows drawn at once. Gateways list hundreds of models; the search box narrows them. */
const MAX_ROWS = 120;
/** The providers' model lists were asked for again in this run (see learnInputs). */
let askedForInputs = false;

/**
 * The model chip in the message box. It lists the models of every connected provider, the free
 * ones by default, and leads to connecting more providers.
 */
export function ModelPicker({ providers, selected, onSelect, onManageProviders }: { providers: ProviderInfo[]; selected: ChatModelOption | null; onSelect: (o: ChatModelOption) => void; onManageProviders: () => void }) {
  const qc = useQueryClient();
  const freeOnly = usePrefs((p) => p.chatFreeOnly);
  const setPrefs = usePrefs((p) => p.set);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  /** Show only the models that take this ("image", "file", …; "text" for text-only models). */
  const [input, setInput] = useState<InputKind | null>(null);

  const offered = useMemo(() => chatModelGroups(providers, freeOnly), [providers, freeOnly]);
  // The filter chips double as the legend of the icons; only the kinds that occur are offered.
  const kinds = useMemo(() => {
    const seen = new Set(offered.flatMap((g) => g.options.flatMap((o) => inputKinds(o.inputs))));
    return ([...INPUT_KINDS, "text"] as InputKind[]).filter((k) => seen.has(k));
  }, [offered]);
  const active = input && kinds.includes(input) ? input : null;
  const groups = useMemo(() => filterGroups(offered, query, active), [offered, query, active]);
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  const paidHidden = freeOnly && chatModelGroups(providers, false).some((g) => g.options.some((o) => !o.free));
  let budget = MAX_ROWS;

  /** Ask every connected provider for its current model list (models come and go, free ones especially). */
  const refresh = async () => {
    setRefreshing(true);
    try {
      const results = await Promise.allSettled(providers.filter(usableForChat).map((p) => api.testProvider(p.id)));
      await qc.invalidateQueries({ queryKey: qk.providers });
      const failed = results.filter((r) => r.status === "rejected" || !r.value.ok).length;
      if (failed) toast.info("Model lists updated", `${failed} provider${failed === 1 ? "" : "s"} did not answer.`);
    } finally {
      setRefreshing(false);
    }
  };

  // A provider connected by an earlier version has a model list without what each model takes.
  // The lists are asked for again the first time the picker opens, once per run, without a notice.
  const learnInputs = () => {
    if (askedForInputs || !providers.some((p) => usableForChat(p) && p.config.known_models.length > 0 && p.config.model_inputs == null)) return;
    askedForInputs = true;
    void Promise.allSettled(providers.filter((p) => usableForChat(p) && p.config.model_inputs == null).map((p) => api.testProvider(p.id))).then(() => qc.invalidateQueries({ queryKey: qk.providers }));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) learnInputs();
        else setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={selected ? `Model: ${selected.label} from ${selected.providerName}. Change model` : "Choose a model"}
          className="group inline-flex h-8 min-w-0 max-w-full items-center gap-2 rounded-full border border-border-subtle bg-surface-2 pl-2.5 pr-2 text-secondary text-fg transition-colors duration-fast hover:border-border hover:bg-surface-3"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />
          {selected ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate font-medium">{selected.label}</span>
              <span className="hidden shrink-0 text-caption text-fg-3 @[520px]:inline">{selected.providerName}</span>
            </span>
          ) : (
            <span className="text-fg-2">Choose a model</span>
          )}
          {selected ? <InputIcons inputs={selected.inputs} /> : null}
          {selected?.free ? <Badge tone="success">Free</Badge> : null}
          <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform duration-fast", open && "rotate-180")} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="flex max-h-[min(480px,70vh)] w-[380px] max-w-[calc(100vw-32px)] flex-col p-0">
        <div className="relative shrink-0 border-b border-border-subtle">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            aria-label="Search models"
            spellCheck={false}
            className="h-10 w-full bg-transparent pl-9 pr-3 text-body text-fg placeholder:text-fg-3 focus-visible:outline-none"
          />
        </div>

        {kinds.length ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-subtle px-2 py-2" role="group" aria-label="Show models by what they can read">
            {kinds.map((k) => {
              const { icon: Icon, label, meaning, tone } = INPUT_META[k];
              const on = active === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  title={on ? "Show all models again" : `${meaning}. Click to show only these models`}
                  onClick={() => setInput(on ? null : k)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-full border pl-1 pr-2 text-caption transition-colors duration-fast",
                    on ? "border-[var(--zhu-accent)] bg-accent-soft text-fg" : "border-border-subtle text-fg-2 hover:border-border hover:bg-hover hover:text-fg",
                  )}
                >
                  <span className={cn("flex h-4 w-4 items-center justify-center rounded-full bg-[color-mix(in_srgb,currentColor_13%,transparent)]", tone)}>
                    <Icon className="h-2.5 w-2.5" aria-hidden />
                  </span>
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label="Models">
          {groups.length === 0 ? (
            <p className="px-3 py-6 text-center text-secondary text-fg-2">
              {query || active ? "No model matches." : freeOnly && paidHidden ? "None of the connected providers has a free model. Switch off “Free models only” to see the rest." : "No provider is connected yet."}
            </p>
          ) : null}
          {groups.map((g) => {
            const shown = g.options.slice(0, Math.max(0, budget));
            budget -= shown.length;
            if (!shown.length) return null;
            // A provider the user added that publishes no prices: ZHU cannot call its models paid or free.
            const priceUnknown = g.provider.user_defined && (g.provider.config.free_basis ?? "unknown") === "unknown";
            return (
              <div key={g.provider.id} className="pb-1">
                <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-caption text-fg-3">
                  <span className="truncate font-medium uppercase tracking-wide">{g.provider.name}</span>
                  {g.freeNote ? <span className="shrink-0 text-success">{g.freeNote}</span> : null}
                </div>
                {shown.map((o) => {
                  const chosen = selected?.providerId === o.providerId && selected.model === o.model;
                  return (
                    <button
                      key={o.model}
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      onClick={() => {
                        onSelect(o);
                        setOpen(false);
                        setQuery("");
                      }}
                      className={cn("flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body transition-colors duration-fast hover:bg-hover", chosen ? "bg-active text-fg" : "text-fg")}
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{chosen ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : null}</span>
                      <span className="min-w-0 flex-1 truncate" title={o.model}>
                        {o.label}
                      </span>
                      <InputIcons inputs={o.inputs} />
                      {o.free ? <span className="shrink-0 text-caption text-success">Free</span> : <span className="shrink-0 text-caption text-fg-3">{priceUnknown ? "Price unknown" : "Paid"}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {total > MAX_ROWS ? <p className="px-3 py-2 text-caption text-fg-3">Showing {MAX_ROWS} of {total} models. Search to narrow the list.</p> : null}
        </div>

        <div className="flex shrink-0 flex-col gap-1 border-t border-border-subtle p-2">
          <label className="flex items-center justify-between gap-3 px-1 py-1 text-secondary text-fg-2">
            Free models only
            <Switch checked={freeOnly} label="Show free models only" onCheckedChange={(v) => setPrefs({ chatFreeOnly: v })} />
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onManageProviders();
              }}
              className="inline-flex h-8 flex-1 items-center gap-2 rounded-sm px-2 text-secondary font-medium text-accent transition-colors duration-fast hover:bg-accent-soft"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add or connect a provider
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              title="Ask the connected providers for their current models"
              className="inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-secondary text-fg-2 transition-colors duration-fast hover:bg-hover hover:text-fg disabled:opacity-[var(--zhu-opacity-disabled)]"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} aria-hidden />
              Refresh
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
