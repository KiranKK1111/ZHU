import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the shell would answer and do. The shell holds the state; the button only follows it. */
let shellSays = false;
let shellEvent: ((hidden: boolean) => void) | undefined;
const setHidden = vi.fn(async (_hidden: boolean) => undefined);
const unlisten = vi.fn();
vi.mock("@/services/shell", () => ({
  inTauri: true,
  shell: { hiddenFromBars: async () => shellSays, setHiddenFromBars: (hidden: boolean) => setHidden(hidden) },
  onShellEvent: async (name: string, handler: (hidden: boolean) => void) => {
    if (name === "zhu://hidden-from-bars") shellEvent = handler;
    return unlisten;
  },
  broadcast: async () => undefined,
}));

import { useToasts } from "@/app/state/ui";
import { HideFromBarsButton } from "@/components/layout/HideFromBarsButton";
import { TooltipProvider } from "@/components/primitives/Tooltip";

const HIDE = "Hide ZHU from the taskbar, Alt+Tab and screen capture";
const SHOW = "Show ZHU in the taskbar, Alt+Tab and screen capture";
const show = () => render(<TooltipProvider><HideFromBarsButton /></TooltipProvider>);
const listening = () => waitFor(() => expect(shellEvent).toBeDefined());

beforeEach(() => {
  shellSays = false;
  shellEvent = undefined;
  setHidden.mockClear();
  unlisten.mockClear();
  useToasts.setState({ toasts: [] });
});
afterEach(cleanup);

describe("hide from the taskbar, Alt+Tab and screen capture", () => {
  it("offers to hide while ZHU is in the taskbar", async () => {
    show();
    await listening();
    expect(screen.getByRole("button", { name: HIDE }).getAttribute("aria-pressed")).toBe("false");
  });

  it("starts in the state the shell reports (the page can reload while ZHU is hidden)", async () => {
    shellSays = true;
    show();
    expect((await screen.findByRole("button", { name: SHOW })).getAttribute("aria-pressed")).toBe("true");
  });

  it("asks the shell to hide, changes only when the shell says so, and says how to get back", async () => {
    show();
    await listening();
    fireEvent.click(screen.getByRole("button", { name: HIDE }));
    expect(setHidden).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: HIDE })).toBeTruthy();

    act(() => shellEvent!(true));
    expect(screen.getByRole("button", { name: SHOW })).toBeTruthy();
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Hidden from the taskbar, Alt+Tab and screen capture"]));

    fireEvent.click(screen.getByRole("button", { name: SHOW }));
    expect(setHidden).toHaveBeenLastCalledWith(false);
    act(() => shellEvent!(false));
    expect(screen.getByRole("button", { name: HIDE })).toBeTruthy();
    // Coming back needs no explanation: the taskbar button is there again.
    await new Promise((r) => setTimeout(r, 0));
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("follows the switch in the tray menu", async () => {
    show();
    await listening();
    act(() => shellEvent!(true));
    expect(screen.getByRole("button", { name: SHOW })).toBeTruthy();
    act(() => shellEvent!(false));
    expect(screen.getByRole("button", { name: HIDE })).toBeTruthy();
    expect(setHidden).not.toHaveBeenCalled();
  });

  it("reports a shell failure and stays as it was", async () => {
    setHidden.mockRejectedValueOnce(new Error("window handle unavailable"));
    show();
    await listening();
    fireEvent.click(screen.getByRole("button", { name: HIDE }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => t.description)).toEqual(["window handle unavailable"]));
    expect(screen.getByRole("button", { name: HIDE })).toBeTruthy();
  });

  it("gives the mouse pointer back to Windows while ZHU is hidden: the Windows arrow (a screen share shows the pointer)", async () => {
    const { AppProviders } = await import("@/app/providers/AppProviders");
    const root = document.documentElement;
    const { unmount } = render(<AppProviders toasts={false}><span /></AppProviders>);
    await listening();
    await waitFor(() => expect(root.style.getPropertyValue("--zhu-cursor")).not.toBe(""));
    act(() => shellEvent!(true));
    // Unset, the one cursor rule falls back to the Windows arrow (sidepanel.test.ts checks the rule).
    expect(root.style.getPropertyValue("--zhu-cursor")).toBe("");
    act(() => shellEvent!(false));
    expect(root.style.getPropertyValue("--zhu-cursor")).not.toBe("");
    unmount();
  });

  it("stops listening when the title bar goes away", async () => {
    const { unmount } = show();
    await listening();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
