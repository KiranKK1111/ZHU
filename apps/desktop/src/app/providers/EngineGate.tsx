import { AlertTriangle, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Logo } from "@/components/layout/Logo";
import { WindowControls } from "@/components/layout/TitleBar";
import { Button } from "@/components/primitives/Button";
import { Field, Input } from "@/components/primitives/Input";
import { useEngineConnection } from "@/hooks/useEngineConnection";
import { inTauri } from "@/services/shell";
import { cn } from "@/utils/cn";

/** Renders children only once the local engine is reachable. */
export function EngineGate({ children, compact }: { children: ReactNode; compact?: boolean }) {
  const { state, restart, connectDev } = useEngineConnection();
  if (state.status === "ready") return <>{children}</>;
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
          {inTauri ? (
            <Button variant="primary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => void restart()}>
              Restart engine
            </Button>
          ) : null}
        </div>
      ) : null}
      {state.status === "dev-unconfigured" ? <DevConnect onConnect={connectDev} /> : null}
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
