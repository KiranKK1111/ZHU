import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Cpu, Download, MemoryStick, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { qk } from "@/app/providers/queryKeys";
import { toast, useDownloads } from "@/app/state/ui";
import { Logo } from "@/components/layout/Logo";
import { WindowControls } from "@/components/layout/TitleBar";
import { Button } from "@/components/primitives/Button";
import { ConfirmDialog } from "@/components/primitives/Dialog";
import { Badge } from "@/components/primitives/Display";
import { api } from "@/services/engine";
import type { DownloadProgress, ModelSpec, ModelsStatus } from "@/types/engine";
import { cn } from "@/utils/cn";
import { errorMessage, formatBytes, formatMb } from "@/utils/format";

/**
 * First-run "Set up speech recognition". This is a one-time job: once a model is
 * installed, the engine reports setup_required=false and this screen never appears again.
 */
export function ModelSetup({ status, onDone, onSkip, dismissible }: { status: ModelsStatus; onDone: () => void; onSkip: () => void; dismissible: boolean }) {
  const qc = useQueryClient();
  const live = useDownloads((s) => s.progress);
  const [selected, setSelected] = useState<string>(status.recommended);
  const gpu = status.gpu;
  const progressFor = (name: string): DownloadProgress | undefined => live[name] ?? status.downloads[name];
  const active = Object.values(live).find((p) => p.state === "downloading" || p.state === "queued" || p.state === "verifying")?.model ?? status.active_download;
  const selectedProgress = progressFor(selected);
  const installedNow = status.installed.includes(selected) || selectedProgress?.state === "completed";

  const start = async (name: string) => {
    try {
      await api.downloadModel(name);
    } catch (err) {
      toast.error("Download could not start", errorMessage(err));
    }
  };

  /** Delete the selected model's files. The engine unloads it first if it is still in memory. */
  const remove = async (name: string) => {
    try {
      const next = await api.deleteModel(name);
      useDownloads.getState().clear(name);
      qc.setQueryData(qk.models, next);
      toast.success("Speech model removed", status.catalog.find((m) => m.name === name)?.label);
    } catch (err) {
      toast.error("Could not remove the model", errorMessage(err));
    }
  };

  const finish = async () => {
    try {
      await api.updateSettings({ transcription: { model: selected } });
    } catch {
      /* the engine already auto-selects the first installed model */
    }
    await qc.invalidateQueries({ queryKey: qk.models });
    onDone();
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="flex h-titlebar shrink-0 items-center justify-between pl-4">
        <Logo size={20} withWordmark />
        <div className="flex h-full items-center gap-1">
          {dismissible ? (
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onDone}>
              Close setup
            </Button>
          ) : null}
          <WindowControls />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }} className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-10 pt-6">
          <div>
            <h1 className="zhu-display text-display text-fg">Set up speech recognition</h1>
            <p className="mt-2 max-w-2xl text-body text-fg-2">
              ZHU transcribes audio locally on this computer. Choose a speech model to download once. It is stored in your local app data and reused every time you start ZHU.
            </p>
          </div>

          <div className="zhu-card flex items-center gap-4">
            <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", gpu.cuda_available ? "bg-success-soft text-success" : "bg-surface-2 text-fg-2")}>
              {gpu.cuda_available ? <MemoryStick className="h-5 w-5" /> : <Cpu className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-card text-fg">{gpu.cuda_available ? gpu.device_name ?? "NVIDIA GPU" : "No compatible NVIDIA GPU detected"}</div>
              <div className="text-secondary text-fg-2">
                {gpu.cuda_available
                  ? `${formatMb(gpu.vram_total_mb)} VRAM · ${formatMb(gpu.vram_free_mb)} free${gpu.driver_version ? ` · driver ${gpu.driver_version}` : ""}`
                  : "Local transcription will run in CPU mode. A smaller model is recommended."}
              </div>
            </div>
            <Badge tone={gpu.cuda_available ? "success" : "neutral"}>{gpu.cuda_available ? "GPU acceleration" : "CPU mode"}</Badge>
          </div>

          {status.memory_warning ? (
            <div role="note" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-secondary text-fg">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>
                <span className="font-medium">Low memory right now.</span> {status.memory_warning} The download works regardless; ZHU falls back to a smaller model if loading fails.
              </span>
            </div>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-caption font-semibold uppercase tracking-[0.06em] text-fg-3">Speech models</legend>
            {status.catalog.map((m) => (
              <ModelOption
                key={m.name}
                model={m}
                recommended={m.name === status.recommended}
                selected={selected === m.name}
                installed={status.installed.includes(m.name) || progressFor(m.name)?.state === "completed"}
                progress={progressFor(m.name)}
                gpuAvailable={gpu.cuda_available}
                onSelect={() => setSelected(m.name)}
              />
            ))}
          </fieldset>

          <DownloadPanel
            model={status.catalog.find((m) => m.name === selected)}
            progress={selectedProgress}
            installed={installedNow}
            busyOther={!!active && active !== selected}
            onStart={() => void start(selected)}
            onCancel={() => void api.cancelDownload().catch((e) => toast.error("Could not cancel", errorMessage(e)))}
            onFinish={() => void finish()}
            onRemove={() => remove(selected)}
          />

          {!installedNow ? (
            <div className="flex items-center justify-between gap-4 border-t border-border-subtle pt-4">
              <p className="text-secondary text-fg-3">You can use ZHU without transcription and download a model later in Settings → Transcription.</p>
              <Button variant="ghost" onClick={onSkip}>
                Skip for now
              </Button>
            </div>
          ) : null}
        </motion.div>
      </div>
    </div>
  );
}

function ModelOption({ model, recommended, selected, installed, progress, gpuAvailable, onSelect }: { model: ModelSpec; recommended: boolean; selected: boolean; installed: boolean; progress?: DownloadProgress; gpuAvailable: boolean; onSelect: () => void }) {
  return (
    <label
      className={cn(
        "flex cursor-default items-start gap-3 rounded-lg border p-3.5 transition-colors duration-fast",
        selected ? "border-accent bg-accent-soft" : "border-border-subtle bg-surface hover:border-border",
      )}
    >
      <input type="radio" name="model" checked={selected} onChange={onSelect} className="mt-1 accent-[var(--zhu-accent)]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-card text-fg">{model.label}</span>
          {recommended ? <Badge tone="accent">Recommended for this computer</Badge> : null}
          {installed ? <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>Installed</Badge> : null}
          {!model.multilingual ? <Badge>English only</Badge> : null}
          {progress && (progress.state === "downloading" || progress.state === "queued") ? <Badge tone="accent">Downloading</Badge> : null}
        </div>
        <p className="mt-1 text-secondary text-fg-2">{model.notes}</p>
        <p className="mt-1 text-caption text-fg-3">
          Download ≈ {formatMb(model.download_mb)}
          {model.backend === "parakeet" ? ` · ${gpuAvailable ? model.memory_summary : `CPU (INT8) ≈ ${formatMb(model.cpu_ram_mb)} RAM`}` : gpuAvailable ? ` · ${model.memory_summary}` : ""}
        </p>
      </div>
    </label>
  );
}

function DownloadPanel({
  model,
  progress,
  installed,
  busyOther,
  onStart,
  onCancel,
  onFinish,
  onRemove,
}: {
  model?: ModelSpec;
  progress?: DownloadProgress;
  installed: boolean;
  busyOther: boolean;
  onStart: () => void;
  onCancel: () => void;
  onFinish: () => void;
  onRemove: () => Promise<void>;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (!model) return null;
  const state = installed ? "completed" : progress?.state;
  const pct = progress?.total_bytes ? Math.min(100, (progress.downloaded_bytes / progress.total_bytes) * 100) : null;
  const running = state === "downloading" || state === "queued" || state === "verifying";
  return (
    <div className="zhu-card flex flex-col gap-3" aria-live="polite">
      {running ? (
        <>
          <div className="flex items-center justify-between gap-3 text-secondary">
            <span className="text-fg">{state === "verifying" ? "Verifying files…" : state === "queued" ? "Preparing download…" : `Downloading ${model.label}`}</span>
            <span className="tabular-nums text-fg-2">
              {formatBytes(progress?.downloaded_bytes)} / {progress?.total_bytes ? formatBytes(progress.total_bytes) : "…"}
              {pct !== null ? ` · ${Math.floor(pct)}%` : ""}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct !== null ? Math.floor(pct) : undefined}>
            <div className={cn("h-full rounded-full bg-accent transition-[width] duration-normal", pct === null && "zhu-skeleton w-full")} style={pct !== null ? { width: `${pct}%` } : undefined} />
          </div>
          <div>
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onCancel}>
              Cancel download
            </Button>
          </div>
        </>
      ) : state === "completed" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-body font-medium">{model.label} is installed and ready.</span>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
              <Button variant="primary" onClick={onFinish}>
                Continue to ZHU
              </Button>
            </div>
          </div>
          <p className="text-caption text-fg-3">
            An installed model only takes disk space (about {formatMb(model.download_mb)}). It uses GPU memory while ZHU is listening, and that memory is released two minutes after you stop.
          </p>
          <ConfirmDialog
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={`Remove ${model.label}?`}
            description={`This deletes the model's files and frees about ${formatMb(model.download_mb)} of disk space. You can download it again at any time.`}
            confirmLabel="Remove"
            destructive
            onConfirm={onRemove}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {state === "failed" || state === "cancelled" ? (
            <div role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-secondary text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{state === "cancelled" ? "Download cancelled. Already downloaded files are kept, so a retry resumes." : progress?.message ?? "The download failed."}</span>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-secondary text-fg-2">
              {model.label} · about {formatMb(model.download_mb)}. Downloaded once from Hugging Face; no audio or personal data is sent.
            </p>
            <Button variant="primary" disabled={busyOther} icon={state === "failed" || state === "cancelled" ? <RotateCcw className="h-4 w-4" /> : <Download className="h-4 w-4" />} onClick={onStart}>
              {state === "failed" || state === "cancelled" ? "Retry download" : "Download"}
            </Button>
          </div>
          {busyOther ? <p className="text-caption text-fg-3">Another model is downloading. Wait for it to finish or cancel it first.</p> : null}
        </div>
      )}
    </div>
  );
}
