import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineInfo } from "@/types/shell";

/** The shell as the window sees it: the engine's state, its announcements, and the two restarts. */
let announce: ((info: EngineInfo) => void) | undefined;
let current: EngineInfo = { status: "starting", port: null, token: null, error: null };
const restartEngine = vi.fn(async (): Promise<EngineInfo> => ({ status: "ready", port: 2, token: "t".repeat(48), error: null }));
const restartApp = vi.fn(async () => undefined);
vi.mock("@/services/shell", () => ({
  inTauri: true,
  shell: { engineInfo: async () => current, restartEngine: () => restartEngine(), restartApp: () => restartApp() },
  onShellEvent: async (name: string, handler: (info: EngineInfo) => void) => {
    if (name === "zhu://engine") announce = handler;
    return () => undefined;
  },
}));

import { EngineGate } from "@/app/providers/EngineGate";
import { getConnection, setConnection } from "@/services/engine";

const ready = (port: number): EngineInfo => ({ status: "ready", port, token: "t".repeat(48), error: null });
let client: QueryClient;
const show = () =>
  render(
    <QueryClientProvider client={client}>
      <EngineGate compact>
        <p>the app</p>
      </EngineGate>
    </QueryClientProvider>,
  );
const listening = () => waitFor(() => expect(announce).toBeDefined());

beforeEach(() => {
  announce = undefined;
  current = { status: "starting", port: null, token: null, error: null };
  restartEngine.mockClear();
  restartApp.mockClear();
  setConnection(null);
  client = new QueryClient();
});
afterEach(cleanup);

describe("the window and the engine", () => {
  it("waits for the first start, then shows the app", async () => {
    show();
    await listening();
    expect(screen.queryByText("the app")).toBeNull();
    expect(screen.getByText("Starting the local processing engine…")).toBeTruthy();
    act(() => announce!(ready(1)));
    expect(screen.getByText("the app")).toBeTruthy();
    expect(getConnection()).toEqual({ port: 1, token: "t".repeat(48) });
  });

  it("keeps the app on screen while the engine restarts, then fetches everything again", async () => {
    const refetch = vi.spyOn(client, "invalidateQueries");
    show();
    await listening();
    act(() => announce!(ready(1)));
    act(() => announce!({ status: "starting", port: null, token: "x".repeat(48), error: null }));
    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.getByText("Restarting the local engine…")).toBeTruthy();
    expect(getConnection()).toBeNull(); // the old port leads nowhere
    expect(refetch).not.toHaveBeenCalled();
    act(() => announce!(ready(2)));
    expect(screen.queryByText("Restarting the local engine…")).toBeNull();
    expect(getConnection()?.port).toBe(2);
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it("keeps the app on screen when the engine fails, and restarts it from the notice", async () => {
    show();
    await listening();
    act(() => announce!(ready(1)));
    act(() => announce!({ status: "failed", port: null, token: null, error: "RuntimeError: the audio device vanished", stuck: false }));
    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("The local engine stopped.");
    fireEvent.click(screen.getByRole("button", { name: "Show the details" }));
    expect(screen.getByText("RuntimeError: the audio device vanished")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart engine" }));
    await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("the app")).toBeTruthy();
  });

  it("offers to restart ZHU when the engine will not stop", async () => {
    show();
    await listening();
    act(() => announce!(ready(1)));
    act(() => announce!({ status: "failed", port: null, token: null, error: "The engine did not stop when asked", stuck: true }));
    expect(screen.queryByRole("button", { name: "Restart engine" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart ZHU" }));
    await waitFor(() => expect(restartApp).toHaveBeenCalledTimes(1));
  });

  it("shows the reason and a Restart button when the engine fails before it was ever ready", async () => {
    current = { status: "failed", port: null, token: null, error: "The engine in ZHU's folder is incomplete", stuck: false };
    show();
    expect(await screen.findByText("The engine in ZHU's folder is incomplete")).toBeTruthy();
    expect(screen.queryByText("the app")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart engine" }));
    await waitFor(() => expect(restartEngine).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("the app")).toBeTruthy();
  });
});
