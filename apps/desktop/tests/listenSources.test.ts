import { describe, expect, it } from "vitest";
import { LISTEN_SOURCES, listenSources, listenSourcesPatch } from "@/utils/listenSources";

describe("what ZHU listens to", () => {
  it("is one of three, read from and written to the engine's two switches", () => {
    for (const { value } of LISTEN_SOURCES) {
      expect(listenSources(listenSourcesPatch(value).audio as { system_enabled: boolean; microphone_enabled: boolean })).toBe(value);
    }
    expect(listenSourcesPatch("system")).toEqual({ audio: { system_enabled: true, microphone_enabled: false } });
    expect(listenSourcesPatch("microphone")).toEqual({ audio: { system_enabled: false, microphone_enabled: true } });
  });

  it("is none when both switches were turned off before there was a choice", () => {
    expect(listenSources({ system_enabled: false, microphone_enabled: false })).toBeNull();
  });
});
