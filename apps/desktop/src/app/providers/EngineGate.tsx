import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Power, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Logo } from "@/components/layout/Logo";
import { WindowControls } from "@/components/layout/TitleBar";
import { Button } from "@/components/primitives/Button";
import { Field, Input } from "@/components/primitives/Input";
import { useEngineConnection, type ConnectionState } from "@/hooks/useEngineConnection";
import { inTauri } from "@/services/shell";
import { cn } from "@/utils/cn";

/**
 * The window's relation to the local engine. Until the engine is first ready, a start screen.
 * After that the app stays on screen whatever the engine does: while it restarts, or after it
 * has failed, a notice at the bottom says so and offers Restart. When it is back, everything the
 * app shows is fetched again from the new engine.
 */
export function EngineGate({ children, compact }: { children: ReactNode; compact?: boolean }) {
  const { state, restart, restartApp, connectDev } = useEngineConnection();
  const qc = useQueryClient();
  const everReady = useRef(false);
  const away = useRef(false);

  useEffect(() => {
    if (state.status !== "ready") {
      if (everReady.current) away.current = true;
      return;
    }
    everReady.current = true;
    if (away.current) {
      away.current = false;
      void qc.invalidateQueries();
    }
  }, [state.status, qc]);

  if (state.status === "ready" || (everReady.current && state.status !== "dev-unconfigured")) {
    return (
      <>
        {children}
        {state.status !== "ready" ? <EngineNotice state={state} restart={restart} restartApp={restartApp} compact={compact} /> : null}
      </>
    );
  }
  return (
    <div className={cn("relative flex h-full w-full flex-col items-center justify-center gap-5 bg-bg px-6 text-center", compact && "gap-3 rounded-xl border border-border")}>
      {/* Keep the window movable and closable while the engine is unavailable. */}
      <div data-tauri-drag-region className={cn("absolute inset-x-0 top-0 flex justify-end", compact ? "h-8" : "h-titlebar")}>
        {!compact ? <WindowControls /> : null}
      </div>
      {!compact ? <Logo size={64} className="drop-shadow-[0_10px_24px_rgba(91,75,224,0.35)]" /> : null}
      {state.status === "starting" ? (
        <div className="flex flex-col items-center gap-3" role="status">
          <div className="h-1 w-40 overflow-hidden rounded-full bg-surface-2">
            <div className="zhu-skeleton h-full w-full" />
          </div>
          <p className="text-secondary text-fg-2">Starting the local processing engine…</p>
        </div>
      ) : null}
      {state.status === "failed" ? (
        <div className="flex max-w-md flex-col items-center gap-3" role="alert">
          <div className="flex items-center gap-2 text-danger">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-body font-medium">The local engine is not running</span>
          </div>
          <p className="break-words text-secondary text-fg-2">{state.error}</p>
          {inTauri ? <RestartButton state={state} restart={restart} restartApp={restartApp} /> : null}
        </div>
      ) : null}
      {state.status === "dev-unconfigured" ? <DevConnect onConnect={connectDev} /> : null}
    </div>
  );
}

type Actions = { restart: () => Promise<void>; restartApp: () => Promise<void> };

function RestartButton({ state, restart, restartApp, size }: Actions & { state: Extract<ConnectionState, { status: "failed" }>; size?: "sm" }) {
  return state.stuck ? (
    <Button variant="primary" size={size} icon={<Power className="h-4 w-4" />} onClick={() => void restartApp()}>
      Restart ZHU
    </Button>
  ) : (
    <Button variant="primary" size={size} icon={<RotateCcw className="h-4 w-4" />} onClick={() => void restart()}>
      Restart engine
    </Button>
  );
}

/** Shown over the app while the engine is away after it had been running. */
function EngineNotice({ state, restart, restartApp, compact }: Actions & { state: ConnectionState; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = state.status === "failed";
  return (
    <div className={cn("pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4", compact ? "bottom-2" : "bottom-5")}>
      <div
        role={failed ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex max-w-[560px] flex-col gap-2 rounded-xl border bg-surface px-4 py-3 text-left shadow-3",
          failed ? "border-[color-mix(in_srgb,var(--zhu-error)_45%,transparent)]" : "border-border",
        )}
      >
        <div className="flex items-center gap-3">
          {failed ? <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden /> : <RotateCcw className="h-4 w-4 shrink-0 animate-spin text-accent [animation-duration:1.6s]" aria-hidden />}
          <span className="min-w-0 flex-1 text-body text-fg">{failed ? "The local engine stopped." : "Restarting the local engine…"}</span>
          {failed && inTauri ? <RestartButton state={state} restart={restart} restartApp={restartApp} size="sm" /> : null}
        </div>
        {failed ? (
          <div className="pl-7">
            <button type="button" onClick={() => setOpen((v) => !v)} className="text-caption text-fg-3 underline-offset-2 hover:text-fg-2 hover:underline">
              {open ? "Hide the details" : "Show the details"}
            </button>
            {open ? <p className="selectable mt-1 break-words text-caption text-fg-2">{state.error}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DevConnect({ onConnect }: { onConnect: (port: number, token: string) => void }) {
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  return (
    <form
      className="flex w-full max-w-sm flex-col gap-3 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        if (Number(port) && token) onConnect(Number(port), token);
      }}
    >
      <p className="text-center text-secondary text-fg-2">
        Browser development mode. Start the engine with <code className="zhu-code">python -m zhu_engine</code> and enter the port and token it prints.
      </p>
      <Field label="Port" htmlFor="dev-port">
        <Input id="dev-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
      </Field>
      <Field label="Token" htmlFor="dev-token">
        <Input id="dev-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" disabled={!Number(port) || !token}>
        Connect
      </Button>
    </form>
  );
}
