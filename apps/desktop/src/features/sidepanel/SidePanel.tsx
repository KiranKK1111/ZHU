import { cn } from "@/utils/cn";
import { ResumeSection } from "./ResumeSection";
import { ScreenshotsSection } from "./ScreenshotsSection";

/**
 * The panel on the right of every screen: the screenshots ZHU has taken, and the user's résumé
 * underneath. It is opened and closed with the button in the title bar.
 */
export function SidePanel({ narrow }: { narrow: boolean }) {
  return (
    <aside aria-label="Screenshots and résumé" className={cn("flex shrink-0 flex-col border-l border-border-subtle bg-sidebar", narrow ? "w-[264px]" : "w-[300px]")}>
      <ScreenshotsSection />
      <ResumeSection />
    </aside>
  );
}
