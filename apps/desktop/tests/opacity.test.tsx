import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The shell as the main window sees it: the hide switch, and where the opacity goes. */
let announceHidden: ((hidden: boolean) => void) | undefined;
let shellSaysHidden = false;
const applied = vi.fn(async (_opacity: number) => undefined);
vi.mock("@/services/shell", () => ({
  inTauri: true,
  shell: { hiddenFromBars: async () => shellSaysHidden, setWindowOpacity: (opacity: number) => applied(opacity) },
  onShellEvent: async (name: string, handler: (hidden: boolean) => void) => {
    if (name === "zhu://hidden-from-bars") announceHidden = handler;
    return () => undefined;
  },
  broadcast: async () => undefined,
}));

import { clampOpacity, HIDDEN_OPACITY, MIN_OPACITY, useHiddenLook, useOpacitySync, useWindowOpacity } from "@/app/state/opacity";
import { usePrefs } from "@/app/state/prefs";

/** The main window's part (useOpacitySync) and the title bar's (useWindowOpacity), together. */
let control: ReturnType<typeof useWindowOpacity>;
function Probe() {
  useOpacitySync();
  control = useWindowOpacity();
  return <p>{Math.round(control.opacity * 100)}%</p>;
}
const lastApplied = () => applied.mock.calls.at(-1)?.[0];

beforeEach(() => {
  announceHidden = undefined;
  shellSaysHidden = false;
  applied.mockClear();
  useHiddenLook.setState({ hidden: false, hiddenLevel: HIDDEN_OPACITY });
  usePrefs.getState().set({ windowOpacity: 1 });
});
afterEach(cleanup);

describe("opacity", () => {
  it("applies the everyday level, and keeps it when it changes", async () => {
    render(<Probe />);
    await waitFor(() => expect(lastApplied()).toBe(1));
    act(() => control.setOpacity(0.7));
    expect(screen.getByText("70%")).toBeTruthy();
    expect(lastApplied()).toBe(0.7);
    expect(usePrefs.getState().windowOpacity).toBe(0.7);
  });

  it("starts at 80% when ZHU is hidden, can be changed there, and goes back when shown", async () => {
    usePrefs.getState().set({ windowOpacity: 0.95 });
    render(<Probe />);
    await waitFor(() => expect(announceHidden).toBeDefined());
    act(() => announceHidden!(true));
    expect(lastApplied()).toBe(0.8);
    act(() => control.setOpacity(0.6));
    expect(lastApplied()).toBe(0.6);
    expect(usePrefs.getState().windowOpacity).toBe(0.95); // the everyday level is not touched
    act(() => announceHidden!(false));
    expect(lastApplied()).toBe(0.95);
    // Hidden again: 80% again, not what it was the last time.
    act(() => announceHidden!(true));
    expect(lastApplied()).toBe(0.8);
  });

  it("starts hidden when the shell says ZHU is hidden already (the page was reloaded)", async () => {
    shellSaysHidden = true;
    render(<Probe />);
    await waitFor(() => expect(lastApplied()).toBe(0.8));
  });

  it("stays within the range the slider offers", () => {
    expect(clampOpacity(0)).toBe(MIN_OPACITY);
    expect(clampOpacity(1.4)).toBe(1);
    expect(clampOpacity(Number.NaN)).toBe(1);
    expect(clampOpacity(0.734)).toBe(0.73);
  });
});
