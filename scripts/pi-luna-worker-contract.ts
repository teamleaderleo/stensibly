/** Shared, deliberately small contracts for the Pi-backed Luna worker. */

export const PI_LUNA_PACKAGE_NAME = "@earendil-works/pi-coding-agent" as const;
export const PI_LUNA_PACKAGE_VERSION = "0.84.4" as const;
export const PI_LUNA_PROVIDER = "openai-codex" as const;
export const PI_LUNA_MODEL = "gpt-5.6-luna" as const;
export const PI_LUNA_MODEL_REF = `${PI_LUNA_PROVIDER}/${PI_LUNA_MODEL}` as const;
export const PI_LUNA_REASONING_EFFORT = "max" as const;
export const PI_LUNA_EXTENSION_VERSION = "pi-luna-extension/1" as const;
export const PI_LUNA_RECEIPT_SCHEMA_VERSION = "pi-luna-worker-receipt/1" as const;
export const PI_LUNA_RESULT_SCHEMA_VERSION = "pi-luna-worker-result/1" as const;

export const PI_LUNA_TOOL_NAMES = [
  "luna_repo_read",
  "luna_repo_search",
  "luna_repo_git",
  "luna_repo_mutate",
  "luna_verify",
  "luna_result",
] as const;

export type PiLunaToolName = typeof PI_LUNA_TOOL_NAMES[number];
export type PiLunaEditAuthority = "read-only" | "workspace-write";
export type PiLunaOsBoundary = "bwrap" | "none";
export type PiLunaResultStatus = "complete" | "partial" | "blocked";

export interface PiLunaResult {
  readonly status: PiLunaResultStatus;
  readonly summary: string;
  readonly changedPaths: readonly string[];
  readonly verification: readonly string[];
  readonly remainingLimits: readonly string[];
}

export interface PiLunaVerificationCommand {
  readonly id: string;
  readonly argv: readonly string[];
}

/** Configuration consumed by the one reviewed extension through a private file. */
export interface PiLunaExtensionConfig {
  readonly schemaVersion: typeof PI_LUNA_EXTENSION_VERSION;
  readonly repository: string;
  readonly editAuthority: PiLunaEditAuthority;
  readonly toolOutputCapBytes: number;
  readonly fileReadCapBytes: number;
  readonly toolTimeoutMs: number;
  readonly osBoundary: PiLunaOsBoundary;
  readonly bwrapBin: string | null;
  readonly toolPath: string;
  readonly toolHome: string;
  readonly toolTmpdir: string;
  readonly verificationExecutableDirs: readonly string[];
  readonly verificationCommands: readonly PiLunaVerificationCommand[];
}

export const PI_LUNA_RESULT_LIMITS = {
  summaryChars: 4_000,
  listItems: 100,
  listItemChars: 500,
  pathChars: 400,
} as const;
