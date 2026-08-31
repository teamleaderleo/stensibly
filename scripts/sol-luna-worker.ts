import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import {
  CODEX_PERMISSION_PROFILE_VERSION,
  compileCodexPermissionProfile,
  parseSupportedCodexCliVersion,
  permissionProfileConfigArgs,
  permissionProfileReceiptArgs,
  type CompiledCodexPermissionProfile,
} from "./codex-permission-profile.js";
import {
  compileCodexPromptSurfaceProfile,
  isCodexPromptSurfaceProfileName,
  type CodexPromptSurfaceProfileName,
} from "./codex-prompt-surface-profile.js";

const CODEX_COMMAND = "codex";
const CODEX_MODEL = "gpt-5.6-luna";
const CHATGPT_LOGIN_STATUS = "Logged in using ChatGPT";
const RECEIPT_SCHEMA_VERSION = "sol-luna-worker-receipt/3" as const;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const KILL_ESCALATION_GRACE_MS = 750;
const STDIN_CHUNK_BYTES = 64 * 1024;
const TMP_PREFIX = ".sol-luna-worker-tmp-";
const ARTIFACT_NAMES = {
  stdout: "stdout.jsonl",
  stderr: "stderr.log",
  workerResult: "worker-result.json",
  receipt: "receipt.json",
} as const;

export type SolLunaSandbox = "read-only" | "workspace-write";
export type SolLunaConfinement = "permission-profile" | "legacy-sandbox";
export type SolLunaEditAuthority = "read-only" | "workspace-write";
export type SolLunaGitMetadataAuthority = "none" | "write";
export type SolLunaReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_SOL_LUNA_REASONING_EFFORT: SolLunaReasoningEffort = "max";
export const CODEX_ENVIRONMENT_ALLOWLIST = [
  "PATH", "TMPDIR", "HOME", "CODEX_HOME", "XDG_CONFIG_HOME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;

export const SAFE_WORKER_PATH = [...new Set([
  dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
])].join(delimiter);

export interface SolLunaWorkerOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputSchema: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly assignedRole: string;
  readonly sandbox?: SolLunaSandbox;
  readonly confinement?: SolLunaConfinement;
  readonly editAuthority?: SolLunaEditAuthority;
  readonly gitMetadataAuthority?: SolLunaGitMetadataAuthority;
  readonly reasoningEffort?: SolLunaReasoningEffort;
  /** Explicit model-visible catalogue/affordance profile. Never inferred from brief text. */
  readonly promptSurfaceProfile?: CodexPromptSurfaceProfileName;
  /** Executable names the brief promises the worker may invoke. */
  readonly requiredCommands?: readonly string[];
  readonly codexBin?: string;
  /** Wall-clock bound applied to each spawned Codex invocation. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /** Per-stream ceiling on retained child stdout/stderr bytes. Defaults to 8 MiB. */
  readonly captureCapBytes?: number;
  /**
   * Wall-clock bound applied to each spawned Git observation (snapshots,
   * metadata probes, diffs, ancestry). Defaults to two minutes.
   */
  readonly gitTimeoutMs?: number;
}

export interface SolLunaArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SolLunaStreamArtifact extends SolLunaArtifact {
  readonly truncated: boolean;
  readonly fullOutputBytes: number;
  readonly omittedBytes: number;
}

export type SolLunaChildOutcome =
  | "not_started"
  | "worker_succeeded"
  | "worker_failed"
  | "timeout"
  | "harness_failed";

export type SolLunaStdinDelivery =
  | "delivered_without_error"
  | "child_closed_stdin_early";

export type SolLunaStdinOutcome = SolLunaStdinDelivery | "not_started";

export interface SolLunaWorkerReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly run: {
    readonly id: string;
    readonly assignedRole: string;
  };
  readonly repository: string;
  readonly sandbox: SolLunaSandbox;
  readonly confinement: {
    readonly mode: SolLunaConfinement;
    readonly clientVersion: string | null;
    readonly permissionProfileSupported: boolean;
    readonly profileVersion: typeof CODEX_PERMISSION_PROFILE_VERSION | null;
    readonly profileFingerprint: string | null;
    readonly networkEnabled: false | null;
  };
  readonly preflight: {
    readonly command: readonly ["codex", "login", "status"];
    readonly exitCode: number | null;
    readonly chatGptAuthenticated: boolean;
    readonly editAuthority: EditAuthorityPreflight;
    readonly gitMetadataAuthority: GitMetadataAuthorityPreflight;
    readonly requiredCommands: readonly RequiredCommandPreflight[];
  };
  readonly git: {
    readonly headBefore: string | null;
    readonly headAfter: string | null;
    readonly headRelationship: "unknown" | "unchanged" | "descendant" | "non_descendant";
    readonly dirtyPathsBefore: readonly string[];
    readonly dirtyPathsAfter: readonly string[];
    readonly workerCreatedDirtyPaths: readonly string[];
    readonly commitsMade: readonly string[];
    readonly committedPaths: readonly string[];
    /** Committed paths whose pre-run dirty bytes make content provenance uncertain. */
    readonly baselineContaminatedCommittedPaths: readonly string[];
    /**
     * Observed path activity: descendant-commit paths plus dirty paths whose
     * content/state changed during the run. This records activity, not
     * exclusive authorship of bytes.
     */
    readonly changedPaths: readonly string[];
  };
  readonly child: {
    readonly commandShape: {
      readonly executable: "codex";
      readonly confinement: SolLunaConfinement;
      readonly profileFingerprint: string | null;
      readonly args: readonly string[];
      readonly stdin: "canonical-brief";
      readonly reasoningEffort: SolLunaReasoningEffort;
      readonly promptSurface: {
        readonly profile: CodexPromptSurfaceProfileName;
        readonly contextRetirements: readonly string[];
        readonly capabilityRetirements: readonly string[];
      };
      readonly wallClockTimeoutMs: number;
      readonly shellEnvironment: {
        readonly inherit: "none";
        readonly path: string;
        readonly home: string;
        readonly tmpdir: string;
      };
    };
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly outcome: SolLunaChildOutcome;
    readonly stdinOutcome: SolLunaStdinOutcome;
    readonly stdinDetail: string | null;
    readonly wallClockTimeoutMs: number;
  };
  readonly codex: {
    readonly sessionOrThreadId: string | null;
    readonly threadId: string | null;
    readonly tokenUsage: Readonly<Record<string, number>> | null;
  };
  readonly artifacts: {
    readonly stdoutJsonl: SolLunaStreamArtifact | null;
    readonly stderr: SolLunaStreamArtifact | null;
    readonly finalWorkerResult: SolLunaArtifact | null;
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

export interface SolLunaWorkerRun {
  readonly receipt: SolLunaWorkerReceipt;
  readonly receiptPath: string;
  readonly exitCode: number;
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
  readonly spawnError: string | null;
  readonly stdinDelivery: SolLunaStdinDelivery;
  readonly stdinDetail: string | null;
}

interface GitSnapshot {
  readonly head: string;
  readonly paths: readonly string[];
  readonly pathStates: Readonly<Record<string, string>>;
}

interface GitMetadataLocation {
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly headPath: string;
  readonly indexPath: string;
  readonly probeDirectory: string;
}

interface WorkerShellEnvironment {
  readonly root: string;
  readonly home: string;
  readonly tmpdir: string;
}

type AuthorityProbeStatus = "not_required" | "not_run" | "passed" | "failed";

interface EditAuthorityPreflight {
  readonly declared: SolLunaEditAuthority;
  readonly status: AuthorityProbeStatus;
  readonly probePath: string | null;
  readonly error: string | null;
}

interface GitMetadataAuthorityPreflight {
  readonly declared: SolLunaGitMetadataAuthority;
  readonly status: AuthorityProbeStatus;
  readonly gitDir: string | null;
  readonly headPath: string | null;
  readonly indexPath: string | null;
  readonly probeDirectory: string | null;
  readonly probePath: string | null;
  readonly error: string | null;
}

export interface RequiredCommandPreflight {
  readonly command: string;
  readonly status: "not_run" | "available" | "missing";
  readonly resolvedPath: string | null;
}

interface GitAttribution {
  readonly headRelationship: "unknown" | "unchanged" | "descendant" | "non_descendant";
  readonly commitsMade: readonly string[];
  readonly committedPaths: readonly string[];
  readonly error: string | null;
}

type JsonObject = Record<string, unknown>;
type CodexEnvironmentKey = typeof CODEX_ENVIRONMENT_ALLOWLIST[number];
type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

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

async function permissionProfileOutputError(outputDir: string, repository: string): Promise<string | null> {
  const [canonicalOutput, canonicalRepository, ...canonicalTempRoots] = await Promise.all([
    canonicalizeProspectivePath(outputDir),
    realpath(repository),
    ...[resolve(tmpdir()), "/tmp", "/private/tmp"].map(canonicalizeProspectivePath),
  ]);
  if (pathIsWithin(canonicalOutput, canonicalRepository) || pathIsWithin(canonicalRepository, canonicalOutput)) {
    return "permission-profile output directory must not overlap the repository";
  }
  if (canonicalTempRoots.some((root) => pathIsWithin(canonicalOutput, root))) {
    return "permission-profile output directory must not be under system temp";
  }
  return null;
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: number | undefined, label: string, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return resolved;
}

function isReasoningEffort(value: string): value is SolLunaReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isEditAuthority(value: string): value is SolLunaEditAuthority {
  return value === "read-only" || value === "workspace-write";
}

function isGitMetadataAuthority(value: string): value is SolLunaGitMetadataAuthority {
  return value === "none" || value === "write";
}

function isConfinement(value: string): value is SolLunaConfinement {
  return value === "permission-profile" || value === "legacy-sandbox";
}

function normalizeRequiredCommands(commands: readonly string[] | undefined): readonly string[] {
  const normalized = commands ?? [];
  for (const command of normalized) {
    if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(command)) {
      throw new Error(`required command must be an executable name without a path: ${command}`);
    }
  }
  return [...new Set(normalized)].sort();
}

function normalizeOptions(input: SolLunaWorkerOptions): Required<SolLunaWorkerOptions> {
  const sandbox = input.sandbox ?? "read-only";
  const confinement = input.confinement ?? "permission-profile";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error("sandbox must be read-only or workspace-write");
  }
  if (!isConfinement(confinement)) throw new Error("confinement must be permission-profile or legacy-sandbox");
  const editAuthority = input.editAuthority ?? sandbox;
  if (!isEditAuthority(editAuthority)) throw new Error("edit authority must be read-only or workspace-write");
  if (editAuthority === "workspace-write" && sandbox !== "workspace-write") {
    throw new Error("workspace-write edit authority requires a workspace-write sandbox");
  }
  const gitMetadataAuthority = input.gitMetadataAuthority ?? "none";
  if (!isGitMetadataAuthority(gitMetadataAuthority)) throw new Error("Git metadata authority must be none or write");
  if (confinement === "permission-profile" && editAuthority === "workspace-write") {
    throw new Error("permission-profile confinement supports patch-as-data, not direct workspace writes");
  }
  if (gitMetadataAuthority === "write") {
    throw new Error(`${confinement} confinement does not grant Git metadata write`);
  }
  const reasoningEffort = input.reasoningEffort ?? DEFAULT_SOL_LUNA_REASONING_EFFORT;
  if (!isReasoningEffort(reasoningEffort)) throw new Error("reasoning effort must be low, medium, high, xhigh, or max");
  const promptSurfaceProfile = input.promptSurfaceProfile ?? "full";
  if (!isCodexPromptSurfaceProfileName(promptSurfaceProfile)) {
    throw new Error("prompt surface profile must be full, skills-catalogue-muted, or closed-task");
  }
  return {
    repository: resolve(requireText(input.repository, "repository")),
    brief: resolve(requireText(input.brief, "brief")),
    outputSchema: resolve(requireText(input.outputSchema, "output schema")),
    outputDir: resolve(requireText(input.outputDir, "output directory")),
    runId: requireText(input.runId, "run ID"),
    assignedRole: requireText(input.assignedRole, "assigned role"),
    sandbox,
    confinement,
    editAuthority,
    gitMetadataAuthority,
    reasoningEffort,
    promptSurfaceProfile,
    requiredCommands: normalizeRequiredCommands(input.requiredCommands),
    codexBin: requireText(input.codexBin ?? CODEX_COMMAND, "Codex executable"),
    timeoutMs: requirePositiveInteger(input.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS),
    captureCapBytes: requirePositiveInteger(
      input.captureCapBytes,
      "captureCapBytes",
      DEFAULT_CAPTURE_CAP_BYTES,
    ),
    gitTimeoutMs: requirePositiveInteger(input.gitTimeoutMs, "gitTimeoutMs", DEFAULT_GIT_TIMEOUT_MS),
  };
}

export function codexEnvironment(source: ProcessEnvironment = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of CODEX_ENVIRONMENT_ALLOWLIST) {
    const value = source[key as CodexEnvironmentKey];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export async function preflightRequiredCommands(
  commands: readonly string[],
  workerPath = SAFE_WORKER_PATH,
): Promise<readonly RequiredCommandPreflight[]> {
  const directories = workerPath.split(delimiter).filter((entry) => entry.length > 0);
  return await Promise.all(commands.map(async (command) => {
    for (const directory of directories) {
      const candidate = join(directory, command);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, fsConstants.X_OK);
        return { command, status: "available" as const, resolvedPath: candidate };
      } catch {
        // Try the next explicit PATH entry. A missing capability is recorded
        // below rather than inferred from the coordinator's broader PATH.
      }
    }
    return { command, status: "missing" as const, resolvedPath: null };
  }));
}

/**
 * Retains at most `cap` bytes per stream as a deterministic head window plus a
 * deterministic tail window, each snapped to complete-line boundaries where
 * possible. Full byte counts are tracked without retaining the omitted middle,
 * so coordinator memory stays bounded for hostile children.
 */
function boundedAccumulator(cap: number) {
  const half = Math.floor(cap / 2);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let fullBytes = 0;
  return {
    push(chunk: Uint8Array): void {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      fullBytes += buffer.length;
      let offset = 0;
      if (head.length < half) {
        const take = Math.min(half - head.length, buffer.length);
        head = Buffer.concat([head, buffer.subarray(0, take)]);
        offset = take;
      }
      const remainder = buffer.subarray(offset);
      if (remainder.length >= half) {
        tail = Buffer.from(remainder.subarray(remainder.length - half));
      } else if (remainder.length > 0) {
        const combined = Buffer.concat([tail, remainder]);
        tail = combined.length <= half ? combined : Buffer.from(combined.subarray(combined.length - half));
      }
    },
    snapshot(): { data: Buffer; fullOutputBytes: number; omittedBytes: number } {
      const rawHead = head;
      let headEnd = rawHead.length;
      for (let index = rawHead.length - 1; index >= 0; index -= 1) {
        if (rawHead[index] === 0x0a) {
          headEnd = index + 1;
          break;
        }
      }
      const keptHead = rawHead.subarray(0, headEnd);
      const rawTail = tail;
      let tailStart = Math.max(0, rawTail.length - half);
      while (tailStart < rawTail.length && rawTail[tailStart] !== 0x0a) tailStart += 1;
      if (tailStart < rawTail.length) tailStart += 1;
      const keptTail = rawTail.subarray(tailStart);
      const data = Buffer.concat([keptHead, keptTail]);
      return { data, fullOutputBytes: fullBytes, omittedBytes: Math.max(0, fullBytes - data.length) };
    },
  };
}

/**
 * Delivers the whole payload to the child stdin with backpressure awareness.
 * The delivery result is observed, never thrown: a child that closes its stdin
 * early produces a benign receipt note instead of an unhandled EPIPE rejection.
 */
function deliverStdin(
  stdin: Writable,
  payload: Uint8Array,
  isAborted: () => boolean,
): Promise<{ delivery: SolLunaStdinDelivery; detail: string | null }> {
  return new Promise((resolveDelivery) => {
    let settled = false;
    let failed = false;
    let detail: string | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolveDelivery({
        delivery: failed ? "child_closed_stdin_early" : "delivered_without_error",
        detail: failed ? detail : null,
      });
    };
    const fail = (error: Error & { code?: string }): void => {
      failed = true;
      detail = error.code ?? errorMessage(error);
    };
    const failAndSettle = (error: Error & { code?: string }): void => {
      fail(error);
      settle();
    };
    stdin.on("error", failAndSettle);
    stdin.on("close", settle);
    if (stdin.destroyed || stdin.closed || !stdin.writable) {
      failAndSettle(Object.assign(new Error("child stdin was already closed"), { code: "STDIN_CLOSED" }));
      return;
    }
    let offset = 0;
    const writeMore = (): void => {
      try {
        while (offset < payload.length && !isAborted()) {
          const end = Math.min(offset + STDIN_CHUNK_BYTES, payload.length);
          const accepted = stdin.write(payload.subarray(offset, end));
          offset = end;
          if (!accepted) {
            stdin.once("drain", writeMore);
            return;
          }
        }
        if (isAborted()) return;
        stdin.end();
      } catch (error) {
        failAndSettle(error instanceof Error ? error : new Error(String(error)));
      }
    };
    writeMore();
  });
}

/** Signals the whole spawned process group, falling back to the direct child only. */
function signalProcessTree(pid: number, child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process tree is already gone; nothing left to signal.
    }
  }
}

const SHEBANG_PEEK_BYTES = 256;

/**
 * Reads the shebang line of an executable without loading the whole file.
 * Returns null for binaries, unreadable paths, and scripts without a shebang.
 */
async function peekShebang(executablePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(executablePath, "r");
    const buffer = Buffer.alloc(SHEBANG_PEEK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SHEBANG_PEEK_BYTES, 0);
    if (bytesRead < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) return null;
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    return buffer.subarray(2, newline === -1 ? bytesRead : newline).toString("utf8");
  } catch {
    // Let the spawn attempt itself produce the honest failure for missing files.
    return null;
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
  }
}

/**
 * Expands a `#!` script entrypoint into its interpreter invocation so spawning
 * stays argv-only. This matches kernel shebang handling, which Bun's
 * node:child_process posix_spawn layer does not perform on every platform.
 *
 * Bare command names are never opened for inspection: the operating system
 * retains normal PATH lookup semantics. Path-like entrypoints are resolved to
 * one absolute target, and that same target is both inspected and passed to
 * the interpreter, so inspection and execution cannot name different files.
 */
export async function resolveSpawnCommand(
  command: readonly string[],
  depth = 0,
): Promise<readonly string[]> {
  const executable = command[0];
  if (depth >= 5 || executable === undefined || command.length === 0) return command;
  if (!executable.includes("/")) return command;
  const inspectTarget = resolve(executable);
  const shebang = await peekShebang(inspectTarget);
  if (shebang === null) return [inspectTarget, ...command.slice(1)];
  const trimmed = shebang.trim();
  if (trimmed.length === 0) return [inspectTarget, ...command.slice(1)];
  const separator = trimmed.indexOf(" ");
  const interpreter = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const interpreterArg = separator === -1 ? [] : [trimmed.slice(separator + 1).trim()];
  return resolveSpawnCommand(
    [
      interpreter,
      ...interpreterArg.filter((arg) => arg.length > 0),
      inspectTarget,
      ...command.slice(1),
    ],
    depth + 1,
  );
}

function failedCapture(spawnError: string): ProcessCapture {
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
    spawnError,
    stdinDelivery: "delivered_without_error",
    stdinDetail: null,
  };
}

async function captureProcess(
  command: readonly string[],
  options: {
    readonly stdin?: Uint8Array;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly captureCapBytes?: number;
  } = {},
): Promise<ProcessCapture> {
  const argv = await resolveSpawnCommand(command);
  return await new Promise<ProcessCapture>((resolveCapture) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(argv[0] ?? "", [...argv.slice(1)], {
        // On Unix a detached child becomes its own process-group leader, so the
        // whole spawned tree can be terminated deterministically on timeout.
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.env === undefined ? {} : { env: options.env }),
      });
    } catch (error) {
      // Bun can surface posix_spawn failures synchronously.
      resolveCapture(failedCapture(errorMessage(error)));
      return;
    }
    const pid = child.pid;
    const cap = options.captureCapBytes ?? DEFAULT_CAPTURE_CAP_BYTES;
    const stdoutAccumulator = boundedAccumulator(cap);
    const stderrAccumulator = boundedAccumulator(cap);

    let exited = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let timedOut = false;
    let streamsOpen = 2;
    let stdinAborted = false;
    let stdinSettled = options.stdin === undefined;
    let stdinDelivery: SolLunaStdinDelivery = "delivered_without_error";
    let stdinDetail: string | null = null;

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const maybeFinish = (): void => {
      if (!exited || streamsOpen > 0 || !stdinSettled) return;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      const stdoutSnapshot = stdoutAccumulator.snapshot();
      const stderrSnapshot = stderrAccumulator.snapshot();
      resolveCapture({
        stdout: stdoutSnapshot.data,
        stderr: stderrSnapshot.data,
        stdoutFullBytes: stdoutSnapshot.fullOutputBytes,
        stderrFullBytes: stderrSnapshot.fullOutputBytes,
        stdoutOmittedBytes: stdoutSnapshot.omittedBytes,
        stderrOmittedBytes: stderrSnapshot.omittedBytes,
        exitCode,
        signal,
        timedOut,
        spawnError: null,
        stdinDelivery,
        stdinDetail,
      });
    };

    child.on("error", (error) => {
      // Spawn failures can also surface asynchronously as process errors;
      // resolve honestly instead of leaving the capture pending until timeout.
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      resolveCapture(failedCapture(errorMessage(error)));
    });
    child.stdout.on("data", (chunk: Buffer) => stdoutAccumulator.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrAccumulator.push(chunk));
    child.stdout.on("close", () => {
      streamsOpen -= 1;
      maybeFinish();
    });
    child.stderr.on("close", () => {
      streamsOpen -= 1;
      maybeFinish();
    });
    child.on("exit", (code, termSignal) => {
      exited = true;
      exitCode = code;
      signal = termSignal;
      stdinAborted = true;
      maybeFinish();
    });

    if (pid !== null && pid !== undefined && options.stdin !== undefined) {
      void deliverStdin(child.stdin, options.stdin, () => stdinAborted).then(
        (result) => {
          stdinDelivery = result.delivery;
          stdinDetail = result.detail;
          stdinSettled = true;
          maybeFinish();
        },
        (error) => {
          stdinDelivery = "child_closed_stdin_early";
          stdinDetail = errorMessage(error);
          stdinSettled = true;
          maybeFinish();
        },
      );
    }

    if (pid !== null && pid !== undefined && options.timeoutMs !== undefined) {
      const groupPid = pid;
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stdinAborted = true;
        signalProcessTree(groupPid, child, "SIGTERM");
        escalationTimer = setTimeout(() => {
          signalProcessTree(groupPid, child, "SIGKILL");
        }, KILL_ESCALATION_GRACE_MS);
      }, options.timeoutMs);
    }
  });
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(path: string, bytes: Uint8Array): SolLunaArtifact {
  return {
    path,
    bytes: bytes.byteLength,
    sha256: digest(bytes),
  };
}

function streamArtifact(path: string, capture: ProcessCapture | null, kind: "stdout" | "stderr"): SolLunaStreamArtifact {
  const bytes = kind === "stdout" ? capture?.stdout : capture?.stderr;
  const retained = bytes ?? new Uint8Array();
  const fullBytes = kind === "stdout" ? capture?.stdoutFullBytes ?? 0 : capture?.stderrFullBytes ?? 0;
  const omittedBytes = kind === "stdout"
    ? capture?.stdoutOmittedBytes ?? 0
    : capture?.stderrOmittedBytes ?? 0;
  return {
    path,
    bytes: retained.byteLength,
    sha256: digest(retained),
    truncated: omittedBytes > 0,
    fullOutputBytes: fullBytes,
    omittedBytes,
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 500);
}

function appendHarnessError(current: string | null, error: unknown): string {
  const next = errorMessage(error);
  return current === null ? next : `${current}; ${next}`.slice(0, 500);
}

function jsonObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringProperty(value: unknown, keys: readonly string[]): string | null {
  const object = jsonObject(value);
  if (object === null) return null;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

function parseJsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      events.push(JSON.parse(trimmed) as unknown);
    } catch {
      // The raw stdout artifact remains authoritative; non-JSON diagnostic lines and
      // lines cut by retention bounds do not prevent finding later structured events.
    }
  }
  return events;
}

function findCodexId(events: readonly unknown[]): string | null {
  for (const event of events) {
    const direct = stringProperty(event, ["thread_id", "threadId", "session_id", "sessionId"]);
    if (direct !== null) return direct;
    const nested = stringProperty(jsonObject(event)?.thread, ["id", "thread_id", "threadId"]);
    if (nested !== null) return nested;
  }
  return null;
}

function numericUsage(value: unknown): Readonly<Record<string, number>> | null {
  const object = jsonObject(value);
  if (object === null) return null;
  const usage: Record<string, number> = {};
  for (const [key, candidate] of Object.entries(object)) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) usage[key] = candidate;
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

function findTokenUsage(events: readonly unknown[]): Readonly<Record<string, number>> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = numericUsage(jsonObject(events[index])?.usage);
    if (usage !== null) return usage;
  }
  return null;
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    const object = jsonObject(part);
    const text = typeof part === "string" ? part : object?.text;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length === 0 ? null : parts.join("");
}

function structuredValue(value: unknown): JsonObject | null {
  const direct = jsonObject(value);
  if (direct !== null) return direct;
  if (typeof value !== "string") return null;

  let candidate = value.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1] !== undefined) candidate = fenced[1].trim();
  try {
    return jsonObject(JSON.parse(candidate) as unknown);
  } catch {
    return null;
  }
}

function resultCandidates(event: unknown): unknown[] {
  const object = jsonObject(event);
  if (object === null) return [];
  const candidates: unknown[] = [];
  const item = jsonObject(object.item);
  if (item !== null) {
    const itemText = textFromContent(item.text ?? item.content);
    if (itemText !== null) candidates.push(itemText);
    if (item.result !== undefined) candidates.push(item.result);
  }
  for (const key of ["final_response", "finalResponse", "output_text", "result", "response"]) {
    if (object[key] !== undefined) candidates.push(object[key]);
  }
  return candidates;
}

function findWorkerResult(events: readonly unknown[]): JsonObject | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidates = resultCandidates(events[index]);
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const result = structuredValue(candidates[candidateIndex]);
      if (result !== null) return result;
    }
  }
  return null;
}

function parseStatusPaths(statusBytes: Uint8Array): string[] {
  const paths = new Set<string>();
  const entries = utf8(statusBytes).split("\0").filter((entry) => entry.length > 0);
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

function parseNamePaths(nameBytes: Uint8Array): string[] {
  return utf8(nameBytes).split("\0").filter((path) => path.length > 0);
}

interface GitObservationLimits {
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
}

/**
 * Noninteractive, config-neutralized environment for every Git observation.
 * `GIT_TERMINAL_PROMPT=0` makes credential prompts fail closed instead of
 * blocking an unattended run; global/system/user config is discarded so no
 * askpass helper, credential helper, or hook can be injected through Git
 * configuration. The allowlist base keeps secrets and unrelated variables out.
 */
function gitObservationEnvironment(): Record<string, string> {
  return {
    ...codexEnvironment(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Runs one Git observation through the same accepted capture lifecycle as the
 * Codex child: bounded capture, explicit wall-clock timeout, detached process
 * group, SIGTERM then SIGKILL escalation, and deterministic wait/reap.
 */
async function gitCapture(
  repository: string,
  args: readonly string[],
  limits: GitObservationLimits,
): Promise<ProcessCapture> {
  return await captureProcess(["git", "-c", "core.fsmonitor=false", "-C", repository, ...args], {
    env: gitObservationEnvironment(),
    timeoutMs: limits.timeoutMs,
    captureCapBytes: limits.captureCapBytes,
  });
}

function gitCommandLabel(args: readonly string[]): string {
  return `git ${args[0] ?? "command"}`;
}

function requireSettledGitCapture(
  result: ProcessCapture,
  args: readonly string[],
  limits: GitObservationLimits,
  allowedExitCodes: readonly number[],
): ProcessCapture {
  if (result.spawnError !== null) {
    throw new Error(`${gitCommandLabel(args)} failed to start or finish: ${result.spawnError}`);
  }
  if (result.timedOut) {
    throw new Error(`${gitCommandLabel(args)} timed out after ${limits.timeoutMs}ms`);
  }
  if (result.exitCode === null || !allowedExitCodes.includes(result.exitCode)) {
    throw new Error(`${gitCommandLabel(args)} exited with status ${result.exitCode ?? "unknown"}`);
  }
  if (result.stdoutOmittedBytes > 0) {
    throw new Error(`${gitCommandLabel(args)} stdout exceeded the ${limits.captureCapBytes}-byte capture bound`);
  }
  return result;
}

async function gitOutput(
  repository: string,
  args: readonly string[],
  limits: GitObservationLimits,
): Promise<Uint8Array> {
  const result = requireSettledGitCapture(
    await gitCapture(repository, args, limits),
    args,
    limits,
    [0],
  );
  return result.stdout;
}

type PathPresence = "present" | "absent";

async function observePathPresence(target: string): Promise<PathPresence> {
  try {
    await lstat(target);
    return "present";
  } catch (error) {
    if (error instanceof Error && "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return "absent";
    }
    throw new Error(`unable to observe worktree path ${JSON.stringify(target)}: ${errorMessage(error)}`);
  }
}

async function gitWorktreeObject(
  repository: string,
  path: string,
  limits: GitObservationLimits,
): Promise<ProcessCapture> {
  const args = ["hash-object", "--no-filters", "--", path] as const;
  const target = resolve(repository, path);
  const presenceBefore = await observePathPresence(target);
  const result = requireSettledGitCapture(
    await gitCapture(repository, args, limits),
    args,
    limits,
    [0, 128],
  );
  const presenceAfter = await observePathPresence(target);
  if (result.exitCode === 128 &&
    (presenceBefore !== "absent" || presenceAfter !== "absent")) {
    throw new Error(
      `${gitCommandLabel(args)} exited with status 128 without a stable missing worktree path ` +
      `(before=${presenceBefore}, after=${presenceAfter})`,
    );
  }
  return result;
}

function resolveGitPath(repository: string, gitPath: string): string {
  return isAbsolute(gitPath) ? resolve(gitPath) : resolve(repository, gitPath);
}

async function gitMetadataLocation(
  repository: string,
  limits: GitObservationLimits,
): Promise<GitMetadataLocation> {
  const [gitDirBytes, commonGitDirBytes, headPathBytes, indexPathBytes] = await Promise.all([
    gitOutput(repository, ["rev-parse", "--git-dir"], limits),
    gitOutput(repository, ["rev-parse", "--git-common-dir"], limits),
    gitOutput(repository, ["rev-parse", "--git-path", "HEAD"], limits),
    gitOutput(repository, ["rev-parse", "--git-path", "index"], limits),
  ]);
  const gitDirValue = utf8(gitDirBytes).trim();
  const commonGitDirValue = utf8(commonGitDirBytes).trim();
  const headPathValue = utf8(headPathBytes).trim();
  const indexPathValue = utf8(indexPathBytes).trim();
  if (gitDirValue.length === 0 || commonGitDirValue.length === 0 || headPathValue.length === 0 || indexPathValue.length === 0) {
    throw new Error("Git metadata paths were empty");
  }
  const headPath = resolveGitPath(repository, headPathValue);
  return {
    gitDir: resolveGitPath(repository, gitDirValue),
    commonGitDir: resolveGitPath(repository, commonGitDirValue),
    headPath,
    indexPath: resolveGitPath(repository, indexPathValue),
    probeDirectory: dirname(headPath),
  };
}

function probePath(parent: string, prefix: string): string {
  const suffix = createHash("sha256").update(`${parent}:${prefix}:${randomUUID()}`).digest("hex").slice(0, 20);
  return join(parent, `${prefix}-${suffix}`);
}

async function writeAndRemoveProbe(target: string, contents: string): Promise<{ status: "passed" | "failed"; error: string | null }> {
  let created = false;
  try {
    await writeFile(target, contents, { flag: "wx" });
    created = true;
    await rm(target);
    return { status: "passed", error: null };
  } catch (error) {
    if (created) await rm(target, { force: true }).catch(() => {});
    return { status: "failed", error: errorMessage(error) };
  }
}

async function probeEditAuthority(repository: string, runId: string): Promise<EditAuthorityPreflight> {
  const target = probePath(repository, `.stensibly-sol-luna-write-probe-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`);
  const result = await writeAndRemoveProbe(target, `workspace write probe ${runId}\n`);
  return { declared: "workspace-write", status: result.status, probePath: target, error: result.error };
}

async function probeGitMetadataAuthority(location: GitMetadataLocation, runId: string): Promise<GitMetadataAuthorityPreflight> {
  const target = probePath(location.probeDirectory, `.stensibly-sol-luna-git-probe-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`);
  const result = await writeAndRemoveProbe(target, `Git metadata write probe ${runId}\n`);
  return {
    declared: "write", status: result.status, gitDir: location.gitDir, headPath: location.headPath,
    indexPath: location.indexPath, probeDirectory: location.probeDirectory, probePath: target, error: result.error,
  };
}

function notRequiredEditAuthorityPreflight(declared: SolLunaEditAuthority): EditAuthorityPreflight {
  return { declared, status: declared === "read-only" ? "not_required" : "not_run", probePath: null, error: null };
}

function notRequiredGitMetadataPreflight(declared: SolLunaGitMetadataAuthority): GitMetadataAuthorityPreflight {
  return {
    declared, status: declared === "none" ? "not_required" : "not_run", gitDir: null, headPath: null,
    indexPath: null, probeDirectory: null, probePath: null, error: null,
  };
}

async function gitSnapshot(repository: string, limits: GitObservationLimits): Promise<GitSnapshot> {
  const [headBytes, statusBytes] = await Promise.all([
    gitOutput(repository, ["rev-parse", "HEAD"], limits),
    gitOutput(repository, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], limits),
  ]);
  const head = utf8(headBytes).trim();
  if (head.length === 0) throw new Error("git HEAD was empty");
  const paths = parseStatusPaths(statusBytes);
  const pathStates = await Promise.all(paths.map(async (path) => {
    const [staged, unstaged, worktree] = await Promise.all([
      gitOutput(repository, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--cached", head, "--", path], limits),
      gitOutput(repository, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--", path], limits),
      gitWorktreeObject(repository, path, limits),
    ]);
    const hash = createHash("sha256")
      .update("staged\0").update(staged)
      .update("unstaged\0").update(unstaged)
      .update("worktree-exit\0").update(String(worktree.exitCode)).update("\0")
      .update(worktree.stdout)
      .digest("hex");
    return [path, `sha256:${hash}`] as const;
  }));
  return { head, paths, pathStates: Object.fromEntries(pathStates) };
}

async function committedAttribution(
  repository: string,
  headBefore: string | null,
  headAfter: string | null,
  limits: GitObservationLimits,
): Promise<GitAttribution> {
  if (headBefore === null || headAfter === null) {
    return { headRelationship: "unknown", commitsMade: [], committedPaths: [], error: null };
  }
  if (headBefore === headAfter) {
    return { headRelationship: "unchanged", commitsMade: [], committedPaths: [], error: null };
  }
  const ancestry = await gitCapture(repository, ["merge-base", "--is-ancestor", headBefore, headAfter], limits);
  if (ancestry.spawnError !== null) {
    return {
      headRelationship: "unknown",
      commitsMade: [],
      committedPaths: [],
      error: `git merge-base failed to start or finish: ${ancestry.spawnError}`,
    };
  }
  if (ancestry.timedOut) {
    return {
      headRelationship: "unknown",
      commitsMade: [],
      committedPaths: [],
      error: `git merge-base timed out after ${limits.timeoutMs}ms before ancestry could be established`,
    };
  }
  if (ancestry.exitCode !== 0) {
    const nonDescendant = ancestry.exitCode === 1;
    return {
      headRelationship: nonDescendant ? "non_descendant" : "unknown",
      commitsMade: [],
      committedPaths: [],
      error: nonDescendant
        ? "final Git head is not a descendant of the baseline head"
        : `unable to establish Git head ancestry (exit ${ancestry.exitCode ?? "unknown"})`,
    };
  }
  const commitBytes = await gitOutput(repository, ["rev-list", "--reverse", `${headBefore}..${headAfter}`], limits);
  const commitsMade = utf8(commitBytes).split(/\r?\n/u).map((commit) => commit.trim()).filter((commit) => commit.length > 0);
  const touchedByCommit = await Promise.all(commitsMade.map((commit) => gitOutput(repository, [
    "diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", `${commit}^`, commit, "--",
  ], limits)));
  return {
    headRelationship: "descendant",
    commitsMade,
    committedPaths: [...new Set(touchedByCommit.flatMap(parseNamePaths))].sort(),
    error: null,
  };
}

/**
 * Removes prior-run managed artifacts and stale temporary files so a reused
 * output directory can never present old evidence as current-run truth.
 */
async function clearManagedRunArtifacts(outputDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const managed = new Set<string>(Object.values(ARTIFACT_NAMES));
  await Promise.all(
    entries
      .filter((entry) => managed.has(entry) || entry.startsWith(TMP_PREFIX))
      .map((entry) => rm(join(outputDir, entry), { force: true })),
  );
  const remaining = (await readdir(outputDir))
    .filter((entry) => managed.has(entry) || entry.startsWith(TMP_PREFIX));
  if (remaining.length > 0) throw new Error("managed run artifacts could not be cleared");
}

/**
 * Publishes bytes through a same-directory temporary file plus rename so the
 * target is never observed partially written. Temporary files are removed on
 * failure.
 */
async function publishAtomically(targetPath: string, bytes: Uint8Array): Promise<void> {
  const temporaryPath = join(
    dirname(targetPath),
    `${TMP_PREFIX}${createHash("sha256").update(targetPath).digest("hex").slice(0, 12)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Surface the original publication failure regardless.
    }
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function configArgs(reasoningEffort: SolLunaReasoningEffort, environment: WorkerShellEnvironment): string[] {
  return [
    "--config", `model_reasoning_effort=${tomlString(reasoningEffort)}`,
    "--config", 'shell_environment_policy.inherit="none"',
    "--config", `shell_environment_policy.set.PATH=${tomlString(SAFE_WORKER_PATH)}`,
    "--config", `shell_environment_policy.set.HOME=${tomlString(environment.home)}`,
    "--config", `shell_environment_policy.set.TMPDIR=${tomlString(environment.tmpdir)}`,
  ];
}

function commandShape(
  options: Required<SolLunaWorkerOptions>,
  profile: CompiledCodexPermissionProfile | null,
): SolLunaWorkerReceipt["child"]["commandShape"] {
  const environment = { root: "<worker-runtime>", home: "<worker-home>", tmpdir: "<worker-tmpdir>" };
  const promptSurface = compileCodexPromptSurfaceProfile(options.promptSurfaceProfile);
  return {
    executable: CODEX_COMMAND,
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      CODEX_MODEL,
      ...(profile === null ? [] : permissionProfileReceiptArgs(profile)),
      ...configArgs(options.reasoningEffort, environment),
      ...promptSurface.configArgs,
      ...(profile === null ? ["--sandbox", options.sandbox] : []),
      "--cd",
      "<repository>",
      "--output-schema",
      "<output-schema>",
      "-",
    ],
    confinement: options.confinement,
    profileFingerprint: profile?.fingerprint ?? null,
    stdin: "canonical-brief",
    reasoningEffort: options.reasoningEffort,
    promptSurface: {
      profile: promptSurface.name,
      contextRetirements: promptSurface.contextRetirements,
      capabilityRetirements: promptSurface.capabilityRetirements,
    },
    wallClockTimeoutMs: options.timeoutMs,
    shellEnvironment: { inherit: "none", path: SAFE_WORKER_PATH, home: environment.home, tmpdir: environment.tmpdir },
  };
}

function childArgs(
  options: Required<SolLunaWorkerOptions>,
  environment: WorkerShellEnvironment,
  profile: CompiledCodexPermissionProfile | null,
): string[] {
  const promptSurface = compileCodexPromptSurfaceProfile(options.promptSurfaceProfile);
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--model",
    CODEX_MODEL,
    ...(profile === null ? [] : permissionProfileConfigArgs(profile)),
    ...configArgs(options.reasoningEffort, environment),
    ...promptSurface.configArgs,
    ...(profile === null ? ["--sandbox", options.sandbox] : []),
    "--cd",
    options.repository,
    "--output-schema",
    options.outputSchema,
    "-",
  ];
}

function preflightShape(): ["codex", "login", "status"] {
  return [CODEX_COMMAND, "login", "status"];
}

function reportsChatGptAuthentication(capture: {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
}): boolean {
  const output = `${utf8(capture.stdout)}\n${utf8(capture.stderr)}`;
  return capture.exitCode === 0
    && output.includes(CHATGPT_LOGIN_STATUS)
    && !/API key/iu.test(output);
}

export async function runSolLunaWorker(input: SolLunaWorkerOptions): Promise<SolLunaWorkerRun> {
  const options = normalizeOptions(input);
  if (options.confinement === "permission-profile") {
    const outputError = await permissionProfileOutputError(options.outputDir, options.repository);
    if (outputError !== null) throw new Error(outputError);
  }
  await mkdir(options.outputDir, { recursive: true });
  if (options.confinement === "permission-profile") {
    const outputError = await permissionProfileOutputError(options.outputDir, options.repository);
    if (outputError !== null) throw new Error(outputError);
  }
  await clearManagedRunArtifacts(options.outputDir);

  const stdoutPath = resolve(options.outputDir, ARTIFACT_NAMES.stdout);
  const stderrPath = resolve(options.outputDir, ARTIFACT_NAMES.stderr);
  const workerResultPath = resolve(options.outputDir, ARTIFACT_NAMES.workerResult);
  const receiptPath = resolve(options.outputDir, ARTIFACT_NAMES.receipt);
  const workerRuntimeRoot = `${options.outputDir}.runtime`;
  const workerEnvironment: WorkerShellEnvironment = {
    root: workerRuntimeRoot,
    home: join(workerRuntimeRoot, "home"),
    tmpdir: join(workerRuntimeRoot, "tmp"),
  };
  let workerRuntimeCreated = false;
  let runtimeInitializationError: string | null = null;
  try {
    await mkdir(workerRuntimeRoot, { mode: 0o700 });
    workerRuntimeCreated = true;
    await mkdir(workerEnvironment.home, { mode: 0o700 });
    await mkdir(workerEnvironment.tmpdir, { mode: 0o700 });
  } catch (error) {
    runtimeInitializationError = `unable to claim worker runtime: ${errorMessage(error)}`;
    if (workerRuntimeCreated) {
      try {
        await rm(workerRuntimeRoot, { recursive: true });
        workerRuntimeCreated = false;
      } catch (cleanupError) {
        runtimeInitializationError = `${runtimeInitializationError}; owned runtime cleanup failed: ${errorMessage(cleanupError)}`;
      }
    }
  }
  let workerCapture: ProcessCapture | null = null;
  let workerResultBytes: Uint8Array | null = null;
  let workerResult: JsonObject | null = null;
  let harnessError: string | null = runtimeInitializationError;
  let headBefore: string | null = null;
  let headAfter: string | null = null;
  let beforePaths: readonly string[] = [];
  let afterPaths: readonly string[] = [];
  let beforeGitReadable = false;
  let beforePathStates: Readonly<Record<string, string>> = {};
  let afterPathStates: Readonly<Record<string, string>> = {};
  let afterGitReadable = false;
  let workerCreatedDirtyPaths: readonly string[] = [];
  let commitsMade: readonly string[] = [];
  let committedPaths: readonly string[] = [];
  let headRelationship: SolLunaWorkerReceipt["git"]["headRelationship"] = "unknown";
  let gitLocation: GitMetadataLocation | null = null;
  let compiledProfile: CompiledCodexPermissionProfile | null = null;
  const gitLimits: GitObservationLimits = {
    timeoutMs: options.gitTimeoutMs,
    captureCapBytes: options.captureCapBytes,
  };
  let clientVersion: string | null = null;
  let permissionProfileSupported = false;
  let editAuthorityPreflight = notRequiredEditAuthorityPreflight(options.editAuthority);
  let gitMetadataAuthorityPreflight = notRequiredGitMetadataPreflight(options.gitMetadataAuthority);
  let requiredCommandPreflights: readonly RequiredCommandPreflight[] = options.requiredCommands.map((command) => ({
    command,
    status: "not_run",
    resolvedPath: null,
  }));
  let preflightExitCode: number | null = null;
  let chatGptAuthenticated = false;
  let childExitCode: number | null = null;
  let childSignal: string | null = null;
  let childTimedOut = false;
  let childStarted = false;
  let codexId: string | null = null;
  let threadId: string | null = null;
  let tokenUsage: Readonly<Record<string, number>> | null = null;

  try {
    const [briefBytes, schemaBytes] = await Promise.all([
      readFile(options.brief),
      readFile(options.outputSchema),
    ]);
    if (schemaBytes.byteLength === 0) throw new Error("output schema file is empty");
    const schema = JSON.parse(schemaBytes.toString("utf8")) as unknown;
    if (jsonObject(schema) === null) throw new Error("output schema must contain a JSON object");

    try {
      const snapshot = await gitSnapshot(options.repository, gitLimits);
      headBefore = snapshot.head;
      beforePaths = snapshot.paths;
      beforePathStates = snapshot.pathStates;
      beforeGitReadable = true;
      gitLocation = await gitMetadataLocation(options.repository, gitLimits);
    } catch (error) {
      harnessError = appendHarnessError(harnessError, `unable to read Git state: ${errorMessage(error)}`);
    }

    if (harnessError === null && options.editAuthority === "workspace-write") {
      editAuthorityPreflight = await probeEditAuthority(options.repository, options.runId);
      if (editAuthorityPreflight.status !== "passed") {
        harnessError = appendHarnessError(harnessError, `workspace edit authority preflight failed: ${editAuthorityPreflight.error ?? "probe failed"}`);
      }
    }

    if (harnessError === null && options.gitMetadataAuthority === "write") {
      if (gitLocation === null) {
        harnessError = appendHarnessError(harnessError, "Git metadata location was unavailable");
      } else {
        gitMetadataAuthorityPreflight = await probeGitMetadataAuthority(gitLocation, options.runId);
        if (gitMetadataAuthorityPreflight.status !== "passed") {
          harnessError = appendHarnessError(harnessError, `Git metadata authority preflight failed: ${gitMetadataAuthorityPreflight.error ?? "probe failed"}`);
        }
      }
    }

    if (harnessError === null) {
      requiredCommandPreflights = await preflightRequiredCommands(options.requiredCommands);
      const missingCommands = requiredCommandPreflights
        .filter((command) => command.status === "missing")
        .map((command) => command.command);
      if (missingCommands.length > 0) {
        harnessError = appendHarnessError(
          harnessError,
          `required worker commands unavailable in effective PATH: ${missingCommands.join(", ")}`,
        );
      }
    }

    if (harnessError === null && options.confinement === "permission-profile") {
      const version = await captureProcess([options.codexBin, "--version"], {
        env: codexEnvironment(), timeoutMs: options.timeoutMs, captureCapBytes: options.captureCapBytes,
      });
      clientVersion = parseSupportedCodexCliVersion(utf8(version.stdout));
      permissionProfileSupported = version.spawnError === null && version.exitCode === 0 && clientVersion !== null;
      if (!permissionProfileSupported) {
        harnessError = "Codex client does not report permission-profile support (requires codex-cli >= 0.138)";
      } else if (gitLocation === null) {
        harnessError = "Git metadata location was unavailable for permission-profile compilation";
      } else {
        compiledProfile = compileCodexPermissionProfile({
          repository: options.repository,
          gitDir: gitLocation.gitDir,
          commonGitDir: gitLocation.commonGitDir,
          runtimeDir: workerEnvironment.root,
          outputDir: options.outputDir,
          workspaceAccess: "read",
        });
      }
    }

    if (harnessError === null) {
      try {
        const preflight = await captureProcess(
          [options.codexBin, "login", "status"],
          { env: codexEnvironment(), timeoutMs: options.timeoutMs, captureCapBytes: options.captureCapBytes },
        );
        preflightExitCode = preflight.exitCode;
        chatGptAuthenticated = reportsChatGptAuthentication(preflight);
        if (preflight.spawnError !== null) {
          harnessError = appendHarnessError(harnessError, `Codex authentication preflight failed: ${preflight.spawnError}`);
        } else if (preflight.timedOut) {
          harnessError = "Codex authentication preflight timed out before reporting ChatGPT authentication";
        } else if (!chatGptAuthenticated) {
          harnessError = "Codex login status did not report ChatGPT authentication";
        }
      } catch (error) {
        harnessError = appendHarnessError(harnessError, `Codex authentication preflight failed: ${errorMessage(error)}`);
      }
    }

    if (harnessError === null) {
      try {
        const captured = await captureProcess(
          [options.codexBin, ...childArgs(options, workerEnvironment, compiledProfile)],
          {
            stdin: new Uint8Array(briefBytes),
            env: codexEnvironment(),
            timeoutMs: options.timeoutMs,
            captureCapBytes: options.captureCapBytes,
          },
        );
        childStarted = true;
        workerCapture = captured;
        childExitCode = captured.exitCode;
        childSignal = captured.signal;
        childTimedOut = captured.timedOut;
        const events = captured.spawnError === null ? parseJsonLines(utf8(captured.stdout)) : [];
        codexId = findCodexId(events);
        threadId = codexId;
        tokenUsage = findTokenUsage(events);
        workerResult = findWorkerResult(events);
        if (workerResult !== null) {
          workerResultBytes = new TextEncoder().encode(`${JSON.stringify(workerResult, null, 2)}\n`);
        }
        if (captured.spawnError !== null) {
          harnessError = appendHarnessError(harnessError, `Codex worker failed to start or finish: ${captured.spawnError}`);
        } else if (!captured.timedOut && captured.exitCode === 0 && workerResult === null) {
          harnessError = "Codex exited successfully without a structured worker result";
        }
      } catch (error) {
        harnessError = appendHarnessError(harnessError, `Codex worker failed to start or finish: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `harness input preparation failed: ${errorMessage(error)}`);
  }

  try {
    if (workerRuntimeCreated) await rm(workerRuntimeRoot, { recursive: true });
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to clean worker runtime: ${errorMessage(error)}`);
  }

  try {
    const snapshot = await gitSnapshot(options.repository, gitLimits);
    headAfter = snapshot.head;
    afterPaths = snapshot.paths;
    afterPathStates = snapshot.pathStates;
    afterGitReadable = true;
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read final Git state: ${errorMessage(error)}`);
  }

  try {
    const attribution = await committedAttribution(options.repository, headBefore, headAfter, gitLimits);
    headRelationship = attribution.headRelationship;
    commitsMade = attribution.commitsMade;
    committedPaths = attribution.committedPaths;
    if (attribution.error !== null) harnessError = appendHarnessError(harnessError, attribution.error);
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read committed Git changes: ${errorMessage(error)}`);
  }

  // This is an observed path delta. A commit made during the run may include
  // baseline-dirty bytes, so contaminated committed paths remain explicit below.
  if (beforeGitReadable && afterGitReadable) {
    workerCreatedDirtyPaths = [...new Set([...beforePaths, ...afterPaths])]
      .filter((path) => beforePathStates[path] !== afterPathStates[path])
      .sort();
  }
  const changedPaths = beforeGitReadable
    ? [...new Set([...committedPaths, ...workerCreatedDirtyPaths])].sort()
    : [];
  const baselineContaminatedCommittedPaths = beforeGitReadable
    ? committedPaths.filter((path) => beforePaths.includes(path))
    : [];

  let stdoutArtifact: SolLunaStreamArtifact | null = null;
  let stderrArtifact: SolLunaStreamArtifact | null = null;
  let finalWorkerResultArtifact: SolLunaArtifact | null = null;
  try {
    await writeFile(stdoutPath, workerCapture?.stdout ?? new Uint8Array());
    stdoutArtifact = streamArtifact(stdoutPath, workerCapture, "stdout");
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to retain stdout artifact: ${errorMessage(error)}`);
  }
  try {
    await writeFile(stderrPath, workerCapture?.stderr ?? new Uint8Array());
    stderrArtifact = streamArtifact(stderrPath, workerCapture, "stderr");
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to retain stderr artifact: ${errorMessage(error)}`);
  }
  if (workerResultBytes !== null) {
    try {
      await writeFile(workerResultPath, workerResultBytes);
      finalWorkerResultArtifact = artifact(workerResultPath, workerResultBytes);
    } catch (error) {
      harnessError = appendHarnessError(harnessError, `unable to retain worker-result artifact: ${errorMessage(error)}`);
    }
  }
  const artifacts: SolLunaWorkerReceipt["artifacts"] = {
    stdoutJsonl: stdoutArtifact,
    stderr: stderrArtifact,
    finalWorkerResult: finalWorkerResultArtifact,
  };

  const outcome: SolLunaChildOutcome = childTimedOut
    ? "timeout"
    : childExitCode !== null && childExitCode !== 0
      ? "worker_failed"
      : harnessError !== null
        ? "harness_failed"
        : childExitCode === null
          ? "not_started"
          : "worker_succeeded";
  const receipt: SolLunaWorkerReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    run: { id: options.runId, assignedRole: options.assignedRole },
    repository: options.repository,
    sandbox: options.sandbox,
    confinement: {
      mode: options.confinement,
      clientVersion,
      permissionProfileSupported,
      profileVersion: compiledProfile?.version ?? null,
      profileFingerprint: compiledProfile?.fingerprint ?? null,
      networkEnabled: compiledProfile?.networkEnabled ?? null,
    },
    preflight: {
      command: preflightShape(),
      exitCode: preflightExitCode,
      chatGptAuthenticated,
      editAuthority: editAuthorityPreflight,
      gitMetadataAuthority: gitMetadataAuthorityPreflight,
      requiredCommands: requiredCommandPreflights,
    },
    git: {
      headBefore,
      headAfter,
      headRelationship,
      dirtyPathsBefore: beforePaths,
      dirtyPathsAfter: afterPaths,
      workerCreatedDirtyPaths,
      commitsMade,
      committedPaths,
      baselineContaminatedCommittedPaths,
      changedPaths,
    },
    child: {
      commandShape: commandShape(options, compiledProfile),
      exitCode: childExitCode,
      signal: childSignal,
      timedOut: childTimedOut,
      outcome,
      stdinOutcome: childStarted && workerCapture?.spawnError === null
        ? workerCapture?.stdinDelivery ?? "not_started"
        : "not_started",
      stdinDetail: childStarted && workerCapture?.spawnError === null ? workerCapture?.stdinDetail ?? null : null,
      wallClockTimeoutMs: options.timeoutMs,
    },
    codex: {
      sessionOrThreadId: codexId,
      threadId,
      tokenUsage,
    },
    artifacts,
    integration: {
      workerSuccessIsProvisional: true,
      status: "not_adjudicated",
      gatesAdjudicated: false,
      note: "Worker success is provisional; integration status and gates were not adjudicated by this worker run.",
    },
    success: outcome === "worker_succeeded",
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
    exitCode: receipt.success
      ? 0
      : outcome === "timeout"
        ? 124
        : outcome === "worker_failed" && harnessError === null
          ? (childExitCode ?? 1)
          : 1,
  };
}

interface ParsedCliOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputSchema: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly assignedRole: string;
  readonly sandbox: SolLunaSandbox;
  readonly confinement?: SolLunaConfinement;
  readonly editAuthority?: SolLunaEditAuthority;
  readonly gitMetadataAuthority?: SolLunaGitMetadataAuthority;
  readonly reasoningEffort?: SolLunaReasoningEffort;
  readonly promptSurfaceProfile?: CodexPromptSurfaceProfileName;
  readonly requiredCommands?: readonly string[];
  readonly codexBin?: string;
  readonly timeoutMs?: number;
  readonly captureCapBytes?: number;
  readonly gitTimeoutMs?: number;
}

function usage(): string {
  return [
    "Usage: bun scripts/sol-luna-worker.ts --repository PATH --brief FILE --output-schema FILE",
    "  --output-dir DIR --run-id ID --assigned-role ROLE [--sandbox read-only|workspace-write]",
    "  [--confinement permission-profile|legacy-sandbox]",
    "  [--edit-authority read-only|workspace-write] [--git-metadata-authority none|write]",
    "  [--reasoning-effort low|medium|high|xhigh|max]",
    "  [--prompt-surface-profile full|skills-catalogue-muted|closed-task]",
    "  [--require-command NAME]...",
    "  [--codex-bin PATH] [--timeout-ms MS] [--capture-cap-bytes BYTES]",
    "  [--git-timeout-ms MS]",
  ].join("\n");
}

function parsePositiveIntegerCli(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, received ${value}`);
  }
  return parsed;
}

function parseCli(argv: readonly string[]): ParsedCliOptions {
  const values = new Map<string, string>();
  const requiredCommands: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") throw new Error(usage());
    if (key === undefined || !key.startsWith("--")) throw new Error(`invalid argument ${key ?? "missing"}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    const name = key.slice(2);
    if (name === "require-command") {
      requiredCommands.push(value);
      index += 1;
      continue;
    }
    if (values.has(name)) throw new Error(`duplicate argument ${key}`);
    values.set(name, value);
    index += 1;
  }

  const aliases: Record<string, string> = {
    repo: "repository",
    schema: "output-schema",
    role: "assigned-role",
    "output-json-schema": "output-schema",
    "output-directory": "output-dir",
    "out-dir": "output-dir",
  };
  for (const [alias, canonical] of Object.entries(aliases)) {
    const aliasValue = values.get(alias);
    if (aliasValue !== undefined) {
      if (values.has(canonical)) throw new Error(`duplicate argument --${canonical}`);
      values.set(canonical, aliasValue);
      values.delete(alias);
    }
  }

  const required = ["repository", "brief", "output-schema", "output-dir", "run-id", "assigned-role"];
  for (const key of required) {
    if (!values.has(key)) throw new Error(`missing required argument --${key}`);
  }
  const sandbox = values.get("sandbox") ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error("--sandbox must be read-only or workspace-write");
  }
  const confinement = values.get("confinement");
  if (confinement !== undefined && !isConfinement(confinement)) throw new Error("--confinement must be permission-profile or legacy-sandbox");
  const editAuthority = values.get("edit-authority");
  if (editAuthority !== undefined && !isEditAuthority(editAuthority)) throw new Error("--edit-authority must be read-only or workspace-write");
  const gitMetadataAuthority = values.get("git-metadata-authority");
  if (gitMetadataAuthority !== undefined && !isGitMetadataAuthority(gitMetadataAuthority)) throw new Error("--git-metadata-authority must be none or write");
  const reasoningEffort = values.get("reasoning-effort");
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) throw new Error("--reasoning-effort must be low, medium, high, xhigh, or max");
  const promptSurfaceProfile = values.get("prompt-surface-profile");
  if (promptSurfaceProfile !== undefined && !isCodexPromptSurfaceProfileName(promptSurfaceProfile)) {
    throw new Error("--prompt-surface-profile must be full, skills-catalogue-muted, or closed-task");
  }
  const known = new Set([...required, "sandbox", "confinement", "edit-authority", "git-metadata-authority", "reasoning-effort", "prompt-surface-profile", "codex-bin", "timeout-ms", "capture-cap-bytes", "git-timeout-ms"]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`unknown argument --${key}`);
  }
  const timeoutValue = values.get("timeout-ms");
  const captureCapValue = values.get("capture-cap-bytes");
  const gitTimeoutValue = values.get("git-timeout-ms");

  return {
    repository: values.get("repository") as string,
    brief: values.get("brief") as string,
    outputSchema: values.get("output-schema") as string,
    outputDir: values.get("output-dir") as string,
    runId: values.get("run-id") as string,
    assignedRole: values.get("assigned-role") as string,
    sandbox,
    ...(confinement === undefined ? {} : { confinement }),
    ...(editAuthority === undefined ? {} : { editAuthority }),
    ...(gitMetadataAuthority === undefined ? {} : { gitMetadataAuthority }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(promptSurfaceProfile === undefined ? {} : { promptSurfaceProfile }),
    requiredCommands,
    codexBin: values.get("codex-bin"),
    ...(timeoutValue === undefined ? {} : { timeoutMs: parsePositiveIntegerCli(timeoutValue, "--timeout-ms") }),
    ...(captureCapValue === undefined
      ? {}
      : { captureCapBytes: parsePositiveIntegerCli(captureCapValue, "--capture-cap-bytes") }),
    ...(gitTimeoutValue === undefined
      ? {}
      : { gitTimeoutMs: parsePositiveIntegerCli(gitTimeoutValue, "--git-timeout-ms") }),
  };
}

export async function runSolLunaCli(argv: readonly string[]): Promise<number> {
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      console.log(usage());
      return 0;
    }
    const options = parseCli(argv);
    const result = await runSolLunaWorker(options);
    return result.exitCode;
  } catch (error) {
    console.error(errorMessage(error));
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await runSolLunaCli(process.argv.slice(2));
}
