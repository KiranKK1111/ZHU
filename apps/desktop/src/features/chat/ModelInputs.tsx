import { FileText, Image, Mic, Type, Video, type LucideIcon } from "lucide-react";
import { cn } from "@/utils/cn";

/**
 * What a model can be given, as its provider's model list states it. "text" stands for a model
 * that takes text only. The order is the order of the icons in a row of the model list.
 */
export const INPUT_KINDS = ["image", "file", "audio", "video"] as const;
export type InputKind = (typeof INPUT_KINDS)[number] | "text";

interface InputMeta {
  icon: LucideIcon;
  /** The name on the filter chip. */
  label: string;
  /** What the icon means, for its tooltip and for screen readers. */
  meaning: string;
  /** Colour of the icon; its soft background is mixed from the same colour. */
  tone: string;
}

export const INPUT_META: Record<InputKind, InputMeta> = {
  image: { icon: Image, label: "Images", meaning: "Reads images: screenshots can be sent to it", tone: "text-accent" },
  file: { icon: FileText, label: "Documents", meaning: "Reads documents (PDF and other files)", tone: "text-warning" },
  audio: { icon: Mic, label: "Audio", meaning: "Takes audio", tone: "text-success" },
  video: { icon: Video, label: "Video", meaning: "Takes video", tone: "text-[#4aa3df]" },
  text: { icon: Type, label: "Text only", meaning: "Text only: it cannot read screenshots", tone: "text-fg-3" },
};

/** The kinds to draw for a model: its inputs in a fixed order, or "text" for a text-only model. */
export function inputKinds(inputs: string[] | null): InputKind[] {
  if (inputs === null) return [];
  const kinds = INPUT_KINDS.filter((k) => inputs.includes(k));
  return kinds.length ? kinds : ["text"];
}

/** One small tinted icon per thing the model takes. Nothing when its provider does not say. */
export function InputIcons({ inputs, className }: { inputs: string[] | null; className?: string }) {
  const kinds = inputKinds(inputs);
  if (!kinds.length) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1", className)} role="img" aria-label={kinds.map((k) => INPUT_META[k].meaning).join(". ")}>
      {kinds.map((k) => {
        const { icon: Icon, meaning, tone } = INPUT_META[k];
        return (
          <span key={k} title={meaning} className={cn("flex h-5 w-5 items-center justify-center rounded-[6px] bg-[color-mix(in_srgb,currentColor_13%,transparent)]", tone)}>
            <Icon className="h-3 w-3" aria-hidden />
          </span>
        );
      })}
    </span>
  );
}
