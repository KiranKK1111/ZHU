/** The screenshots in the side panel: all of them (no sessions), Delete all beside Capture, an empty box that is seen whole. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Screenshot } from "@/types/engine";

let shots: Screenshot[] = [];
const api = {
  screenshots: vi.fn(async (_session: string | null) => shots),
  deleteScreenshot: vi.fn(async (id: string) => {
    shots = shots.filter((s) => s.id !== id);
    return { ok: true };
  }),
};
vi.mock("@/services/engine", () => ({
  get api() {
    return api;
  },
}));
vi.mock("@/components/capture/Thumb", () => ({ Thumb: () => <span /> }));
vi.mock("@/hooks/useActions", () => ({ useCaptureActions: () => ({ screen: vi.fn() }) }));

import { TooltipProvider } from "@/components/primitives/Tooltip";
import { ScreenshotsSection } from "@/features/sidepanel/ScreenshotsSection";

const shot = (id: string) => ({ id, session_id: "s1", created_at: 1, width: 1920, height: 1080, bytes: 1000, duplicate: false, mime: "image/png" }) as unknown as Screenshot;
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ScreenshotsSection />
      </TooltipProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  shots = [];
  api.screenshots.mockClear();
  api.deleteScreenshot.mockClear();
});
afterEach(cleanup);

describe("the screenshots panel", () => {
  it("lists every screenshot, with no session switch, and an empty box that fills its place", async () => {
    show();
    expect(await screen.findByText("No screenshots yet.")).toBeTruthy();
    expect(api.screenshots).toHaveBeenCalledWith(null);
    expect(screen.queryByText("This session")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByText("No screenshots yet.").parentElement!.className).toContain("flex-1");
    expect((screen.getByRole("button", { name: "Delete all screenshots" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("deletes all of them after asking, from the button beside Capture", async () => {
    shots = [shot("a"), shot("b")];
    show();
    const all = await screen.findByRole("button", { name: "Delete all screenshots" });
    await waitFor(() => expect((all as HTMLButtonElement).disabled).toBe(false));
    expect(all.previousElementSibling?.getAttribute("aria-label") ?? all.previousElementSibling?.textContent).toBeTruthy(); // Capture sits just before it
    fireEvent.click(all);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete all 2 screenshots?")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Delete/ })));
    await waitFor(() => expect(api.deleteScreenshot.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]));
  });
});
