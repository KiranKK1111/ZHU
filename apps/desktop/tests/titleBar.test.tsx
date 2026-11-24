/** The title bar: Settings from the gear (no sidebar), and no session name or session controls. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/shell", () => ({ inTauri: false, shell: {}, broadcast: async () => undefined, onShellEvent: async () => () => undefined }));
vi.mock("@/components/layout/ListeningControl", () => ({ ListeningControl: () => <button type="button">Start listening</button> }));

import { ROUTES } from "@/app/routing/routes";
import { DEFAULT_PREFS, usePrefs } from "@/app/state/prefs";
import { useNav } from "@/app/state/ui";
import { TitleBar } from "@/components/layout/TitleBar";
import { TooltipProvider } from "@/components/primitives/Tooltip";

const show = () => render(<TooltipProvider><TitleBar /></TooltipProvider>);

beforeEach(() => {
  usePrefs.setState({ ...DEFAULT_PREFS });
  useNav.setState({ route: "webchats" });
});
afterEach(cleanup);

describe("the title bar", () => {
  it("opens Settings with the gear, and goes back to the chats with the house it becomes", () => {
    show();
    const gear = screen.getByRole("button", { name: "Settings" });
    expect(gear.querySelector("svg")?.getAttribute("class")).toContain("lucide-settings");
    fireEvent.click(gear);
    expect(useNav.getState().route).toBe("settings");
    // In Settings the same button is a house that goes back to the chats.
    const home = screen.getByRole("button", { name: "Back to the chats" });
    expect(home.querySelector("svg")?.getAttribute("class")).toContain("lucide-house");
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    fireEvent.click(home);
    expect(useNav.getState().route).toBe("webchats");
  });

  it("is the only way around: two screens, the chats first", () => {
    expect(ROUTES.map((r) => r.id)).toEqual(["webchats", "settings"]);
    expect(useNav.getInitialState().route).toBe("webchats");
  });
});
