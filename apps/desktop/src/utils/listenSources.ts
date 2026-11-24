/**
 * What ZHU listens to: system audio (the call), the microphone, or both. The choice is the engine's
 * `audio.system_enabled` / `audio.microphone_enabled` pair, so Start listening, the hotkey and the
 * tray all use it; a change while listening applies at once.
 */
import type { EngineSettings, SettingsPatch } from "@/types/engine";

export type ListenSources = "both" | "system" | "microphone";

export interface ListenSourcesOption {
  value: ListenSources;
  /** In the menu and in Settings. */
  label: string;
  /** On the title-bar button. */
  short: string;
  description: string;
  /** Finishes "ZHU listens to …". */
  listensTo: string;
}

export const LISTEN_SOURCES: ListenSourcesOption[] = [
  {
    value: "both",
    label: "System audio and microphone",
    short: "System + mic",
    description: "The call and what you say",
    listensTo: "the call (system audio) and your microphone",
  },
  {
    value: "system",
    label: "System audio only",
    short: "System audio",
    description: "The call: what the others say",
    listensTo: "the call (system audio)",
  },
  {
    value: "microphone",
    label: "Microphone only",
    short: "Microphone",
    description: "Only what you say",
    listensTo: "your microphone",
  },
];

/** The sources to start, as the engine names them. */
export function listenSourcesList(choice: ListenSources): ("microphone" | "system")[] {
  return choice === "both" ? ["microphone", "system"] : [choice];
}

/** The choice in these settings; null if neither is on (settings saved before there was a choice). */
export function listenSources(audio: Pick<EngineSettings["audio"], "system_enabled" | "microphone_enabled">): ListenSources | null {
  if (audio.system_enabled && audio.microphone_enabled) return "both";
  if (audio.system_enabled) return "system";
  if (audio.microphone_enabled) return "microphone";
  return null;
}

export function listenSourcesPatch(choice: ListenSources): SettingsPatch {
  return { audio: { system_enabled: choice !== "microphone", microphone_enabled: choice !== "system" } };
}

export function listenSourcesOption(choice: ListenSources): ListenSourcesOption {
  return LISTEN_SOURCES.find((o) => o.value === choice) ?? LISTEN_SOURCES[0];
}
