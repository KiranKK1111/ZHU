import { cn } from "@/utils/cn";
import { ResumeSection } from "./ResumeSection";
import { ScreenshotsSection } from "./ScreenshotsSection";

/**
 * The panel on the right: the screenshots ZHU has taken, and the user's resume and the job
 * underneath. It is opened and closed with the button in the title bar. The screenshots take the
 * height the resume leaves, but never less than 17.5rem (ScreenshotsSection): in a short window the whole
 * panel scrolls instead, so neither part is cut off.
 */
export function SidePanel({ narrow }: { narrow: boolean }) {
  return (
    <aside
      aria-label="Screenshots and resume"
      className={cn("flex shrink-0 flex-col overflow-y-auto overflow-x-hidden border-l border-border-subtle bg-sidebar", narrow ? "w-[264px]" : "w-[300px]")}
    >
      <ScreenshotsSection />
      <ResumeSection />
    </aside>
  );
}
