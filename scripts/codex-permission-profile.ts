import { createHash } from "node:crypto";

export const CODEX_PERMISSION_PROFILE_NAME = "sol-luna-worker";
export const CODEX_PERMISSION_PROFILE_VERSION = "sol-luna-permission-profile/1";

export type CodexProfileWorkspaceAccess = "read" | "write";

export interface CodexPermissionProfileInput {
  readonly repository: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly runtimeDir: string;
  readonly outputDir: string;
  readonly workspaceAccess: CodexProfileWorkspaceAccess;
}

export interface CompiledCodexPermissionProfile {
  readonly config: string;
  readonly fingerprint: string;
  readonly version: typeof CODEX_PERMISSION_PROFILE_VERSION;
  readonly networkEnabled: false;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function canonicalProfile(input: CodexPermissionProfileInput): string {
  return JSON.stringify({
    version: CODEX_PERMISSION_PROFILE_VERSION,
    repository: input.repository,
    gitDir: input.gitDir,
    commonGitDir: input.commonGitDir,
    runtimeDir: input.runtimeDir,
    outputDir: input.outputDir,
    workspaceAccess: input.workspaceAccess,
    networkEnabled: false,
  });
}

export function compileCodexPermissionProfile(
  input: CodexPermissionProfileInput,
): CompiledCodexPermissionProfile {
  const filesystemEntries = [
    `\":root\"=\"deny\"`,
    `\":minimal\"=\"read\"`,
    `\":workspace_roots\"={\".\"=\"${input.workspaceAccess}\",\".git\"=\"read\",\"**/*.env\"=\"deny\"}`,
    `${tomlString(input.gitDir)}=\"read\"`,
    `${tomlString(input.commonGitDir)}=\"read\"`,
    `${tomlString(input.runtimeDir)}=\"write\"`,
    `${tomlString(input.outputDir)}=\"deny\"`,
  ].join(",");
  const config = `{description=\"Stensibly disposable worker\",filesystem={${filesystemEntries}},network={enabled=false}}`;
  return {
    config,
    fingerprint: `sha256:${createHash("sha256").update(canonicalProfile(input)).digest("hex")}`,
    version: CODEX_PERMISSION_PROFILE_VERSION,
    networkEnabled: false,
  };
}

export function permissionProfileConfigArgs(profile: CompiledCodexPermissionProfile): string[] {
  return [
    "--ignore-user-config",
    "--strict-config",
    "--config",
    `default_permissions=${tomlString(CODEX_PERMISSION_PROFILE_NAME)}`,
    "--config",
    `permissions.${CODEX_PERMISSION_PROFILE_NAME}=${profile.config}`,
  ];
}

export function permissionProfileReceiptArgs(profile: CompiledCodexPermissionProfile): string[] {
  return [
    "--ignore-user-config",
    "--strict-config",
    "--config",
    `default_permissions=${tomlString(CODEX_PERMISSION_PROFILE_NAME)}`,
    "--config",
    `permissions.${CODEX_PERMISSION_PROFILE_NAME}=<redacted:${profile.version}:${profile.fingerprint}>`,
  ];
}

export function parseSupportedCodexCliVersion(output: string): string | null {
  const match = output.trim().match(/^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  if (major === 0 && minor < 138) return null;
  return `${major}.${minor}.${patch}`;
}
