/** The chat-tab options: no choice for the resume any more (it goes once per new chat, as a file). */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/shell", () => ({ inTauri: false, shell: {}, broadcast: async () => undefined }));

import { DEFAULT_PREFS } from "@/app/state/prefs";
import { TooltipProvider } from "@/components/primitives/Tooltip";
import { WebChatOptions } from "@/features/webchat/WebChatOptions";

afterEach(cleanup);

describe("chat tab options", () => {
  it("have no setting for the resume in new chats", () => {
    const { container } = render(<TooltipProvider><WebChatOptions /></TooltipProvider>);
    expect(screen.getByText("Fill in detected questions")).toBeTruthy();
    expect(container.textContent).not.toMatch(/resume/i);
    expect(screen.queryByRole("radio", { name: "As a file" })).toBeNull();
    expect("webChatResume" in DEFAULT_PREFS).toBe(false);
  });
});
