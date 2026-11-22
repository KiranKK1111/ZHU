import { Blend } from "lucide-react";
import { HIDDEN_OPACITY, MIN_OPACITY, useWindowOpacity } from "@/app/state/opacity";
import { usePrefs } from "@/app/state/prefs";
import { IconButton } from "@/components/primitives/Button";
import { Slider } from "@/components/primitives/Controls";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/primitives/Menu";

const percent = (value: number) => `${Math.round(value * 100)}%`;

/**
 * How see-through ZHU is. It covers all of ZHU: every screen, its menus and dialogs, the chat
 * tabs and the floating icon (the shell applies it to whole windows). While ZHU is hidden it has
 * a level of its own, which starts at 80%.
 */
export function OpacityButton() {
  const { opacity, hidden, setOpacity } = useWindowOpacity();
  const everyday = usePrefs((p) => p.windowOpacity);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={`Opacity: ${percent(opacity)}`} active={opacity < 1}>
          <Blend className="h-4 w-4" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <div className="flex flex-col gap-3">
          <div>
            <div className="mb-2 flex items-baseline justify-between text-secondary">
              <span className="font-medium text-fg">Opacity</span>
              <span className="tabular-nums text-fg-2">{percent(opacity)}</span>
            </div>
            <Slider label="Opacity of ZHU" value={opacity} min={MIN_OPACITY} max={1} step={0.01} onValueChange={setOpacity} />
            <div className="mt-1 flex justify-between text-caption text-fg-3" aria-hidden>
              <span>{percent(MIN_OPACITY)}</span>
              <span>100%</span>
            </div>
          </div>
          <p className="text-caption text-fg-3">
            {hidden
              ? `While ZHU is hidden it starts at ${percent(HIDDEN_OPACITY)}. When you show it again it goes back to ${percent(everyday)}.`
              : "Applies to all of ZHU: every screen, the chat tabs and the floating icon."}
          </p>
          {opacity < 1 ? (
            <button type="button" onClick={() => setOpacity(1)} className="self-start text-caption font-medium text-accent hover:underline">
              Back to 100%
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
