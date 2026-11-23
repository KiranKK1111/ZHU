import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GpuInfo, ModelsStatus } from "@/types/engine";

const opened = vi.fn(async (_url: string) => undefined);
vi.mock("@/services/shell", () => ({
  inTauri: false,
  openExternal: (url: string) => opened(url),
  shell: {},
  onShellEvent: async () => () => undefined,
  broadcast: async () => undefined,
}));

import { ModelSetup } from "@/components/setup/ModelSetup";
import { TooltipProvider } from "@/components/primitives/Tooltip";

const NO_DRIVER = {
  title: "NVIDIA graphics driver not installed",
  message: "This computer has an NVIDIA graphics card, but its driver is not installed, so ZHU cannot use it.",
  driver_url: "https://www.nvidia.com/drivers",
};

function status(gpu: Partial<GpuInfo>): ModelsStatus {
  return {
    catalog: [{ name: "small", label: "Whisper small", notes: "CPU-friendly fallback.", download_mb: 480, multilingual: true, backend: "whisper", memory_summary: "", cpu_ram_mb: 700 }] as unknown as ModelsStatus["catalog"],
    installed: [],
    recommended: "small",
    active_download: null,
    downloads: {},
    selected: "small",
    gpu: { cuda_available: false, device_name: null, driver_version: null, vram_total_mb: null, vram_free_mb: null, vram_used_mb: null, engine_vram_mb: null, utilization_pct: null, temperature_c: null, compute_types: null, error: null, ...gpu },
    setup_required: true,
    host_memory: null,
    memory_warning: null,
  };
}

const show = (s: ModelsStatus) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ModelSetup status={s} onDone={() => undefined} onSkip={() => undefined} dismissible={false} />
      </TooltipProvider>
    </QueryClientProvider>,
  );

afterEach(cleanup);

describe("a graphics card without its driver", () => {
  it("is named on the setup screen, with where to get the driver, instead of 'no GPU'", () => {
    show(status({ warning: NO_DRIVER }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("NVIDIA graphics driver not installed");
    expect(alert.textContent).toContain("its driver is not installed");
    expect(screen.queryByText("No compatible NVIDIA GPU detected")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Get the driver/ }));
    expect(opened).toHaveBeenCalledWith("https://www.nvidia.com/drivers");
  });

  it("is not mentioned when there is nothing to install", () => {
    show(status({ warning: null }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("No compatible NVIDIA GPU detected")).toBeTruthy();
  });
});
