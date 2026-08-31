import { createHash, randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import {
  PI_LUNA_EXTENSION_VERSION,
  PI_LUNA_MODEL,
  PI_LUNA_MODEL_REF,
  PI_LUNA_PACKAGE_NAME,
  PI_LUNA_PACKAGE_VERSION,
  PI_LUNA_PROVIDER,
  PI_LUNA_REASONING_EFFORT,
  PI_LUNA_RECEIPT_SCHEMA_VERSION,
  PI_LUNA_RESULT_LIMITS,
  PI_LUNA_TOOL_NAMES,
  type PiLunaEditAuthority,
  type PiLunaExtensionConfig,
  type PiLunaOsBoundary,
  type PiLunaResult,
  type PiLunaVerificationCommand,
} from "./pi-luna-worker-contract.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_BRIEF_BYTES = 16 * 1024 * 1024;
const MAX_ID_CHARS = 200;
const MAX_ERROR_CHARS = 500;
const MAX_GIT_FILE_FINGERPRINT_BYTES = 2 * 1024 * 1024;
const KILL_ESCALATION_GRACE_MS = 250;
const HARD_KILL_SETTLE_MS = 1_000;
const TMP_PREFIX = ".pi-luna-worker-tmp-";
const PI_LUNA_SESSION_DIR_NAME = ".pi-session";
const PI_LUNA_ATTEMPT_MARKER_NAME = ".pi-luna-attempt";
const SHELL_EXECUTABLES = new Set(["ash", "bash", "cmd", "fish", "pwsh", "sh", "zsh"]);

export const PI_LUNA_EXTENSION_PATH = resolve(import.meta.dir, "pi-luna-worker-extension.ts");
export const PI_LUNA_VERSION_ARGS = ["--version"] as const;
export const PI_LUNA_AUTH_CHECK_ARGS = [
  "auth",
  "check",
  "--provider",
  PI_LUNA_PROVIDER,
  "--json",
] as const;

export const PI_LUNA_ARTIFACT_NAMES = {
  stdout: "stdout.jsonl",
  stderr: "stderr.log",
  workerResult: "worker-result.json",
  receipt: "receipt.json",
} as const;

/** Names reserved by one attempt. Existing reserved names are never removed. */
export const PI_LUNA_MANAGED_ATTEMPT_ARTIFACT_NAMES = [
  PI_LUNA_ATTEMPT_MARKER_NAME,
  PI_LUNA_SESSION_DIR_NAME,
  PI_LUNA_ARTIFACT_NAMES.stdout,
  PI_LUNA_ARTIFACT_NAMES.stderr,
  PI_LUNA_ARTIFACT_NAMES.workerResult,
  PI_LUNA_ARTIFACT_NAMES.receipt,
] as const;

/** Environment copied from the coordinator only when the key is present. */
export const PI_LUNA_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  "XDG_CONFIG_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

const SAFE_SYSTEM_PATH = [...new Set([
  dirname(process.execPath),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
])].join(delimiter);

type JsonObject = Record<string, unknown>;
type ProcessEnvironment = Readonly<Record<string, string | undefined>>;
type UsageValue = number | Readonly<Record<string, number>>;

export type PiLunaProviderUsage = Readonly<Record<string, UsageValue>>;

export interface PiLunaWorkerOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly piAgentDir: string;
  readonly editAuthority: PiLunaEditAuthority;
  readonly osBoundary: PiLunaOsBoundary;
  readonly bwrapBin?: string;
  readonly verificationCommands: readonly PiLunaVerificationCommand[];
  readonly piBin?: string;
  readonly timeoutMs?: number;
  readonly captureCapBytes?: number;
  readonly verificationPath?: string;
  readonly verificationExecutableDirs?: readonly string[];
  readonly assignedRole?: string;
  /** Optional durable session directory; otherwise the session is attempt-local. */
  readonly sessionDir?: string;
  /** Optional UUID override; otherwise a deterministic UUID is derived from runId. */
  readonly sessionId?: string;
}

export interface PiLunaArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PiLunaStreamArtifact extends PiLunaArtifact {
  readonly truncated: boolean;
  readonly fullOutputBytes: number;
  readonly omittedBytes: number;
}

export type PiLunaChildOutcome =
  | "not_started"
  | "worker_succeeded"
  | "worker_failed"
  | "timeout"
  | "harness_failed";

export type PiLunaStdinOutcome =
  | "not_started"
  | "delivered_without_error"
  | "child_closed_stdin_early";

export interface PiLunaToolCounts {
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly byName: Readonly<Record<string, number>>;
  readonly unexpected: readonly string[];
}

export interface PiLunaParsedOutput {
  readonly events: readonly unknown[];
  readonly sessionId: string | null;
  readonly result: PiLunaResult | null;
  readonly usage: PiLunaProviderUsage | null;
  readonly toolCounts: PiLunaToolCounts;
}

export interface PiLunaWorkerReceipt {
  readonly schemaVersion: typeof PI_LUNA_RECEIPT_SCHEMA_VERSION;
  readonly run: {
    readonly id: string;
    readonly assignedRole: string;
  };
  readonly repository: string;
  readonly brief: string;
  readonly outputDir: string;
  readonly editAuthority: PiLunaEditAuthority;
  readonly verificationCommands: readonly PiLunaVerificationCommand[];
  readonly preflight: {
    readonly version: {
      readonly command: readonly string[];
      readonly exitCode: number | null;
      readonly version: string | null;
      readonly expectedVersion: typeof PI_LUNA_PACKAGE_VERSION;
      readonly timedOut: boolean;
      readonly ready: boolean;
    };
    readonly auth: {
      readonly command: readonly string[];
      readonly exitCode: number | null;
      readonly provider: typeof PI_LUNA_PROVIDER;
      readonly status: string | null;
      readonly authType: string | null;
      readonly timedOut: boolean;
      readonly ready: boolean;
    };
  };
  readonly pi: {
    readonly package: typeof PI_LUNA_PACKAGE_NAME;
    readonly expectedVersion: typeof PI_LUNA_PACKAGE_VERSION;
    readonly binary: string;
    readonly version: string | null;
    readonly agentDir: string;
    readonly provider: typeof PI_LUNA_PROVIDER;
    readonly model: typeof PI_LUNA_MODEL;
    readonly reasoningEffort: typeof PI_LUNA_REASONING_EFFORT;
    readonly session: {
      readonly directory: string;
      readonly requestedId: string;
      readonly observedId: string | null;
      readonly identityMatches: boolean;
    };
    readonly resume: {
      readonly command: readonly string[];
      readonly identity: {
        readonly directory: string;
        readonly sessionId: string;
      };
    };
  };
  readonly invocation: {
    readonly command: readonly string[];
    readonly args: readonly string[];
    readonly cwd: string;
    readonly stdin: "canonical-brief";
    readonly extension: string;
    readonly toolAllowlist: readonly string[];
    readonly boundary: {
      readonly mode: PiLunaOsBoundary;
      readonly bwrapBin: string | null;
      readonly readOnlyMounts: readonly string[];
    };
    readonly disabledDiscovery: readonly string[];
    readonly environment: {
      readonly inherit: "none";
      readonly allowlistedKeys: readonly string[];
      readonly injectedKeys: readonly string[];
      readonly path: string;
      readonly home: string;
      readonly tmpdir: string;
    };
    readonly timeoutMs: number;
    readonly captureCapBytes: number;
  };
  readonly child: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly outcome: PiLunaChildOutcome;
    readonly stdinOutcome: PiLunaStdinOutcome;
    readonly stdinDetail: string | null;
    readonly timeoutMs: number;
  };
  readonly usage: PiLunaProviderUsage | null;
  readonly toolCounts: PiLunaToolCounts;
  readonly result: PiLunaResult | null;
  /** Alias retained for consumers that call the structured result the worker result. */
  readonly workerResult: PiLunaResult | null;
  readonly git: {
    readonly headBefore: string | null;
    readonly headAfter: string | null;
    readonly headRelationship: "unknown" | "unchanged" | "descendant" | "non_descendant";
    readonly dirtyPathsBefore: readonly string[];
    readonly dirtyPathsAfter: readonly string[];
    readonly workerCreatedDirtyPaths: readonly string[];
    readonly commitsMade: readonly string[];
    readonly committedPaths: readonly string[];
    readonly changedPaths: readonly string[];
  };
  readonly artifacts: {
    readonly stdoutJsonl: PiLunaStreamArtifact | null;
    readonly stderr: PiLunaStreamArtifact | null;
    readonly finalWorkerResult: PiLunaArtifact | null;
  };
  readonly integration: {
    readonly workerSuccessIsProvisional: true;
    readonly status: "not_adjudicated";
    readonly gatesAdjudicated: false;
    readonly note: string;
  };
  readonly success: boolean;
  readonly harnessError: string | null;
}

export interface PiLunaWorkerRun {
  readonly receipt: PiLunaWorkerReceipt;
  readonly receiptPath: string;
  readonly exitCode: number;
}

interface NormalizedOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly piAgentDir: string;
  readonly editAuthority: PiLunaEditAuthority;
  readonly osBoundary: PiLunaOsBoundary;
  readonly bwrapBin: string | null;
  readonly verificationCommands: readonly PiLunaVerificationCommand[];
  readonly piBin: string;
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
  readonly verificationPath: string;
  readonly verificationExecutableDirs: readonly string[];
  readonly assignedRole: string;
  readonly sessionDir: string;
  readonly sessionDirExplicit: boolean;
  readonly sessionId: string;
}

interface BoundedAccumulator {
  push(chunk: Uint8Array): void;
  snapshot(): { readonly data: Buffer; readonly fullBytes: number; readonly omittedBytes: number };
}

interface ProcessCapture {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutFullBytes: number;
  readonly stderrFullBytes: number;
  readonly stdoutOmittedBytes: number;
  readonly stderrOmittedBytes: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError: string | null;
  readonly stdinOutcome: PiLunaStdinOutcome;
  readonly stdinDetail: string | null;
}

interface CaptureOptions {
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
}

interface GitSnapshot {
  readonly head: string | null;
  readonly paths: readonly string[];
  readonly pathStates: Readonly<Record<string, string>>;
}

interface GitAttribution {
  readonly headRelationship: PiLunaWorkerReceipt["git"]["headRelationship"];
  readonly commitsMade: readonly string[];
  readonly committedPaths: readonly string[];
  readonly error: string | null;
}

interface RuntimeDirectories {
  readonly root: string;
  readonly home: string;
  readonly tmpdir: string;
  readonly configPath: string;
}

function jsonObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, MAX_ERROR_CHARS);
}

function appendHarnessError(current: string | null, error: unknown): string {
  const next = errorMessage(error);
  return current === null ? next : `${current}; ${next}`.slice(0, MAX_ERROR_CHARS);
}

function requireText(value: unknown, label: string, maxLength = MAX_ID_CHARS): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function pathIsWithin(target: string, parent: string): boolean {
  const difference = relative(parent, target);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

async function canonicalizeProspectivePath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(target);
    if (parent === target) throw error;
    return join(await canonicalizeProspectivePath(parent), basename(target));
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function deterministicSessionId(runId: string): string {
  const hex = createHash("sha256").update("pi-luna-session\0").update(runId).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "8", 16) % 4] ?? "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function pathEntries(pathValue: string): readonly string[] {
  return pathValue.split(delimiter).filter((entry) => entry.length > 0);
}

function safePathFor(piBin: string, verificationPath: string | undefined): string {
  if (verificationPath !== undefined) return verificationPath;
  const entries = [...pathEntries(SAFE_SYSTEM_PATH)];
  if (piBin.includes("/")) entries.unshift(dirname(resolve(piBin)));
  return [...new Set(entries)].join(delimiter);
}

function deduplicatePaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const identity = resolve(path);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(path);
  }
  return result;
}

export function buildEffectiveReadOnlyMounts(
  osBoundary: PiLunaOsBoundary,
  declaredMounts: readonly string[],
  gitCommonDirectory: string | null,
): readonly string[] {
  if (osBoundary === "none") return [];
  return deduplicatePaths([
    ...declaredMounts,
    ...(gitCommonDirectory === null ? [] : [gitCommonDirectory]),
  ]);
}

function normalizeVerificationCommands(
  commands: readonly PiLunaVerificationCommand[],
): readonly PiLunaVerificationCommand[] {
  if (!Array.isArray(commands) || commands.length > 100) {
    throw new Error("verificationCommands must be an array of at most 100 commands");
  }
  const ids = new Set<string>();
  return commands.map((input: PiLunaVerificationCommand, index: number) => {
    const id = requireText(input?.id, `verificationCommands[${index}].id`, 64);
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(id)) throw new Error(`invalid verification command id: ${id}`);
    if (ids.has(id)) throw new Error(`duplicate verification command id: ${id}`);
    ids.add(id);
    if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.length > 64) {
      throw new Error(`verification command ${id} must have a bounded argv array`);
    }
    const argv = input.argv.map((arg: string, argIndex: number) => requireText(arg, `${id}.argv[${argIndex}]`, 4_096));
    if (SHELL_EXECUTABLES.has(basename(argv[0] ?? ""))) {
      throw new Error(`verification command ${id} may not invoke a shell executable`);
    }
    return { id, argv };
  });
}

function normalizeOptions(input: PiLunaWorkerOptions): NormalizedOptions {
  const repository = resolve(requireText(input.repository, "repository", 4_096));
  const brief = resolve(requireText(input.brief, "brief", 4_096));
  const outputDir = resolve(requireText(input.outputDir, "output directory", 4_096));
  const sessionDirExplicit = input.sessionDir !== undefined;
  const sessionDir = sessionDirExplicit
    ? resolve(requireText(input.sessionDir, "session directory", 4_096))
    : join(outputDir, PI_LUNA_SESSION_DIR_NAME);
  const runId = requireText(input.runId, "run ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) {
    throw new Error("run ID may contain only letters, digits, dot, underscore, and hyphen");
  }
  const piAgentDir = resolve(requireText(input.piAgentDir, "Pi agent directory", 4_096));
  const piBin = requireText(input.piBin ?? "pi", "Pi executable", 4_096);
  const editAuthority = input.editAuthority;
  if (editAuthority !== "read-only" && editAuthority !== "workspace-write") {
    throw new Error("edit authority must be read-only or workspace-write");
  }
  const osBoundary = input.osBoundary;
  if (osBoundary !== "bwrap" && osBoundary !== "none") {
    throw new Error("OS boundary must be bwrap or none");
  }
  const bwrapBin = input.bwrapBin === undefined
    ? null
    : resolve(requireText(input.bwrapBin, "bubblewrap executable", 4_096));
  if (osBoundary === "bwrap" && bwrapBin === null) {
    throw new Error("bwrap OS boundary requires a bubblewrap executable");
  }
  if (osBoundary === "none" && bwrapBin !== null) {
    throw new Error("bubblewrap executable requires bwrap OS boundary");
  }
  const timeoutMs = requirePositiveInteger(input.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS);
  const captureCapBytes = requirePositiveInteger(input.captureCapBytes, "captureCapBytes", DEFAULT_CAPTURE_CAP_BYTES);
  if (captureCapBytes > 64 * 1024 * 1024) throw new Error("captureCapBytes is too large");
  const verificationPath = safePathFor(piBin, input.verificationPath);
  const verificationPathEntries = pathEntries(verificationPath);
  for (const entry of verificationPathEntries) {
    if (!isAbsolute(entry)) throw new Error("verificationPath entries must be absolute");
  }
  const explicitReadOnlyMounts = (input.verificationExecutableDirs ?? []).map((entry, index) => {
      const directory = requireText(entry, `verificationExecutableDirs[${index}]`, 4_096);
      if (!isAbsolute(directory)) throw new Error("verification executable directories must be absolute");
      return directory;
    });
  const verificationExecutableDirs = deduplicatePaths([
    ...verificationPathEntries,
    ...explicitReadOnlyMounts,
  ]);
  const suppliedSessionId = input.sessionId;
  if (suppliedSessionId !== undefined && (!requireText(suppliedSessionId, "session ID", 80) || !isUuid(suppliedSessionId))) {
    throw new Error("session ID must be a UUID");
  }
  return {
    repository,
    brief,
    outputDir,
    runId,
    piAgentDir,
    editAuthority,
    osBoundary,
    bwrapBin,
    verificationCommands: normalizeVerificationCommands(input.verificationCommands),
    piBin,
    timeoutMs,
    captureCapBytes,
    verificationPath,
    verificationExecutableDirs,
    assignedRole: requireText(input.assignedRole ?? "pi-luna-worker", "assigned role", 200),
    sessionDir,
    sessionDirExplicit,
    sessionId: suppliedSessionId ?? deterministicSessionId(runId),
  };
}

export function piEnvironment(
  source: ProcessEnvironment = process.env,
  overrides: {
    readonly path?: string;
    readonly home?: string;
    readonly tmpdir?: string;
    readonly piAgentDir?: string;
    readonly extensionConfigPath?: string;
  } = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of PI_LUNA_ENVIRONMENT_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = overrides.path ?? environment.PATH ?? SAFE_SYSTEM_PATH;
  if (overrides.home !== undefined) environment.HOME = overrides.home;
  if (overrides.tmpdir !== undefined) environment.TMPDIR = overrides.tmpdir;
  environment.LANG = environment.LANG ?? "C";
  environment.LC_ALL = environment.LC_ALL ?? "C";
  if (overrides.piAgentDir !== undefined) environment.PI_CODING_AGENT_DIR = overrides.piAgentDir;
  if (overrides.extensionConfigPath !== undefined) environment.PI_LUNA_CONFIG_PATH = overrides.extensionConfigPath;
  return environment;
}

function gitEnvironment(runtime: RuntimeDirectories, toolPath: string): Record<string, string> {
  return {
    PATH: toolPath,
    HOME: runtime.home,
    TMPDIR: runtime.tmpdir,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export function buildPiWorkerArgs(
  sessionDir: string,
  sessionId: string,
  extensionPath = PI_LUNA_EXTENSION_PATH,
): readonly string[] {
  return [
    "--mode",
    "json",
    "--model",
    PI_LUNA_MODEL_REF,
    "--thinking",
    PI_LUNA_REASONING_EFFORT,
    "--no-builtin-tools",
    "--tools",
    PI_LUNA_TOOL_NAMES.join(","),
    "--no-extensions",
    "--extension",
    extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--session-dir",
    sessionDir,
    "--session-id",
    sessionId,
  ];
}

export function buildPiWorkerCommand(
  piBin: string,
  sessionDir: string,
  sessionId: string,
  extensionPath = PI_LUNA_EXTENSION_PATH,
): readonly string[] {
  return [piBin, ...buildPiWorkerArgs(sessionDir, sessionId, extensionPath)];
}

export function buildPiResumeCommand(piBin: string, sessionDir: string, sessionId: string): readonly string[] {
  return [piBin, "--session-dir", sessionDir, "--session", sessionId];
}

function createBoundedAccumulator(cap: number): BoundedAccumulator {
  const headCap = Math.ceil(cap / 2);
  const tailCap = Math.floor(cap / 2);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let fullBytes = 0;
  return {
    push(chunk: Uint8Array): void {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      fullBytes += bytes.byteLength;
      let offset = 0;
      if (head.length < headCap) {
        const take = Math.min(headCap - head.length, bytes.length);
        head = Buffer.concat([head, bytes.subarray(0, take)]);
        offset = take;
      }
      if (tailCap === 0) return;
      const remainder = bytes.subarray(offset);
      if (remainder.length >= tailCap) {
        tail = Buffer.from(remainder.subarray(remainder.length - tailCap));
      } else if (remainder.length > 0) {
        const combined = Buffer.concat([tail, remainder]);
        tail = combined.length <= tailCap
          ? combined
          : Buffer.from(combined.subarray(combined.length - tailCap));
      }
    },
    snapshot(): { readonly data: Buffer; readonly fullBytes: number; readonly omittedBytes: number } {
      const data = Buffer.concat([head, tail]);
      return { data, fullBytes, omittedBytes: Math.max(0, fullBytes - data.length) };
    },
  };
}

function signalProcessTree(pid: number, child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process tree is already gone.
    }
  }
}

function stdinDelivery(
  stdin: Writable,
  payload: Uint8Array,
): { readonly done: Promise<void>; readonly state: () => { outcome: PiLunaStdinOutcome; detail: string | null } } {
  let settled = false;
  let outcome: PiLunaStdinOutcome = "delivered_without_error";
  let detail: string | null = null;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolveDoneValue) => {
    resolveDone = resolveDoneValue;
  });
  const settle = (nextOutcome: PiLunaStdinOutcome, nextDetail: string | null): void => {
    if (settled) return;
    settled = true;
    outcome = nextOutcome;
    detail = nextDetail;
    resolveDone?.();
  };
  stdin.on("error", (error: unknown) => {
    settle("child_closed_stdin_early", errorMessage(error));
  });
  stdin.on("close", () => {
    if (!settled) settle("delivered_without_error", null);
  });
  if (stdin.destroyed || stdin.closed || !stdin.writable) {
    settle("child_closed_stdin_early", "stdin was already closed");
    return { done, state: () => ({ outcome, detail }) };
  }
  let offset = 0;
  const writeMore = (): void => {
    if (settled) return;
    try {
      while (offset < payload.length) {
        const end = Math.min(offset + 64 * 1024, payload.length);
        const accepted = stdin.write(payload.subarray(offset, end));
        offset = end;
        if (!accepted) {
          stdin.once("drain", writeMore);
          return;
        }
      }
      stdin.end();
    } catch (error) {
      settle("child_closed_stdin_early", errorMessage(error));
    }
  };
  writeMore();
  return { done, state: () => ({ outcome, detail }) };
}

function captureProcess(command: readonly string[], options: CaptureOptions): Promise<ProcessCapture> {
  return new Promise<ProcessCapture>((resolveCapture) => {
    if (command.length === 0) {
      resolveCapture({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutFullBytes: 0,
        stderrFullBytes: 0,
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: "empty command",
        stdinOutcome: "not_started",
        stdinDetail: null,
      });
      return;
    }
    if (options.signal?.aborted) {
      resolveCapture({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutFullBytes: 0,
        stderrFullBytes: 0,
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: true,
        spawnError: null,
        stdinOutcome: "not_started",
        stdinDetail: null,
      });
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command[0] ?? "", [...command.slice(1)], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolveCapture({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        stdoutFullBytes: 0,
        stderrFullBytes: 0,
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        spawnError: errorMessage(error),
        stdinOutcome: options.stdin === undefined ? "not_started" : "child_closed_stdin_early",
        stdinDetail: options.stdin === undefined ? null : errorMessage(error),
      });
      return;
    }

    const stdoutAccumulator = createBoundedAccumulator(options.captureCapBytes);
    const stderrAccumulator = createBoundedAccumulator(options.captureCapBytes);
    let exited = false;
    let forcedSettle = false;
    let exitCode: number | null = null;
    let termSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let aborted = false;
    let streamsOpen = 2;
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: () => void;
    const stdinState = options.stdin === undefined
      ? (() => {
          child.stdin.end();
          return { done: Promise.resolve(), state: () => ({ outcome: "not_started" as const, detail: null }) };
        })()
      : stdinDelivery(child.stdin, options.stdin);

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      if (hardKillTimer !== undefined) clearTimeout(hardKillTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    };
    const finish = (): void => {
      if (settled || (!exited && !forcedSettle) || streamsOpen > 0) return;
      settled = true;
      clearTimers();
      const stdout = stdoutAccumulator.snapshot();
      const stderr = stderrAccumulator.snapshot();
      const stdin = stdinState.state();
      resolveCapture({
        stdout: stdout.data,
        stderr: stderr.data,
        stdoutFullBytes: stdout.fullBytes,
        stderrFullBytes: stderr.fullBytes,
        stdoutOmittedBytes: stdout.omittedBytes,
        stderrOmittedBytes: stderr.omittedBytes,
        exitCode,
        signal: termSignal,
        timedOut,
        aborted,
        spawnError: null,
        stdinOutcome: stdin.outcome,
        stdinDetail: stdin.detail,
      });
    };
    abortHandler = (): void => {
      aborted = true;
      if (child.pid !== undefined) signalProcessTree(child.pid, child, "SIGTERM");
    };
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) signalProcessTree(child.pid, child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (child.pid !== undefined) signalProcessTree(child.pid, child, "SIGKILL");
        hardKillTimer = setTimeout(() => {
          forcedSettle = true;
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
          finish();
        }, HARD_KILL_SETTLE_MS);
      }, KILL_ESCALATION_GRACE_MS);
    }, options.timeoutMs);
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const stdout = stdoutAccumulator.snapshot();
      const stderr = stderrAccumulator.snapshot();
      if (options.stdin !== undefined) child.stdin.destroy();
      resolveCapture({
        stdout: stdout.data,
        stderr: stderr.data,
        stdoutFullBytes: stdout.fullBytes,
        stderrFullBytes: stderr.fullBytes,
        stdoutOmittedBytes: stdout.omittedBytes,
        stderrOmittedBytes: stderr.omittedBytes,
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        spawnError: errorMessage(error),
        stdinOutcome: options.stdin === undefined ? "not_started" : "child_closed_stdin_early",
        stdinDetail: options.stdin === undefined ? null : errorMessage(error),
      });
    });
    child.stdout.on("data", (chunk: Buffer) => stdoutAccumulator.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrAccumulator.push(chunk));
    child.stdout.on("close", () => {
      streamsOpen -= 1;
      finish();
    });
    child.stderr.on("close", () => {
      streamsOpen -= 1;
      finish();
    });
    child.on("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      termSignal = signal;
      if (options.stdin !== undefined && !child.stdin.destroyed) child.stdin.destroy();
      finish();
    });
  });
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else {
      const object = jsonObject(item);
      if (typeof object?.text === "string") parts.push(object.text);
      else if (typeof object?.content === "string") parts.push(object.content);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}

export function parsePiJsonLines(stdout: string): readonly unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Bounded head/tail retention and Pi diagnostics may leave non-JSON lines.
    }
  }
  if (events.length === 0 && stdout.trim().length > 0) {
    try {
      events.push(JSON.parse(stdout.trim()) as unknown);
    } catch {
      // The raw stdout artifact remains the evidence of malformed output.
    }
  }
  return events;
}

function numericUsage(value: unknown): PiLunaProviderUsage | null {
  const object = jsonObject(value);
  if (object === null) return null;
  const usage: Record<string, UsageValue> = {};
  for (const [key, candidate] of Object.entries(object)) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      usage[key] = candidate;
      continue;
    }
    const nested = numericUsage(candidate);
    if (nested !== null) {
      const flattened: Record<string, number> = {};
      for (const [nestedKey, nestedValue] of Object.entries(nested)) {
        if (typeof nestedValue === "number") flattened[nestedKey] = nestedValue;
      }
      if (Object.keys(flattened).length > 0) usage[key] = flattened;
    }
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

function addUsage(left: PiLunaProviderUsage | null, right: PiLunaProviderUsage): PiLunaProviderUsage {
  const result: Record<string, UsageValue> = {};
  for (const [key, value] of Object.entries(left ?? {})) result[key] = value;
  for (const [key, value] of Object.entries(right)) {
    const previous = result[key];
    if (typeof value === "number" && typeof previous === "number") result[key] = previous + value;
    else if (typeof value === "number") result[key] = value + (typeof previous === "number" ? previous : 0);
    else {
      const nested: Record<string, number> = {};
      if (typeof previous === "object") Object.assign(nested, previous);
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        nested[nestedKey] = (nested[nestedKey] ?? 0) + nestedValue;
      }
      result[key] = nested;
    }
  }
  return result;
}

function isAssistantMessage(message: JsonObject | null): boolean {
  return message?.role === undefined || message.role === "assistant";
}

function messageUsage(event: JsonObject): PiLunaProviderUsage | null {
  const message = jsonObject(event.message);
  if (message !== null && isAssistantMessage(message)) return numericUsage(message.usage);
  if (event.type === "message_end" && message === null) return numericUsage(event.usage);
  if (event.type === "message" || event.type === "message_update") return numericUsage(event.usage);
  return null;
}

function sessionIdFromEvent(event: JsonObject): string | null {
  if (event.type === "session" || event.type === "session_start" || event.type === "session_header") {
    for (const key of ["id", "sessionId", "session_id"]) {
      if (typeof event[key] === "string" && event[key].length > 0) return event[key] as string;
    }
  }
  for (const key of ["sessionId", "session_id"]) {
    if (typeof event[key] === "string" && event[key].length > 0) return event[key] as string;
  }
  return null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let candidate = value.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1] !== undefined) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return value;
  }
}

function boundedStringArray(value: unknown, label: string, maxItems: number, maxChars: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maxChars || item.includes("\0")) return null;
    result.push(item);
  }
  return result;
}

function parseStructuredResult(value: unknown): PiLunaResult | null {
  const parsed = parseJsonValue(value);
  const object = jsonObject(parsed);
  if (object === null) return null;
  const status = object.status;
  const summary = object.summary;
  const changedPaths = object.changedPaths ?? object.changed_paths;
  const verification = object.verification;
  const remainingLimits = object.remainingLimits ?? object.remaining_limits;
  if (status !== "complete" && status !== "partial" && status !== "blocked") return null;
  if (typeof summary !== "string" || summary.length === 0 || summary.length > PI_LUNA_RESULT_LIMITS.summaryChars) return null;
  const paths = boundedStringArray(changedPaths, "changedPaths", PI_LUNA_RESULT_LIMITS.listItems, PI_LUNA_RESULT_LIMITS.pathChars);
  const checks = boundedStringArray(verification, "verification", PI_LUNA_RESULT_LIMITS.listItems, PI_LUNA_RESULT_LIMITS.listItemChars);
  const limits = boundedStringArray(remainingLimits, "remainingLimits", PI_LUNA_RESULT_LIMITS.listItems, PI_LUNA_RESULT_LIMITS.listItemChars);
  if (paths === null || checks === null || limits === null) return null;
  return {
    status,
    summary,
    changedPaths: paths,
    verification: checks,
    remainingLimits: limits,
  };
}

function resultCandidates(event: JsonObject): readonly unknown[] {
  const candidates: unknown[] = [];
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  if (event.type === "tool_execution_end" && toolName === "luna_result") {
    const toolResult = jsonObject(event.result);
    candidates.push(toolResult?.details, toolResult?.result, event.result, event.details);
  }
  if (event.type === "message_end") {
    const message = jsonObject(event.message);
    if (message?.role === "toolResult" || message?.toolName === "luna_result") {
      candidates.push(message.details, message.result, message.content, textFromContent(message.content));
    }
    if (message?.role === "assistant") candidates.push(message.content, message.text);
  }
  if (event.type === "agent_end" && Array.isArray(event.messages)) {
    for (const message of [...event.messages].reverse()) {
      const object = jsonObject(message);
      if (object !== null) candidates.push(...resultCandidates({ type: "message_end", message: object }));
    }
  }
  if (event.type === "result" || event.type === "worker_result") {
    candidates.push(event.result, event.workerResult, event);
  }
  for (const key of ["final_response", "finalResponse", "output_text", "response"]) {
    if (event[key] !== undefined) candidates.push(event[key]);
  }
  return candidates.filter((candidate) => candidate !== undefined && candidate !== null);
}

function emptyToolCounts(): PiLunaToolCounts {
  return { started: 0, completed: 0, failed: 0, byName: {}, unexpected: [] };
}

export function parsePiOutput(stdout: string): PiLunaParsedOutput {
  const events = parsePiJsonLines(stdout);
  let sessionId: string | null = null;
  let result: PiLunaResult | null = null;
  let usage: PiLunaProviderUsage | null = null;
  let authoritativeUsageSeen = false;
  let latestUpdateUsage: PiLunaProviderUsage | null = null;
  let started = 0;
  let completed = 0;
  let failed = 0;
  const byName: Record<string, number> = {};
  const completedOnly: Record<string, number> = {};
  const unexpected = new Set<string>();
  for (const rawEvent of events) {
    const event = jsonObject(rawEvent);
    if (event === null) continue;
    sessionId ??= sessionIdFromEvent(event);
    if (result === null) {
      for (const candidate of resultCandidates(event)) {
        const parsedResult = parseStructuredResult(candidate);
        if (parsedResult !== null) {
          result = parsedResult;
          break;
        }
      }
    }
    const eventUsage = messageUsage(event);
    if (event.type === "message_end" && eventUsage !== null) {
      authoritativeUsageSeen = true;
      usage = addUsage(usage, eventUsage);
    } else if (event.type === "message_update" && eventUsage !== null) {
      latestUpdateUsage = eventUsage;
    } else if (event.type === "message" && eventUsage !== null) {
      usage = addUsage(usage, eventUsage);
      authoritativeUsageSeen = true;
    }
    const toolName = typeof event.toolName === "string" ? event.toolName : null;
    if (toolName !== null && !PI_LUNA_TOOL_NAMES.includes(toolName as typeof PI_LUNA_TOOL_NAMES[number])) {
      unexpected.add(toolName);
    }
    if (event.type === "tool_execution_start" && toolName !== null) {
      started += 1;
      byName[toolName] = (byName[toolName] ?? 0) + 1;
    }
    if (event.type === "tool_execution_end" && toolName !== null) {
      completed += 1;
      completedOnly[toolName] = (completedOnly[toolName] ?? 0) + 1;
      if (event.isError === true || jsonObject(event.result)?.isError === true) failed += 1;
    }
  }
  if (!authoritativeUsageSeen && latestUpdateUsage !== null) usage = latestUpdateUsage;
  for (const [toolName, count] of Object.entries(completedOnly)) {
    byName[toolName] = Math.max(byName[toolName] ?? 0, count);
  }
  const toolCounts: PiLunaToolCounts = {
    started,
    completed,
    failed,
    byName,
    unexpected: [...unexpected].sort(),
  };
  return { events, sessionId, result, usage, toolCounts };
}

export const parsePiJsonOutput = parsePiOutput;

function parsePiVersion(stdout: string): string | null {
  const match = stdout.match(/\b(\d+\.\d+\.\d+)\b/u);
  return match?.[1] ?? null;
}

function parseAuthResult(stdout: string): {
  readonly status: string | null;
  readonly provider: string | null;
  readonly authType: string | null;
  readonly ready: boolean;
} {
  for (const rawEvent of parsePiJsonLines(stdout)) {
    const event = jsonObject(rawEvent);
    if (event === null) continue;
    const status = typeof event.status === "string" ? event.status : null;
    const provider = typeof event.provider === "string" ? event.provider : null;
    const authType = typeof event.authType === "string"
      ? event.authType
      : typeof event.auth_type === "string"
        ? event.auth_type
        : null;
    if (status !== null || provider !== null || authType !== null) {
      return {
        status,
        provider,
        authType,
        ready: status === "ready" && provider === PI_LUNA_PROVIDER && authType === "oauth",
      };
    }
  }
  return { status: null, provider: null, authType: null, ready: false };
}

function parseStatusPaths(statusBytes: Uint8Array): string[] {
  const paths = new Set<string>();
  const entries = new TextDecoder().decode(statusBytes).split("\0").filter((entry) => entry.length > 0);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length > 0) paths.add(path);
    if ((status.includes("R") || status.includes("C")) && entries[index + 1] !== undefined) {
      paths.add(entries[index + 1] as string);
      index += 1;
    }
  }
  return [...paths].sort();
}

async function gitCapture(
  repository: string,
  args: readonly string[],
  runtime: RuntimeDirectories,
  options: NormalizedOptions,
): Promise<ProcessCapture> {
  return captureProcess(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd: repository,
    env: gitEnvironment(runtime, options.verificationPath),
    timeoutMs: options.timeoutMs,
    captureCapBytes: options.captureCapBytes,
  });
}

async function gitOutput(
  repository: string,
  args: readonly string[],
  runtime: RuntimeDirectories,
  options: NormalizedOptions,
): Promise<Buffer> {
  const capture = await gitCapture(repository, args, runtime, options);
  if (capture.spawnError !== null) throw new Error(`Git failed to start: ${capture.spawnError}`);
  if (capture.timedOut) throw new Error(`Git timed out after ${options.timeoutMs}ms`);
  if (capture.exitCode !== 0) throw new Error(`Git exited ${capture.exitCode ?? "unknown"}`);
  if (capture.stdoutOmittedBytes > 0 || capture.stderrOmittedBytes > 0) {
    throw new Error("Git observation exceeded the capture cap");
  }
  return capture.stdout;
}

async function resolveGitCommonDirectory(
  repository: string,
  runtime: RuntimeDirectories,
  options: NormalizedOptions,
): Promise<string> {
  try {
    const output = (await gitOutput(repository, ["rev-parse", "--git-common-dir"], runtime, options)).toString("utf8").trim();
    if (
      output.length === 0
      || output.length > 4_096
      || output.includes("\0")
      || output.includes("\n")
      || output.includes("\r")
    ) {
      throw new Error("Git returned an invalid common directory");
    }
    const commonDirectory = await realpath(resolve(repository, output));
    const information = await lstat(commonDirectory);
    if (!information.isDirectory()) throw new Error("Git common directory is not a directory");
    return commonDirectory;
  } catch (error) {
    throw new Error(`Git common directory resolution failed: ${errorMessage(error)}`);
  }
}

async function worktreePathState(repository: string, path: string): Promise<string> {
  const target = resolve(repository, path);
  if (!pathIsWithin(target, repository)) return "outside-repository";
  try {
    const information = await lstat(target);
    if (information.isSymbolicLink()) return `symlink:${await readlink(target)}`;
    if (information.isDirectory()) return `directory:${information.mtimeMs}`;
    if (!information.isFile()) return `other:${information.size}:${information.mtimeMs}`;
    if (information.size > MAX_GIT_FILE_FINGERPRINT_BYTES) {
      return `file:${information.size}:${information.mtimeMs}`;
    }
    const bytes = await readFile(target);
    return `file:${information.size}:${information.mtimeMs}:${sha256(bytes)}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function gitSnapshot(
  repository: string,
  runtime: RuntimeDirectories,
  options: NormalizedOptions,
): Promise<GitSnapshot> {
  const headCapture = await gitCapture(repository, ["rev-parse", "HEAD"], runtime, options);
  let head: string | null = null;
  if (headCapture.spawnError !== null) throw new Error(`Git failed to start: ${headCapture.spawnError}`);
  if (headCapture.timedOut) throw new Error(`Git timed out after ${options.timeoutMs}ms`);
  if (headCapture.exitCode === 0) head = new TextDecoder().decode(headCapture.stdout).trim() || null;
  else if (headCapture.exitCode !== 128) throw new Error(`Git HEAD probe exited ${headCapture.exitCode ?? "unknown"}`);
  const statusBytes = await gitOutput(repository, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], runtime, options);
  const paths = parseStatusPaths(statusBytes);
  const pathStates = await Promise.all(paths.map(async (path) => {
    const staged = head === null
      ? Buffer.alloc(0)
      : await gitOutput(repository, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--cached", head, "--", path], runtime, options);
    const unstaged = await gitOutput(repository, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--", path], runtime, options);
    const worktree = await worktreePathState(repository, path);
    const state = createHash("sha256")
      .update("staged\0").update(staged)
      .update("unstaged\0").update(unstaged)
      .update("worktree\0").update(worktree)
      .digest("hex");
    return [path, `sha256:${state}`] as const;
  }));
  return { head, paths, pathStates: Object.fromEntries(pathStates) };
}

async function committedAttribution(
  repository: string,
  headBefore: string | null,
  headAfter: string | null,
  runtime: RuntimeDirectories,
  options: NormalizedOptions,
): Promise<GitAttribution> {
  if (headBefore === null || headAfter === null) {
    return { headRelationship: "unknown", commitsMade: [], committedPaths: [], error: null };
  }
  if (headBefore === headAfter) {
    return { headRelationship: "unchanged", commitsMade: [], committedPaths: [], error: null };
  }
  const ancestry = await gitCapture(repository, ["merge-base", "--is-ancestor", headBefore, headAfter], runtime, options);
  if (ancestry.spawnError !== null || ancestry.timedOut) {
    return {
      headRelationship: "unknown",
      commitsMade: [],
      committedPaths: [],
      error: ancestry.timedOut ? "Git ancestry probe timed out" : `Git ancestry probe failed: ${ancestry.spawnError}`,
    };
  }
  if (ancestry.exitCode !== 0) {
    return {
      headRelationship: ancestry.exitCode === 1 ? "non_descendant" : "unknown",
      commitsMade: [],
      committedPaths: [],
      error: ancestry.exitCode === 1 ? "final Git head is not a descendant of the baseline head" : "unable to establish Git head ancestry",
    };
  }
  const commitsBytes = await gitOutput(repository, ["rev-list", "--reverse", `${headBefore}..${headAfter}`], runtime, options);
  const commitsMade = new TextDecoder().decode(commitsBytes).split(/\r?\n/u).map((commit) => commit.trim()).filter((commit) => commit.length > 0);
  const committedPaths = new Set<string>();
  for (const commit of commitsMade) {
    const paths = await gitOutput(repository, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", `${commit}^`, commit, "--"], runtime, options);
    for (const path of new TextDecoder().decode(paths).split("\0").filter((entry) => entry.length > 0)) committedPaths.add(path);
  }
  return { headRelationship: "descendant", commitsMade, committedPaths: [...committedPaths].sort(), error: null };
}

async function createRuntime(options: NormalizedOptions): Promise<RuntimeDirectories> {
  const root = await mkdtemp(join(tmpdir(), "pi-luna-worker-"));
  const home = join(root, "home");
  const runtimeTmpdir = join(root, "tmp");
  const configPath = join(root, "extension-config.json");
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(runtimeTmpdir, { mode: 0o700 });
    return { root, home, tmpdir: runtimeTmpdir, configPath };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function writeExtensionConfig(
  runtime: RuntimeDirectories,
  repository: string,
  options: NormalizedOptions,
  readOnlyMounts: readonly string[],
): Promise<void> {
  const config: PiLunaExtensionConfig = {
    schemaVersion: PI_LUNA_EXTENSION_VERSION,
    repository,
    editAuthority: options.editAuthority,
    toolOutputCapBytes: options.captureCapBytes,
    fileReadCapBytes: 256 * 1024,
    toolTimeoutMs: Math.min(options.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS),
    osBoundary: options.osBoundary,
    bwrapBin: options.bwrapBin,
    toolPath: options.verificationPath,
    toolHome: runtime.home,
    toolTmpdir: runtime.tmpdir,
    verificationExecutableDirs: readOnlyMounts,
    verificationCommands: options.verificationCommands,
  };
  await writeFile(runtime.configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function publishAtomically(targetPath: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = join(
    dirname(targetPath),
    `${TMP_PREFIX}${createHash("sha256").update(targetPath).digest("hex").slice(0, 12)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    // A hard link is an atomic no-replace publication on the same filesystem.
    // Unlike rename(), it cannot silently replace a prior receipt.
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function claimOutputDirectory(outputDir: string, runId: string, repository: string): Promise<string> {
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const information = await lstat(outputDir);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("output directory must be a real directory");
  const entries = await readdir(outputDir);
  const managed = new Set<string>(PI_LUNA_MANAGED_ATTEMPT_ARTIFACT_NAMES);
  const conflicts = entries.filter((entry) => managed.has(entry) || entry.startsWith(TMP_PREFIX));
  if (conflicts.length > 0) {
    throw new Error(`output directory already contains managed attempt artifact(s): ${conflicts.sort().join(", ")}`);
  }
  const markerPath = join(outputDir, PI_LUNA_ATTEMPT_MARKER_NAME);
  await publishAtomically(markerPath, new TextEncoder().encode(`${JSON.stringify({ runId, repository })}\n`));
  return markerPath;
}

function streamArtifact(path: string, capture: ProcessCapture | null, kind: "stdout" | "stderr"): PiLunaStreamArtifact {
  const bytes = kind === "stdout" ? capture?.stdout ?? Buffer.alloc(0) : capture?.stderr ?? Buffer.alloc(0);
  const fullOutputBytes = kind === "stdout" ? capture?.stdoutFullBytes ?? 0 : capture?.stderrFullBytes ?? 0;
  const omittedBytes = kind === "stdout" ? capture?.stdoutOmittedBytes ?? 0 : capture?.stderrOmittedBytes ?? 0;
  return {
    path,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    truncated: omittedBytes > 0,
    fullOutputBytes,
    omittedBytes,
  };
}

function artifact(path: string, bytes: Uint8Array): PiLunaArtifact {
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function rejectSymlinkComponents(pathValue: string): Promise<void> {
  const target = resolve(pathValue);
  let current = target;
  while (true) {
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink()) {
        throw new Error(current === target
          ? "session directory must not be a symlink"
          : "session directory path must not contain symlink components");
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertSessionDirectory(pathValue: string): Promise<boolean> {
  try {
    const information = await lstat(pathValue);
    if (information.isSymbolicLink()) throw new Error("session directory must not be a symlink");
    if (!information.isDirectory()) throw new Error("session directory must be a real directory");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureSessionDirectory(pathValue: string, explicit: boolean): Promise<void> {
  if (explicit) await rejectSymlinkComponents(pathValue);
  if (await assertSessionDirectory(pathValue)) return;
  await mkdir(pathValue, { recursive: true, mode: 0o700 });
  if (explicit) await rejectSymlinkComponents(pathValue);
  if (!(await assertSessionDirectory(pathValue))) throw new Error("session directory was not created");
}

async function validatePaths(
  repository: string,
  outputDir: string,
  sessionDir: string,
  explicitSessionDir: boolean,
): Promise<void> {
  const repositoryRoot = await realpath(repository);
  const repositoryInformation = await lstat(repositoryRoot);
  if (!repositoryInformation.isDirectory()) throw new Error("configured repository is not a directory");
  const outputCanonical = await canonicalizeProspectivePath(outputDir);
  if (pathIsWithin(outputCanonical, repositoryRoot) || pathIsWithin(repositoryRoot, outputCanonical)) {
    throw new Error("output directory must not overlap the repository");
  }
  if (explicitSessionDir) await rejectSymlinkComponents(sessionDir);
  await assertSessionDirectory(sessionDir);
  const sessionCanonical = await canonicalizeProspectivePath(sessionDir);
  if (explicitSessionDir && (pathIsWithin(sessionCanonical, outputCanonical) || pathIsWithin(outputCanonical, sessionCanonical))) {
    throw new Error("explicit session directory must not overlap attempt output");
  }
  if (pathIsWithin(sessionCanonical, repositoryRoot) || pathIsWithin(repositoryRoot, sessionCanonical)) {
    throw new Error("session directory must not overlap the repository");
  }
}

function compareDirtyStates(before: GitSnapshot | null, after: GitSnapshot | null): readonly string[] {
  if (before === null || after === null) return [];
  const paths = new Set([...before.paths, ...after.paths]);
  return [...paths].filter((path) => before.pathStates[path] !== after.pathStates[path]).sort();
}

function commandOutcome(
  capture: ProcessCapture | null,
  harnessError: string | null,
  result: PiLunaResult | null,
): PiLunaChildOutcome {
  if (capture === null) return "not_started";
  if (capture.timedOut) return "timeout";
  if (capture.spawnError !== null) return "harness_failed";
  if (capture.exitCode !== 0) return "worker_failed";
  if (harnessError !== null || result === null) return "harness_failed";
  return "worker_succeeded";
}

function emptyCapture(): ProcessCapture {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutFullBytes: 0,
    stderrFullBytes: 0,
    stdoutOmittedBytes: 0,
    stderrOmittedBytes: 0,
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: null,
    stdinOutcome: "not_started",
    stdinDetail: null,
  };
}

export async function runPiLunaWorker(input: PiLunaWorkerOptions): Promise<PiLunaWorkerRun> {
  const options = normalizeOptions(input);
  await validatePaths(options.repository, options.outputDir, options.sessionDir, options.sessionDirExplicit);
  const repository = await realpath(options.repository);
  const briefBytes = await readFile(options.brief);
  if (briefBytes.byteLength === 0) throw new Error("brief is empty");
  if (briefBytes.byteLength > MAX_BRIEF_BYTES) throw new Error("brief exceeds the input cap");

  const markerPath = await claimOutputDirectory(options.outputDir, options.runId, repository);
  void markerPath;
  const sessionDir = options.sessionDir;
  const sessionId = options.sessionId;
  const workerArgs = buildPiWorkerArgs(sessionDir, sessionId);
  const workerCommand = [options.piBin, ...workerArgs];
  const resumeCommand = buildPiResumeCommand(options.piBin, sessionDir, sessionId);
  const stdoutPath = join(options.outputDir, PI_LUNA_ARTIFACT_NAMES.stdout);
  const stderrPath = join(options.outputDir, PI_LUNA_ARTIFACT_NAMES.stderr);
  const workerResultPath = join(options.outputDir, PI_LUNA_ARTIFACT_NAMES.workerResult);
  const receiptPath = join(options.outputDir, PI_LUNA_ARTIFACT_NAMES.receipt);

  let harnessError: string | null = null;
  let runtime: RuntimeDirectories | null = null;
  let gitCommonDirectory: string | null = null;
  let effectiveReadOnlyMounts = buildEffectiveReadOnlyMounts(options.osBoundary, options.verificationExecutableDirs, null);
  let beforeSnapshot: GitSnapshot | null = null;
  let afterSnapshot: GitSnapshot | null = null;
  let workerCapture: ProcessCapture | null = null;
  let parsedOutput: PiLunaParsedOutput = {
    events: [],
    sessionId: null,
    result: null,
    usage: null,
    toolCounts: emptyToolCounts(),
  };
  let versionCapture: ProcessCapture | null = null;
  let authCapture: ProcessCapture | null = null;
  let piVersion: string | null = null;
  let authStatus: string | null = null;
  let authType: string | null = null;
  let authReady = false;

  try {
    runtime = await createRuntime(options);
    gitCommonDirectory = await resolveGitCommonDirectory(repository, runtime, options);
    effectiveReadOnlyMounts = buildEffectiveReadOnlyMounts(options.osBoundary, options.verificationExecutableDirs, gitCommonDirectory);
    beforeSnapshot = await gitSnapshot(repository, runtime, options);
    versionCapture = await captureProcess([options.piBin, ...PI_LUNA_VERSION_ARGS], {
      cwd: repository,
      env: piEnvironment(process.env, { path: options.verificationPath, home: runtime.home, tmpdir: runtime.tmpdir, piAgentDir: options.piAgentDir }),
      timeoutMs: options.timeoutMs,
      captureCapBytes: options.captureCapBytes,
    });
    piVersion = versionCapture.spawnError === null ? parsePiVersion(new TextDecoder().decode(versionCapture.stdout)) : null;
    const versionReady = versionCapture.spawnError === null
      && !versionCapture.timedOut
      && versionCapture.exitCode === 0
      && piVersion === PI_LUNA_PACKAGE_VERSION;
    if (!versionReady) {
      harnessError = appendHarnessError(harnessError, `Pi version preflight did not report ${PI_LUNA_PACKAGE_VERSION}`);
    }

    if (harnessError === null) {
      authCapture = await captureProcess([options.piBin, ...PI_LUNA_AUTH_CHECK_ARGS], {
        cwd: repository,
        env: piEnvironment(process.env, { path: options.verificationPath, home: runtime.home, tmpdir: runtime.tmpdir, piAgentDir: options.piAgentDir }),
        timeoutMs: options.timeoutMs,
        captureCapBytes: options.captureCapBytes,
      });
      const auth = authCapture.spawnError === null ? parseAuthResult(new TextDecoder().decode(authCapture.stdout)) : {
        status: null,
        provider: null,
        authType: null,
        ready: false,
      };
      authStatus = auth.status;
      authType = auth.authType;
      authReady = authCapture.spawnError === null
        && !authCapture.timedOut
        && authCapture.exitCode === 0
        && auth.provider === PI_LUNA_PROVIDER
        && auth.ready;
      if (!authReady) harnessError = appendHarnessError(harnessError, "Pi auth check did not report ready/oauth");
    }

    if (harnessError === null && runtime !== null) {
      await ensureSessionDirectory(sessionDir, options.sessionDirExplicit);
      await writeExtensionConfig(runtime, repository, options, effectiveReadOnlyMounts);
      workerCapture = await captureProcess(workerCommand, {
        cwd: repository,
        env: piEnvironment(process.env, {
          path: options.verificationPath,
          home: runtime.home,
          tmpdir: runtime.tmpdir,
          piAgentDir: options.piAgentDir,
          extensionConfigPath: runtime.configPath,
        }),
        timeoutMs: options.timeoutMs,
        captureCapBytes: options.captureCapBytes,
        stdin: briefBytes,
      });
      if (workerCapture.spawnError === null) parsedOutput = parsePiOutput(new TextDecoder().decode(workerCapture.stdout));
      if (workerCapture.spawnError !== null) harnessError = appendHarnessError(harnessError, `Pi worker failed to start: ${workerCapture.spawnError}`);
      if (workerCapture.exitCode === 0 && !workerCapture.timedOut && parsedOutput.result === null) {
        harnessError = appendHarnessError(harnessError, "Pi exited successfully without luna_result");
      }
      if (parsedOutput.toolCounts.unexpected.length > 0) {
        harnessError = appendHarnessError(harnessError, `Pi emitted unreviewed tool(s): ${parsedOutput.toolCounts.unexpected.join(", ")}`);
      }
      if (workerCapture.exitCode === 0 && !workerCapture.timedOut && parsedOutput.sessionId !== sessionId) {
        harnessError = appendHarnessError(harnessError, "Pi session identity did not match the requested session ID");
      }
    }
  } catch (error) {
    harnessError = appendHarnessError(harnessError, error);
  } finally {
    if (runtime !== null) {
      try {
        await rm(runtime.root, { recursive: true, force: true });
      } catch (error) {
        harnessError = appendHarnessError(harnessError, `unable to clean Pi runtime: ${errorMessage(error)}`);
      }
    }
  }

  try {
    if (runtime !== null) {
      // runtime cleanup happens above; this branch exists only to keep the final
      // Git observation independent from Pi's temporary directory lifecycle.
      void runtime;
    }
    // Git observations use a fresh bounded runtime when the first one was not
    // initialized. It is never pointed at the Pi agent directory.
    const gitRuntime = await createRuntime(options);
    try {
      afterSnapshot = await gitSnapshot(repository, gitRuntime, options);
    } finally {
      await rm(gitRuntime.root, { recursive: true, force: true }).catch((error) => {
        harnessError = appendHarnessError(harnessError, `unable to clean Git observation runtime: ${errorMessage(error)}`);
      });
    }
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read final Git state: ${errorMessage(error)}`);
  }

  const headBefore = beforeSnapshot?.head ?? null;
  const headAfter = afterSnapshot?.head ?? null;
  let headRelationship: PiLunaWorkerReceipt["git"]["headRelationship"] = "unknown";
  let commitsMade: readonly string[] = [];
  let committedPaths: readonly string[] = [];
  try {
    const attributionRuntime = await createRuntime(options);
    try {
      const attribution = await committedAttribution(repository, headBefore, headAfter, attributionRuntime, options);
      headRelationship = attribution.headRelationship;
      commitsMade = attribution.commitsMade;
      committedPaths = attribution.committedPaths;
      if (attribution.error !== null) harnessError = appendHarnessError(harnessError, attribution.error);
    } finally {
      await rm(attributionRuntime.root, { recursive: true, force: true }).catch((error) => {
        harnessError = appendHarnessError(harnessError, `unable to clean Git attribution runtime: ${errorMessage(error)}`);
      });
    }
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read committed Git changes: ${errorMessage(error)}`);
  }

  const workerCreatedDirtyPaths = compareDirtyStates(beforeSnapshot, afterSnapshot);
  const changedPaths = [...new Set([...committedPaths, ...workerCreatedDirtyPaths])].sort();
  let stdoutArtifact: PiLunaStreamArtifact | null = null;
  let stderrArtifact: PiLunaStreamArtifact | null = null;
  let resultArtifact: PiLunaArtifact | null = null;
  const captured = workerCapture ?? emptyCapture();
  try {
    await publishAtomically(stdoutPath, captured.stdout);
    stdoutArtifact = streamArtifact(stdoutPath, workerCapture, "stdout");
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to publish stdout artifact: ${errorMessage(error)}`);
  }
  try {
    await publishAtomically(stderrPath, captured.stderr);
    stderrArtifact = streamArtifact(stderrPath, workerCapture, "stderr");
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to publish stderr artifact: ${errorMessage(error)}`);
  }
  let resultBytes: Uint8Array | null = null;
  if (parsedOutput.result !== null) {
    resultBytes = new TextEncoder().encode(`${JSON.stringify(parsedOutput.result, null, 2)}\n`);
    try {
      await publishAtomically(workerResultPath, resultBytes);
      resultArtifact = artifact(workerResultPath, resultBytes);
    } catch (error) {
      harnessError = appendHarnessError(harnessError, `unable to publish worker result: ${errorMessage(error)}`);
    }
  }

  const versionReady = versionCapture !== null
    && versionCapture.spawnError === null
    && !versionCapture.timedOut
    && versionCapture.exitCode === 0
    && piVersion === PI_LUNA_PACKAGE_VERSION;
  const childFinalOutcome = commandOutcome(workerCapture, harnessError, parsedOutput.result);
  const sessionIdentityMatches = parsedOutput.sessionId === sessionId;
  const success = childFinalOutcome === "worker_succeeded"
    && harnessError === null
    && versionReady
    && authReady
    && sessionIdentityMatches
    && parsedOutput.result?.status === "complete";
  const receipt: PiLunaWorkerReceipt = {
    schemaVersion: PI_LUNA_RECEIPT_SCHEMA_VERSION,
    run: { id: options.runId, assignedRole: options.assignedRole },
    repository,
    brief: options.brief,
    outputDir: options.outputDir,
    editAuthority: options.editAuthority,
    verificationCommands: options.verificationCommands,
    preflight: {
      version: {
        command: [options.piBin, ...PI_LUNA_VERSION_ARGS],
        exitCode: versionCapture?.exitCode ?? null,
        version: piVersion,
        expectedVersion: PI_LUNA_PACKAGE_VERSION,
        timedOut: versionCapture?.timedOut ?? false,
        ready: versionReady,
      },
      auth: {
        command: [options.piBin, ...PI_LUNA_AUTH_CHECK_ARGS],
        exitCode: authCapture?.exitCode ?? null,
        provider: PI_LUNA_PROVIDER,
        status: authStatus,
        authType,
        timedOut: authCapture?.timedOut ?? false,
        ready: authReady,
      },
    },
    pi: {
      package: PI_LUNA_PACKAGE_NAME,
      expectedVersion: PI_LUNA_PACKAGE_VERSION,
      binary: options.piBin,
      version: piVersion,
      agentDir: options.piAgentDir,
      provider: PI_LUNA_PROVIDER,
      model: PI_LUNA_MODEL,
      reasoningEffort: PI_LUNA_REASONING_EFFORT,
      session: {
        directory: sessionDir,
        requestedId: sessionId,
        observedId: parsedOutput.sessionId,
        identityMatches: sessionIdentityMatches,
      },
      resume: {
        command: resumeCommand,
        identity: { directory: sessionDir, sessionId },
      },
    },
    invocation: {
      command: workerCommand,
      args: workerArgs,
      cwd: repository,
      stdin: "canonical-brief",
      extension: PI_LUNA_EXTENSION_PATH,
      toolAllowlist: [...PI_LUNA_TOOL_NAMES],
      boundary: {
        mode: options.osBoundary,
        bwrapBin: options.bwrapBin,
        readOnlyMounts: effectiveReadOnlyMounts,
      },
      disabledDiscovery: ["extensions", "skills", "prompt-templates", "themes", "context-files"],
      environment: {
        inherit: "none",
        allowlistedKeys: [...PI_LUNA_ENVIRONMENT_ALLOWLIST],
        injectedKeys: ["PI_CODING_AGENT_DIR", "PI_LUNA_CONFIG_PATH"],
        path: options.verificationPath,
        home: runtime?.home ?? "<not-created>",
        tmpdir: runtime?.tmpdir ?? "<not-created>",
      },
      timeoutMs: options.timeoutMs,
      captureCapBytes: options.captureCapBytes,
    },
    child: {
      exitCode: workerCapture?.exitCode ?? null,
      signal: workerCapture?.signal ?? null,
      timedOut: workerCapture?.timedOut ?? false,
      outcome: childFinalOutcome,
      stdinOutcome: workerCapture?.stdinOutcome ?? "not_started",
      stdinDetail: workerCapture?.stdinDetail ?? null,
      timeoutMs: options.timeoutMs,
    },
    usage: parsedOutput.usage,
    toolCounts: parsedOutput.toolCounts,
    result: parsedOutput.result,
    workerResult: parsedOutput.result,
    git: {
      headBefore,
      headAfter,
      headRelationship,
      dirtyPathsBefore: beforeSnapshot?.paths ?? [],
      dirtyPathsAfter: afterSnapshot?.paths ?? [],
      workerCreatedDirtyPaths,
      commitsMade,
      committedPaths,
      changedPaths,
    },
    artifacts: {
      stdoutJsonl: stdoutArtifact,
      stderr: stderrArtifact,
      finalWorkerResult: resultArtifact,
    },
    integration: {
      workerSuccessIsProvisional: true,
      status: "not_adjudicated",
      gatesAdjudicated: false,
      note: "Pi worker success is provisional; coordinator integration and fixed verification gates remain to be adjudicated.",
    },
    success,
    harnessError,
  };

  try {
    await publishAtomically(receiptPath, new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`));
  } catch (error) {
    throw new Error(`unable to publish receipt at ${receiptPath}: ${errorMessage(error)}`);
  }
  return {
    receipt,
    receiptPath,
    exitCode: success
      ? 0
      : childFinalOutcome === "timeout"
        ? 124
        : childFinalOutcome === "worker_failed" && harnessError === null
          ? workerCapture?.exitCode ?? 1
          : 1,
  };
}

function parsePositiveIntegerCli(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseVerificationCommand(value: string): PiLunaVerificationCommand {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new Error("--verification-command expects ID=JSON_ARRAY");
  const id = value.slice(0, separator);
  let argv: unknown;
  try {
    argv = JSON.parse(value.slice(separator + 1)) as unknown;
  } catch {
    throw new Error(`--verification-command ${id} has invalid JSON argv`);
  }
  if (!Array.isArray(argv)) throw new Error(`--verification-command ${id} must contain a JSON array`);
  return { id, argv: argv.map((arg) => requireText(arg, `${id} argv item`, 4_096)) };
}

function usage(): string {
  return [
    "Usage: bun scripts/pi-luna-worker.ts --repository PATH --brief FILE --output-dir DIR --run-id ID",
    "  --pi-bin PATH --pi-agent-dir DIR --timeout-ms MS --capture-cap-bytes BYTES",
    "  --edit-authority read-only|workspace-write --os-boundary bwrap|none",
    "  [--bwrap-bin PATH] [--read-only-mount DIR]...",
    "  [--verification-command ID=JSON_ARRAY]... [--verification-path PATH]",
    "  [--assigned-role ROLE] [--session-dir DIR] [--session-id UUID]",
  ].join("\n");
}

function parseCli(argv: readonly string[]): PiLunaWorkerOptions {
  const values = new Map<string, string>();
  const verificationCommands: PiLunaVerificationCommand[] = [];
  const readOnlyMounts: string[] = [];
  const aliases: Record<string, string> = {
    "pi-binary": "pi-bin",
    "agent-dir": "pi-agent-dir",
    "verify-command": "verification-command",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const rawKey = argv[index];
    if (rawKey === "--help") throw new Error(usage());
    if (rawKey === undefined || !rawKey.startsWith("--")) throw new Error(`invalid argument ${rawKey ?? "missing"}`);
    const key = aliases[rawKey.slice(2)] ?? rawKey.slice(2);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for --${key}`);
    if (key === "verification-command") {
      verificationCommands.push(parseVerificationCommand(value));
      index += 1;
      continue;
    }
    if (key === "read-only-mount") {
      readOnlyMounts.push(value);
      index += 1;
      continue;
    }
    if (values.has(key)) throw new Error(`duplicate argument --${key}`);
    values.set(key, value);
    index += 1;
  }
  const required = ["repository", "brief", "output-dir", "run-id", "pi-bin", "pi-agent-dir", "timeout-ms", "capture-cap-bytes", "edit-authority", "os-boundary"];
  for (const key of required) if (!values.has(key)) throw new Error(`missing required argument --${key}`);
  const known = new Set([...required, "bwrap-bin", "verification-path", "assigned-role", "session-dir", "session-id"]);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`unknown argument --${key}`);
  const editAuthority = values.get("edit-authority");
  if (editAuthority !== "read-only" && editAuthority !== "workspace-write") {
    throw new Error("--edit-authority must be read-only or workspace-write");
  }
  const sessionId = values.get("session-id");
  const osBoundary = values.get("os-boundary");
  if (osBoundary !== "bwrap" && osBoundary !== "none") {
    throw new Error("--os-boundary must be bwrap or none");
  }
  const bwrapBin = values.get("bwrap-bin");
  if (osBoundary === "bwrap" && bwrapBin === undefined) {
    throw new Error("--bwrap-bin is required with --os-boundary bwrap");
  }
  if (osBoundary === "none" && bwrapBin !== undefined) {
    throw new Error("--bwrap-bin requires --os-boundary bwrap");
  }
  return {
    repository: values.get("repository") as string,
    brief: values.get("brief") as string,
    outputDir: values.get("output-dir") as string,
    runId: values.get("run-id") as string,
    piAgentDir: values.get("pi-agent-dir") as string,
    piBin: values.get("pi-bin") as string,
    timeoutMs: parsePositiveIntegerCli(values.get("timeout-ms") as string, "--timeout-ms"),
    captureCapBytes: parsePositiveIntegerCli(values.get("capture-cap-bytes") as string, "--capture-cap-bytes"),
    editAuthority,
    osBoundary,
    ...(bwrapBin === undefined ? {} : { bwrapBin }),
    verificationCommands,
    verificationExecutableDirs: readOnlyMounts,
    ...(values.get("verification-path") === undefined ? {} : { verificationPath: values.get("verification-path") }),
    ...(values.get("assigned-role") === undefined ? {} : { assignedRole: values.get("assigned-role") }),
    ...(values.get("session-dir") === undefined ? {} : { sessionDir: values.get("session-dir") }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

export async function runPiLunaCli(argv: readonly string[]): Promise<number> {
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      console.log(usage());
      return 0;
    }
    return (await runPiLunaWorker(parseCli(argv))).exitCode;
  } catch (error) {
    console.error(errorMessage(error));
    return error instanceof Error && error.message === usage() ? 0 : 2;
  }
}

if (import.meta.main) process.exitCode = await runPiLunaCli(process.argv.slice(2));
