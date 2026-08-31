import { describe, expect, test } from "bun:test";
import {
  compileCodexPromptSurfaceProfile,
  isCodexPromptSurfaceProfileName,
} from "../scripts/codex-prompt-surface-profile.js";

describe("Codex prompt-surface profiles", () => {
  test("keeps the default surface unchanged", () => {
    expect(compileCodexPromptSurfaceProfile("full")).toMatchObject({
      configArgs: [],
      contextRetirements: [],
      capabilityRetirements: [],
    });
  });

  test("mutes only the eager skill catalogue", () => {
    expect(compileCodexPromptSurfaceProfile("skills-catalogue-muted")).toMatchObject({
      configArgs: ["--config", "skills.include_instructions=false"],
      contextRetirements: ["skills-catalogue"],
      capabilityRetirements: [],
    });
  });

  test("makes broad capability retirement explicit for closed tasks", () => {
    const profile = compileCodexPromptSurfaceProfile("closed-task");
    expect(profile.configArgs).toEqual([
      "--config", "skills.include_instructions=false",
      "--config", "features.plugins=false",
      "--config", "features.apps=false",
    ]);
    expect(profile.capabilityRetirements).toEqual(["plugins", "apps"]);
  });

  test("recognizes only versioned profile names", () => {
    expect(isCodexPromptSurfaceProfileName("closed-task")).toBe(true);
    expect(isCodexPromptSurfaceProfileName("auto")).toBe(false);
  });
});
