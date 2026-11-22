import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ExternalLink, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { usePrefs } from "@/app/state/prefs";
import { toast } from "@/app/state/ui";
import { Button } from "@/components/primitives/Button";
import { Select, Switch } from "@/components/primitives/Controls";
import { Badge, Skeleton } from "@/components/primitives/Display";
import { Input } from "@/components/primitives/Input";
import { describeConnection, freeNote } from "@/features/chat/models";
import { canCallApi, useProviders } from "@/hooks/useProviders";
import { api } from "@/services/engine";
import { openExternal } from "@/services/shell";
import type { ProviderInfo } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage } from "@/utils/format";

/** True for an address that would send the key and your questions unencrypted to another machine. */
export function isInsecureRemote(url: string): boolean {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    return !(h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost"));
  } catch {
    return false;
  }
}

/**
 * AI models: paste a key, press Connect, done. ZHU checks the key, lists the provider's models and
 * picks a sensible one; you can change it in the dropdown afterwards.
 */
export function ModelsSection() {
  const providers = useProviders();
  const [open, setOpen] = useState<string | null>(null);
  if (!providers.data) return <Skeleton className="h-64 w-full" />;
  const free = providers.data.filter((p) => p.free_tier);
  const rest = providers.data.filter((p) => !p.free_tier);
  const row = (p: ProviderInfo) => <ModelRow key={p.id} provider={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />;
  return (
    <div className="flex flex-col gap-2">
      {free.map(row)}
      {rest.map(row)}
      <AddOwnModel />
    </div>
  );
}

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: qk.providers });
}

function ModelRow({ provider: p, open, onToggle }: { provider: ProviderInfo; open: boolean; onToggle: () => void }) {
  const refresh = useRefresh();
  const answerProvider = usePrefs((s) => s.answerProvider);
  const setPrefs = usePrefs((s) => s.set);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const connected = p.status === "ready";
  const models = p.config.known_models.length ? p.config.known_models : p.model ? [p.model] : [];
  const free = new Set(p.config.free_models);
  // Where only some models are free, the list says which; otherwise the badge on the row covers them all.
  const mixed = free.size > 0 && free.size < models.length;
  const modelOptions = models.map((m) => ({ value: m, label: m.replace(/^models\//, ""), description: mixed && free.has(m) ? "Free" : undefined }));
  const freeLabel = p.config.free_basis === "free_tier" ? null : freeNote(p.config.free_basis, free.size);

  /** Save the key (when given), check it against the provider, and let the engine pick a model. */
  const connect = async (newKey?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      if (newKey) await api.updateProvider(p.id, { api_key: newKey, enabled: true });
      const r = await api.testProvider(p.id);
      await refresh();
      if (r.ok) {
        setKey("");
        if (!answerProvider) setPrefs({ answerProvider: p.id });
        const found = describeConnection(p.name, r.model_count ?? r.models.length, r.free_models?.length ?? 0, r.free_basis);
        toast.success(found.title, found.detail);
      } else {
        setProblem(r.message);
      }
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body: Parameters<typeof api.updateProvider>[1]) => {
    try {
      await api.updateProvider(p.id, body);
      await refresh();
    } catch (err) {
      toast.error("Not saved", errorMessage(err));
    }
  };

  return (
    <div className={cn("rounded-xl border bg-surface transition-colors duration-fast", open ? "border-border" : "border-border-subtle")}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", connected ? "bg-success" : "bg-border")} aria-hidden />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-body font-medium text-fg">{p.name}</span>
              {p.free_tier ? <Badge tone="success">{p.key_required ? "Free tier" : "Free, no key needed"}</Badge> : null}
              {freeLabel ? <Badge tone="success">{freeLabel}</Badge> : null}
              {p.user_defined && p.config.free_basis === "unknown" ? <Badge title="This provider's model list carries no prices, so ZHU cannot tell which models are free.">Prices not published</Badge> : null}
              {connected ? <span className="sr-only">connected</span> : null}
            </span>
            <span className="line-clamp-2 text-caption text-fg-3" title={p.notes}>
              {p.notes}
            </span>
          </span>
        </button>
        {connected && models.length ? (
          <Select label={`${p.name} model`} size="sm" value={p.model} onValueChange={(m) => void patch({ model: m })} className="w-56" options={modelOptions} />
        ) : null}
        <Button size="sm" variant={connected ? "ghost" : "secondary"} onClick={onToggle} icon={connected ? <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} /> : <KeyRound className="h-3.5 w-3.5" />}>
          {connected ? "Manage" : "Connect"}
        </Button>
      </div>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-border-subtle px-4 py-3">
          {p.user_defined || p.id === "custom" ? <EndpointField provider={p} onSave={(url) => patch({ base_url: url })} /> : null}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void connect(key.trim());
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={p.has_api_key ? `Key saved (${p.api_key_hint ?? "hidden"}). Paste a new one to replace it` : p.key_required ? "Paste your API key" : p.free_tier ? "API key (optional: it works without one)" : "API key (leave empty for a local server)"}
              aria-label={`${p.name} API key`}
              className="min-w-[240px] flex-1"
              leading={<KeyRound className="h-3.5 w-3.5" />}
            />
            {key.trim() ? (
              <Button type="submit" variant="primary" loading={busy}>
                Connect
              </Button>
            ) : canCallApi(p) ? (
              <Button variant="secondary" loading={busy} onClick={() => void connect()}>
                {connected ? "Check connection" : "Connect"}
              </Button>
            ) : null}
            {p.keys_url ? (
              <Button variant="ghost" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void openExternal(p.keys_url!).catch(() => undefined)}>
                {p.free_tier ? "Get a free key" : "Get a key"}
              </Button>
            ) : null}
          </form>
          {problem ? (
            <p role="alert" className="text-secondary text-danger">
              {problem}
            </p>
          ) : null}
          {canCallApi(p) && p.status === "needs_model" && !models.length ? <p className="text-secondary text-fg-3">Press Connect to load this provider's models.</p> : null}
          {canCallApi(p) && p.status === "needs_model" && models.length ? (
            <Select label={`${p.name} model`} value={p.model} placeholder="Choose a model" onValueChange={(m) => void patch({ model: m })} className="w-72" options={modelOptions} />
          ) : null}
          {connected && p.id !== "claude" ? (
            <label className="flex items-center justify-between gap-4 text-secondary text-fg-2">
              This model can read screenshots
              <Switch checked={p.config.images ?? p.default_images} label={`${p.name} can read screenshots`} onCheckedChange={(v) => void patch({ images: v })} />
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-3">
            <span>Your key is stored in Windows Credential Manager and sent only to {p.name}.</span>
            <span className="ml-auto flex gap-1">
              {p.has_api_key ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.forgetProviderKey(p.id);
                      await refresh();
                      toast.success("Key removed", p.name);
                    } catch (err) {
                      toast.error("Could not remove the key", errorMessage(err));
                    }
                  }}
                >
                  Remove key
                </Button>
              ) : null}
              {p.user_defined ? (
                <Button
                  size="sm"
                  variant="danger"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={async () => {
                    try {
                      await api.removeProvider(p.id);
                      await refresh();
                      toast.success("Model removed", p.name);
                    } catch (err) {
                      toast.error("Could not remove the model", errorMessage(err));
                    }
                  }}
                >
                  Remove model
                </Button>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EndpointField({ provider: p, onSave }: { provider: ProviderInfo; onSave: (url: string) => Promise<void> }) {
  const current = p.config.base_url ?? p.default_base_url ?? "";
  const [url, setUrl] = useState(current);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:11434/v1" aria-label={`${p.name} address`} spellCheck={false} className="min-w-[240px] flex-1" />
        {url.trim() !== current ? (
          <Button variant="secondary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => void onSave(url.trim())}>
            Save address
          </Button>
        ) : null}
      </div>
      {isInsecureRemote(url) ? <p className="text-caption text-warning">This address is not encrypted (http). Your key and questions would travel in plain text.</p> : null}
    </div>
  );
}

/** Any other OpenAI-compatible model: a local one (Ollama, LM Studio) or another service. */
function AddOwnModel() {
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = name.trim().length > 0 && /^https?:\/\/[^\s/]+/i.test(url.trim());

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-left transition-colors duration-fast hover:bg-hover">
        <Plus className="h-4 w-4 text-fg-3" aria-hidden />
        <span>
          <span className="block text-body text-fg">Add another provider</span>
          <span className="block text-caption text-fg-3">A model on your own computer (Ollama, LM Studio) or any OpenAI-compatible service. ZHU finds its models and marks the free ones.</span>
        </span>
      </button>
    );
  }
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const created = await api.addCustomProvider({ name: name.trim(), base_url: url.trim(), api_key: key.trim() || null });
      const test = await api.testProvider(created.id);
      await refresh();
      // ZHU reads the new provider's model list straight away and says which models are free.
      const found = describeConnection(created.name, test.model_count ?? test.models.length, test.free_models?.length ?? 0, test.free_basis);
      if (test.ok) toast.success(found.title, found.detail);
      else toast.info(`${created.name} added`, `It did not answer yet: ${test.message}`);
      setOpen(false);
      setName("");
      setUrl("");
      setKey("");
    } catch (err) {
      toast.error("Could not add the model", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="text-body font-medium text-fg">Add another provider</div>
      <div className="grid grid-cols-1 gap-2 @[560px]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, for example Ollama" aria-label="Name" maxLength={60} autoFocus />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Address, for example http://localhost:11434/v1" aria-label="Address" spellCheck={false} />
      </div>
      <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key (leave empty for a local model)" aria-label="API key" leading={<KeyRound className="h-3.5 w-3.5" />} />
      {isInsecureRemote(url) ? <p className="text-caption text-warning">This address is not encrypted (http). Your key and questions would travel in plain text.</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!valid}>
          Add and connect
        </Button>
      </div>
    </form>
  );
}
