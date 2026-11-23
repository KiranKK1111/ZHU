import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "@/app/state/ui";
import { IconButton } from "@/components/primitives/Button";
import { onShellEvent, shell } from "@/services/shell";
import { errorMessage } from "@/utils/format";

/**
 * Takes ZHU out of the taskbar, Alt+Tab and screen captures, and puts it back. The shell holds
 * the state (the tray menu has the same switch), so the button asks for it when it appears and
 * then follows the shell's event. The window itself stays on the user's screen either way; while
 * hidden it also stays on top of other windows (the shell does all of that, see bars.rs).
 */
export function HideFromBarsButton() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void shell
      .hiddenFromBars()
      .then((h) => {
        if (!cancelled) setHidden(h);
      })
      .catch(() => undefined);
    void onShellEvent<boolean>("zhu://hidden-from-bars", setHidden).then((u) => (cancelled ? u() : (off = u)));
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const toggle = () => {
    const next = !hidden;
    void shell
      .setHiddenFromBars(next)
      .then(() => {
        // Alt+Tab no longer reaches the window, so it stays in front instead: say so.
        if (next)
          toast.info(
            "Hidden from the taskbar, Alt+Tab and screen capture",
            "ZHU now stays on top of other windows, has no icon in the system tray, is left out of screenshots and screen sharing, and is 80% opaque (the opacity button changes that). Minimized, the floating icon brings it back. It stays hidden when ZHU is opened again, until you press the eye again.",
          );
      })
      .catch((err) => toast.error("Could not change this", errorMessage(err)));
  };

  return (
    <IconButton label={hidden ? "Show ZHU in the taskbar, Alt+Tab and screen capture" : "Hide ZHU from the taskbar, Alt+Tab and screen capture"} active={hidden} onClick={toggle}>
      {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </IconButton>
  );
}
