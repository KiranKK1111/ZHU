import { AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/primitives/Button";
import { openExternal } from "@/services/shell";
import type { GpuWarning } from "@/types/engine";
import { cn } from "@/utils/cn";

/**
 * A graphics card ZHU cannot use for want of its driver (the engine works out which and why,
 * system/gpu.py): what is wrong, what it means for ZHU, and where to get the driver.
 */
export function GpuDriverWarning({ warning, className }: { warning: GpuWarning; className?: string }) {
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-secondary text-fg", className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <div className="font-medium">{warning.title}</div>
          <p className="mt-0.5 text-fg-2">{warning.message}</p>
        </div>
        {warning.driver_url ? (
          <div>
            <Button size="sm" variant="secondary" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void openExternal(warning.driver_url!).catch(() => undefined)}>
              Get the driver
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
