import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListeningStatus } from "@/types/engine";

const actions = { start: vi.fn(async () => undefined), pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), newSession: vi.fn(async () => undefined) };
vi.mock("@/hooks/useActions", () => ({ useListeningActions: () => actions }));
let setupRequired = false;
vi.mock("@/services/engine", () => ({ api: { models: async () => ({ setup_required: setupRequired, catalog: [] }) } }));

import { useSession } from "@/app/state/session";
import { useToasts, useNav } from "@/app/state/ui";
import { ListeningControl } from "@/components/layout/ListeningControl";
import { TooltipProvider } from "@/components/primitives/Tooltip";

const status = (state: ListeningStatus["state"], message: string | null = null) =>
  ({ state, message, session_id: "s1", elapsed_ms: 61_000, sources: {}, model: null, device: null, compute_type: null, selection_reason: null, stats: null, question_state: {} }) as ListeningStatus;

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ListeningControl />
      </TooltipProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  setupRequired = false;
  for (const f of Object.values(actions)) f.mockClear();
  useSession.setState({ listening: status("idle"), currentSessionId: "s1" });
  useToasts.setState({ toasts: [] });
});
afterEach(cleanup);

describe("listening in the title bar", () => {
  it("offers Start listening and New session while nothing is recorded", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Start listening/ }));
    expect(actions.start).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /New session/ }));
    expect(actions.newSession).toHaveBeenCalledTimes(1);
  });

  it("shows the live state with Pause and Stop while listening, Resume while paused", async () => {
    useSession.setState({ listening: status("listening") });
    show();
    expect((await screen.findByRole("status")).textContent).toContain("Live");
    expect(screen.queryByRole("button", { name: /Start listening/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New session/ })).toBeNull(); // not while recording
    fireEvent.click(screen.getByRole("button", { name: "Pause listening" }));
    expect(actions.pause).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(actions.stop).toHaveBeenCalledTimes(1);
    act(() => useSession.setState({ listening: status("paused") }));
    expect(screen.getByRole("status").textContent).toContain("Paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume listening" }));
    expect(actions.resume).toHaveBeenCalledTimes(1);
  });

  it("says once when listening stopped with an error, on any screen, and offers to start again", async () => {
    show();
    act(() => useSession.setState({ listening: status("error", "The microphone was unplugged") }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.description)).toEqual(["The microphone was unplugged"]));
    act(() => useSession.setState({ listening: { ...status("error", "The microphone was unplugged"), elapsed_ms: 1 } }));
    expect(useToasts.getState().toasts).toHaveLength(1);
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start listening/ })).toBeTruthy();
  });

  it("asks for a speech model first when none is installed", async () => {
    setupRequired = true;
    useNav.setState({ setupOpen: false });
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Set up speech recognition/ }));
    expect(useNav.getState().setupOpen).toBe(true);
  });
});
