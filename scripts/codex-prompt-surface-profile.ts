export const CODEX_PROMPT_SURFACE_PROFILE_VERSION = "codex-prompt-surface-profile/1" as const;

export type CodexPromptSurfaceProfileName =
  | "full"
  | "skills-catalogue-muted"
  | "closed-task";

export interface CompiledCodexPromptSurfaceProfile {
  readonly name: CodexPromptSurfaceProfileName;
  readonly version: typeof CODEX_PROMPT_SURFACE_PROFILE_VERSION;
  readonly configArgs: readonly string[];
  readonly contextRetirements: readonly string[];
  readonly capabilityRetirements: readonly string[];
}

const PROFILES: Readonly<Record<CodexPromptSurfaceProfileName, CompiledCodexPromptSurfaceProfile>> = {
  full: {
    name: "full",
    version: CODEX_PROMPT_SURFACE_PROFILE_VERSION,
    configArgs: [],
    contextRetirements: [],
    capabilityRetirements: [],
  },
  "skills-catalogue-muted": {
    name: "skills-catalogue-muted",
    version: CODEX_PROMPT_SURFACE_PROFILE_VERSION,
    configArgs: ["--config", "skills.include_instructions=false"],
    contextRetirements: ["skills-catalogue"],
    capabilityRetirements: [],
  },
  "closed-task": {
    name: "closed-task",
    version: CODEX_PROMPT_SURFACE_PROFILE_VERSION,
    configArgs: [
      "--config", "skills.include_instructions=false",
      "--config", "features.plugins=false",
      "--config", "features.apps=false",
    ],
    contextRetirements: [
      "skills-catalogue",
      "plugin-instructions",
      "app-instructions",
      "recommended-plugin-catalogue",
    ],
    capabilityRetirements: ["plugins", "apps"],
  },
};

export function isCodexPromptSurfaceProfileName(
  value: string,
): value is CodexPromptSurfaceProfileName {
  return value === "full" || value === "skills-catalogue-muted" || value === "closed-task";
}

export function compileCodexPromptSurfaceProfile(
  name: CodexPromptSurfaceProfileName,
): CompiledCodexPromptSurfaceProfile {
  const profile = PROFILES[name];
  return {
    ...profile,
    configArgs: [...profile.configArgs],
    contextRetirements: [...profile.contextRetirements],
    capabilityRetirements: [...profile.capabilityRetirements],
  };
}
