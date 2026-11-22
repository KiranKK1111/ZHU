/**
 * Engine connection lifecycle. In the desktop app the Rust shell owns the engine
 * process and hands over {port, token}. In a plain browser (developer mode) the
 * connection comes from ?port=&token= or from a value saved by the dev form.
 */
import { useCallback, useEffect, useState } from "react";
import { getConnection, setConnection } from "@/services/engine";
import { inTauri, onShellEvent, shell } from "@/services/shell";
import type { EngineInfo } from "@/types/shell";
import { errorMessage } from "@/utils/format";

export type ConnectionState = { status: "starting" } | { status: "ready" } | { status: "failed"; error: string } | { status: "dev-unconfigured" };

const DEV_KEY = "zhu.dev.connection";

export function useEngineConnection(): { state: ConnectionState; restart: () => Promise<void>; connectDev: (port: number, token: string) => void } {
  const [state, setState] = useState<ConnectionState>(() => (getConnection() ? { status: "ready" } : { status: "starting" }));

  const apply = useCallback((info: EngineInfo) => {
    if (info.status === "ready" && info.port && info.token) {
      setConnection({ port: info.port, token: info.token });
      setState({ status: "ready" });
    } else if (info.status === "failed") {
      setConnection(null);
      setState({ status: "failed", error: info.error ?? "The local engine could not be started." });
    } else {
      setState({ status: "starting" });
    }
  }, []);

  useEffect(() => {
    if (!inTauri) {
      const params = new URLSearchParams(window.location.search);
      let port = Number(params.get("port"));
      let token = params.get("token") ?? "";
      if (!port || !token) {
        try {
          const saved = JSON.parse(localStorage.getItem(DEV_KEY) ?? "null") as { port: number; token: string } | null;
          if (saved) ({ port, token } = saved);
        } catch {
          /* ignore */
        }
      }
      if (port && token) {
        setConnection({ port, token });
        setState({ status: "ready" });
      } else {
        setState({ status: "dev-unconfigured" });
      }
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onShellEvent<EngineInfo>("zhu://engine", apply).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    shell
      .engineInfo()
      .then((info) => !cancelled && apply(info))
      .catch((err) => !cancelled && setState({ status: "failed", error: errorMessage(err) }));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [apply]);

  const restart = useCallback(async () => {
    setState({ status: "starting" });
    setConnection(null);
    try {
      apply(await shell.restartEngine());
    } catch (err) {
      setState({ status: "failed", error: errorMessage(err) });
    }
  }, [apply]);

  const connectDev = useCallback((port: number, token: string) => {
    try {
      localStorage.setItem(DEV_KEY, JSON.stringify({ port, token }));
    } catch {
      /* ignore */
    }
    setConnection({ port, token });
    setState({ status: "ready" });
  }, []);

  return { state, restart, connectDev };
}
