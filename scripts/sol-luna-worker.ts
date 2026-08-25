import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, delimiter, isAbsolute, join, relative, resolve } from "node:path";

const CODEX_COMMAND = "codex";
const CODEX_MODEL = "gpt-5.6-luna";
const CHATGPT_LOGIN_STATUS = "Logged in using ChatGPT";
const RECEIPT_SCHEMA_VERSION = "sol-luna-worker-receipt/2" as const;
const ARTIFACT_NAMES = {
  stdout: "stdout.jsonl",
  stderr: "stderr.log",
  workerResult: "worker-result.json",
  receipt: "receipt.json",
} as const;

export type SolLunaSandbox = "read-only" | "workspace-write";
export type SolLunaEditAuthority = "read-only" | "workspace-write";
export type SolLunaGitMetadataAuthority = "none" | "write";
export type SolLunaReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_SOL_LUNA_REASONING_EFFORT: SolLunaReasoningEffort = "max";
export const DEFAULT_SOL_LUNA_TIMEOUT_MS = 30 * 60 * 1000;
export const CODEX_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LANGUAGE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export const SAFE_WORKER_PATH = [...new Set([
  dirname(process.execPath),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
])].join(delimiter);

type CodexEnvironmentKey = typeof CODEX_ENVIRONMENT_ALLOWLIST[number];
type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

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

export interface SolLunaWorkerOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputSchema: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly assignedRole: string;
  readonly sandbox?: SolLunaSandbox;
  readonly editAuthority?: SolLunaEditAuthority;
  readonly gitMetadataAuthority?: SolLunaGitMetadataAuthority;
  readonly reasoningEffort?: SolLunaReasoningEffort;
  readonly timeoutMs?: number;
  readonly codexBin?: string;
}

export interface SolLunaArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SolLunaWorkerReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly run: {
    readonly id: string;
    readonly assignedRole: string;
  };
  readonly repository: string;
  readonly sandbox: SolLunaSandbox;
  readonly preflight: {
    readonly command: readonly ["codex", "login", "status"];
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly chatGptAuthenticated: boolean;
    readonly editAuthority: EditAuthorityPreflight;
    readonly gitMetadataAuthority: GitMetadataAuthorityPreflight;
  };
  readonly git: {
    readonly headBefore: string | null;
    readonly headAfter: string | null;
    readonly baselineDirtyPaths: readonly string[];
    readonly workerCreatedDirtyPaths: readonly string[];
    readonly commitsMade: readonly string[];
    readonly committedPaths: readonly string[];
    readonly finalDirtyPaths: readonly string[];
    readonly changedPaths: readonly string[];
  };
  readonly child: {
    readonly commandShape: {
      readonly executable: "codex";
      readonly args: readonly string[];
      readonly stdin: "canonical-brief";
      readonly reasoningEffort: SolLunaReasoningEffort;
      readonly wallClockTimeoutMs: number;
      readonly shellEnvironment: {
        readonly inherit: "none";
        readonly path: string;
        readonly home: string;
        readonly tmpdir: string;
      };
    };
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly wallClockTimeoutMs: number;
    readonly outcome: "not_started" | "worker_succeeded" | "worker_failed" | "worker_timed_out" | "harness_failed";
  };
  readonly codex: {
    readonly sessionOrThreadId: string | null;
    readonly threadId: string | null;
    readonly tokenUsage: Readonly<Record<string, number>> | null;
  };
  readonly artifacts: {
    readonly stdoutJsonl: SolLunaArtifact;
    readonly stderr: SolLunaArtifact;
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
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

interface GitSnapshot {
  readonly head: string;
  readonly paths: readonly string[];
}

interface GitMetadataLocation {
  readonly gitDir: string;
  readonly headPath: string;
  readonly indexPath: string;
  readonly probeDirectory: string;
}

interface GitAttribution {
  readonly commitsMade: readonly string[];
  readonly committedPaths: readonly string[];
}

interface WorkerShellEnvironment {
  readonly home: string;
  readonly tmpdir: string;
}

type JsonObject = Record<string, unknown>;

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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

function positiveFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function normalizeOptions(input: SolLunaWorkerOptions): Required<SolLunaWorkerOptions> {
  const sandbox = input.sandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error("sandbox must be read-only or workspace-write");
  }
  const editAuthority = input.editAuthority ?? sandbox;
  if (!isEditAuthority(editAuthority)) {
    throw new Error("edit authority must be read-only or workspace-write");
  }
  if (editAuthority === "workspace-write" && sandbox !== "workspace-write") {
    throw new Error("workspace-write edit authority requires a workspace-write sandbox");
  }
  const gitMetadataAuthority = input.gitMetadataAuthority ?? "none";
  if (!isGitMetadataAuthority(gitMetadataAuthority)) {
    throw new Error("Git metadata authority must be none or write");
  }
  const reasoningEffort = input.reasoningEffort ?? DEFAULT_SOL_LUNA_REASONING_EFFORT;
  if (!isReasoningEffort(reasoningEffort)) {
    throw new Error("reasoning effort must be low, medium, high, xhigh, or max");
  }
  return {
    repository: resolve(requireText(input.repository, "repository")),
    brief: resolve(requireText(input.brief, "brief")),
    outputSchema: resolve(requireText(input.outputSchema, "output schema")),
    outputDir: resolve(requireText(input.outputDir, "output directory")),
    runId: requireText(input.runId, "run ID"),
    assignedRole: requireText(input.assignedRole, "assigned role"),
    sandbox,
    editAuthority,
    gitMetadataAuthority,
    reasoningEffort,
    timeoutMs: positiveFiniteNumber(input.timeoutMs ?? DEFAULT_SOL_LUNA_TIMEOUT_MS, "timeout").valueOf(),
    codexBin: requireText(input.codexBin ?? CODEX_COMMAND, "Codex executable"),
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

async function captureProcess(
  command: readonly string[],
  options: {
    readonly stdin?: Uint8Array;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
  } = {},
): Promise<ProcessCapture> {
  const child = Bun.spawn([...command], {
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    positiveFiniteNumber(options.timeoutMs, "process timeout");
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child.pid).catch(() => {
        // The child may have exited in the same event-loop turn as the timeout.
      });
    }, options.timeoutMs);
  }

  try {
    if (options.stdin !== undefined) {
      const stdin = child.stdin;
      if (stdin === undefined) {
        throw new Error("child stdin was not piped");
      }
      stdin.write(options.stdin);
      stdin.end();
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).arrayBuffer(),
      child.exited,
    ]);
    return {
      stdout: new Uint8Array(stdout),
      stderr: new Uint8Array(stderr),
      exitCode,
      timedOut,
    };
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Preserve the original process/capture error.
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function killProcessTree(pid: number): Promise<void> {
  let children: number[] = [];
  try {
    const result = Bun.spawn(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(result.stdout).text();
    await result.exited;
    children = output.split(/\s+/u).filter(Boolean).map(Number).filter(Number.isInteger);
  } catch {}
  await Promise.all(children.map((childPid) => killProcessTree(childPid)));
  try { process.kill(pid, "SIGKILL"); } catch {}
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
      // The raw stdout artifact remains authoritative; non-JSON diagnostic lines do not
      // prevent us from finding a later structured Codex event.
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

async function gitOutput(repository: string, args: readonly string[]): Promise<Uint8Array> {
  const result = await captureProcess(["git", "-c", "core.fsmonitor=false", "-C", repository, ...args], { env: { ...codexEnvironment(), GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} exited with status ${result.exitCode}`);
  }
  return result.stdout;
}

async function gitSnapshot(repository: string): Promise<GitSnapshot> {
  const [headBytes, statusBytes] = await Promise.all([
    gitOutput(repository, ["rev-parse", "HEAD"]),
    gitOutput(repository, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]),
  ]);
  const head = utf8(headBytes).trim();
  if (head.length === 0) throw new Error("git HEAD was empty");
  return { head, paths: parseStatusPaths(statusBytes) };
}

function resolveGitPath(repository: string, gitPath: string): string {
  return isAbsolute(gitPath) ? resolve(gitPath) : resolve(repository, gitPath);
}

async function gitMetadataLocation(repository: string): Promise<GitMetadataLocation> {
  const [gitDirBytes, headPathBytes, indexPathBytes] = await Promise.all([
    gitOutput(repository, ["rev-parse", "--git-dir"]),
    gitOutput(repository, ["rev-parse", "--git-path", "HEAD"]),
    gitOutput(repository, ["rev-parse", "--git-path", "index"]),
  ]);
  const gitDirValue = utf8(gitDirBytes).trim();
  const headPathValue = utf8(headPathBytes).trim();
  const indexPathValue = utf8(indexPathBytes).trim();
  if (gitDirValue.length === 0 || headPathValue.length === 0 || indexPathValue.length === 0) {
    throw new Error("Git metadata paths were empty");
  }
  const headPath = resolveGitPath(repository, headPathValue);
  return {
    gitDir: resolveGitPath(repository, gitDirValue),
    headPath,
    indexPath: resolveGitPath(repository, indexPathValue),
    probeDirectory: dirname(headPath),
  };
}

function probePath(repository: string, prefix: string): string {
  const runDigest = createHash("sha256").update(`${repository}:${prefix}:${randomUUID()}`).digest("hex").slice(0, 20);
  return join(repository, `${prefix}-${runDigest}`);
}

async function writeAndRemoveProbe(path: string, contents: string): Promise<{ readonly status: "passed" | "failed"; readonly error: string | null }> {
  let created = false;
  try {
    await writeFile(path, contents, { flag: "wx" });
    created = true;
    await rm(path);
    return { status: "passed", error: null };
  } catch (error) {
    if (created) {
      try {
        await rm(path, { force: true });
      } catch (cleanupError) {
        return {
          status: "failed",
          error: `${errorMessage(error)}; probe cleanup failed: ${errorMessage(cleanupError)}`,
        };
      }
    }
    return { status: "failed", error: errorMessage(error) };
  }
}

async function probeEditAuthority(
  repository: string,
  runId: string,
): Promise<EditAuthorityPreflight> {
  const path = probePath(repository, `.stensibly-sol-luna-write-probe-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`);
  const result = await writeAndRemoveProbe(path, `sol-luna workspace write probe ${runId}\n`);
  return {
    declared: "workspace-write",
    status: result.status,
    probePath: path,
    error: result.error,
  };
}

async function probeGitMetadataAuthority(
  location: GitMetadataLocation,
  runId: string,
): Promise<GitMetadataAuthorityPreflight> {
  const path = probePath(location.probeDirectory, `.stensibly-sol-luna-git-probe-${createHash("sha256").update(runId).digest("hex").slice(0, 12)}`);
  const result = await writeAndRemoveProbe(path, `sol-luna Git metadata probe ${runId}\n`);
  return {
    declared: "write",
    status: result.status,
    gitDir: location.gitDir,
    headPath: location.headPath,
    indexPath: location.indexPath,
    probeDirectory: location.probeDirectory,
    probePath: path,
    error: result.error,
  };
}

function notRequiredEditAuthorityPreflight(declared: SolLunaEditAuthority): EditAuthorityPreflight {
  return {
    declared,
    status: declared === "read-only" ? "not_required" : "not_run",
    probePath: null,
    error: null,
  };
}

function notRequiredGitMetadataPreflight(declared: SolLunaGitMetadataAuthority): GitMetadataAuthorityPreflight {
  return {
    declared,
    status: declared === "none" ? "not_required" : "not_run",
    gitDir: null,
    headPath: null,
    indexPath: null,
    probeDirectory: null,
    probePath: null,
    error: null,
  };
}

async function committedChanges(
  repository: string,
  headBefore: string | null,
  headAfter: string | null,
  baselinePaths: readonly string[],
): Promise<GitAttribution> {
  if (headBefore === null || headAfter === null || headBefore === headAfter) {
    return { commitsMade: [], committedPaths: [] };
  }
  const [commitBytes, names] = await Promise.all([
    gitOutput(repository, ["rev-list", "--reverse", `${headBefore}..${headAfter}`]),
    gitOutput(repository, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      headBefore,
      headAfter,
      "--",
    ]),
  ]);
  return {
    commitsMade: utf8(commitBytes).split(/\r?\n/u).map((commit) => commit.trim()).filter((commit) => commit.length > 0),
    committedPaths: parseNamePaths(names).filter((path) => !baselinePaths.includes(path)),
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function configArgs(
  reasoningEffort: SolLunaReasoningEffort,
  environment: WorkerShellEnvironment,
): string[] {
  return [
    "--config",
    `model_reasoning_effort=${tomlString(reasoningEffort)}`,
    "--config",
    'shell_environment_policy.inherit="none"',
    "--config",
    `shell_environment_policy.set.PATH=${tomlString(SAFE_WORKER_PATH)}`,
    "--config",
    `shell_environment_policy.set.HOME=${tomlString(environment.home)}`,
    "--config",
    `shell_environment_policy.set.TMPDIR=${tomlString(environment.tmpdir)}`,
  ];
}

function commandShape(options: Required<SolLunaWorkerOptions>): SolLunaWorkerReceipt["child"]["commandShape"] {
  const environment = {
    home: "<worker-home>",
    tmpdir: "<worker-tmpdir>",
  };
  return {
    executable: CODEX_COMMAND,
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      CODEX_MODEL,
      ...configArgs(options.reasoningEffort, environment),
      "--sandbox",
      options.sandbox,
      "--cd",
      "<repository>",
      "--output-schema",
      "<output-schema>",
      "-",
    ],
    stdin: "canonical-brief",
    reasoningEffort: options.reasoningEffort,
    wallClockTimeoutMs: options.timeoutMs,
    shellEnvironment: {
      inherit: "none",
      path: SAFE_WORKER_PATH,
      home: environment.home,
      tmpdir: environment.tmpdir,
    },
  };
}

function childArgs(options: Required<SolLunaWorkerOptions>, environment: WorkerShellEnvironment): string[] {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--model",
    CODEX_MODEL,
    ...configArgs(options.reasoningEffort, environment),
    "--sandbox",
    options.sandbox,
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

function reportsChatGptAuthentication(capture: ProcessCapture): boolean {
  const output = `${utf8(capture.stdout)}\n${utf8(capture.stderr)}`;
  return capture.exitCode === 0
    && output.includes(CHATGPT_LOGIN_STATUS)
    && !/API key/iu.test(output);
}

export async function runSolLunaWorker(input: SolLunaWorkerOptions): Promise<SolLunaWorkerRun> {
  const options = normalizeOptions(input);
  await mkdir(options.outputDir, { recursive: true });

  const stdoutPath = resolve(options.outputDir, ARTIFACT_NAMES.stdout);
  const stderrPath = resolve(options.outputDir, ARTIFACT_NAMES.stderr);
  const workerResultPath = resolve(options.outputDir, ARTIFACT_NAMES.workerResult);
  const receiptPath = resolve(options.outputDir, ARTIFACT_NAMES.receipt);
  const workerEnvironment: WorkerShellEnvironment = {
    home: join(options.outputDir, ".worker-home"),
    tmpdir: join(options.outputDir, ".worker-tmp"),
  };
  await mkdir(workerEnvironment.home, { recursive: true });
  await mkdir(workerEnvironment.tmpdir, { recursive: true });

  const emptyBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let stdoutBytes = emptyBytes;
  let stderrBytes = emptyBytes;
  let workerResultBytes: Uint8Array | null = null;
  let workerResult: JsonObject | null = null;
  let harnessError: string | null = null;
  let headBefore: string | null = null;
  let headAfter: string | null = null;
  let baselineDirtyPaths: readonly string[] = [];
  let finalDirtyPaths: readonly string[] = [];
  let workerCreatedDirtyPaths: readonly string[] = [];
  let commitsMade: readonly string[] = [];
  let committedPaths: readonly string[] = [];
  let preflightExitCode: number | null = null;
  let preflightTimedOut = false;
  let chatGptAuthenticated = false;
  let childExitCode: number | null = null;
  let childTimedOut = false;
  let codexId: string | null = null;
  let threadId: string | null = null;
  let tokenUsage: Readonly<Record<string, number>> | null = null;
  let editAuthorityPreflight = notRequiredEditAuthorityPreflight(options.editAuthority);
  let gitMetadataAuthorityPreflight = notRequiredGitMetadataPreflight(options.gitMetadataAuthority);

  try {
    const [briefBytes, schemaBytes] = await Promise.all([
      readFile(options.brief),
      readFile(options.outputSchema),
    ]);
    if (schemaBytes.byteLength === 0) throw new Error("output schema file is empty");
    const schema = JSON.parse(schemaBytes.toString("utf8")) as unknown;
    if (jsonObject(schema) === null) throw new Error("output schema must contain a JSON object");

    try {
      const snapshot = await gitSnapshot(options.repository);
      headBefore = snapshot.head;
      baselineDirtyPaths = snapshot.paths;
    } catch (error) {
      harnessError = appendHarnessError(harnessError, `unable to read Git state: ${errorMessage(error)}`);
    }

    if (harnessError === null && options.editAuthority === "workspace-write") {
      try {
        editAuthorityPreflight = await probeEditAuthority(options.repository, options.runId);
        if (editAuthorityPreflight.status !== "passed") {
          harnessError = appendHarnessError(harnessError, `workspace edit authority preflight failed: ${editAuthorityPreflight.error ?? "probe failed"}`);
        }
      } catch (error) {
        editAuthorityPreflight = {
          declared: options.editAuthority,
          status: "failed",
          probePath: null,
          error: errorMessage(error),
        };
        harnessError = appendHarnessError(harnessError, `workspace edit authority preflight failed: ${errorMessage(error)}`);
      }
    }

    if (harnessError === null && options.gitMetadataAuthority === "write") {
      try {
        const location = await gitMetadataLocation(options.repository);
        gitMetadataAuthorityPreflight = await probeGitMetadataAuthority(location, options.runId);
        if (gitMetadataAuthorityPreflight.status !== "passed") {
          harnessError = appendHarnessError(harnessError, `Git metadata authority preflight failed: ${gitMetadataAuthorityPreflight.error ?? "probe failed"}`);
        }
      } catch (error) {
        gitMetadataAuthorityPreflight = {
          ...notRequiredGitMetadataPreflight("write"),
          status: "failed",
          error: errorMessage(error),
        };
        harnessError = appendHarnessError(harnessError, `Git metadata authority preflight failed: ${errorMessage(error)}`);
      }
    }

    if (harnessError === null) {
      try {
        const preflight = await captureProcess(
          [options.codexBin, "login", "status"],
          { env: codexEnvironment() },
        );
        preflightExitCode = preflight.exitCode;
        preflightTimedOut = preflight.timedOut;
        chatGptAuthenticated = reportsChatGptAuthentication(preflight);
        if (!chatGptAuthenticated) {
          harnessError = "Codex login status did not report ChatGPT authentication";
        }
      } catch (error) {
        harnessError = appendHarnessError(harnessError, `Codex authentication preflight failed: ${errorMessage(error)}`);
      }
    }

    if (harnessError === null) {
      try {
        const child = await captureProcess(
          [options.codexBin, ...childArgs(options, workerEnvironment)],
          { stdin: new Uint8Array(briefBytes), env: codexEnvironment(), timeoutMs: options.timeoutMs },
        );
        stdoutBytes = child.stdout;
        stderrBytes = child.stderr;
        childExitCode = child.exitCode;
        childTimedOut = child.timedOut;
        const events = parseJsonLines(utf8(stdoutBytes));
        codexId = findCodexId(events);
        threadId = codexId;
        tokenUsage = findTokenUsage(events);
        workerResult = findWorkerResult(events);
        if (workerResult !== null) {
          workerResultBytes = new TextEncoder().encode(`${JSON.stringify(workerResult, null, 2)}\n`);
        }
        if (!childTimedOut && childExitCode === 0 && workerResult === null) {
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
    const snapshot = await gitSnapshot(options.repository);
    headAfter = snapshot.head;
    finalDirtyPaths = snapshot.paths;
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read final Git state: ${errorMessage(error)}`);
  }

  workerCreatedDirtyPaths = finalDirtyPaths.filter((path) => !baselineDirtyPaths.includes(path));
  try {
    const attribution = await committedChanges(options.repository, headBefore, headAfter, baselineDirtyPaths);
    commitsMade = attribution.commitsMade;
    committedPaths = attribution.committedPaths;
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read committed Git changes: ${errorMessage(error)}`);
  }

  const changedPaths = [...new Set([...workerCreatedDirtyPaths, ...committedPaths])].sort();
  const artifacts: SolLunaWorkerReceipt["artifacts"] = {
    stdoutJsonl: artifact(stdoutPath, stdoutBytes),
    stderr: artifact(stderrPath, stderrBytes),
    finalWorkerResult: workerResultBytes === null ? null : artifact(workerResultPath, workerResultBytes),
  };

  try {
    await writeFile(stdoutPath, stdoutBytes);
    await writeFile(stderrPath, stderrBytes);
    if (workerResultBytes !== null) await writeFile(workerResultPath, workerResultBytes);
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to retain worker artifacts: ${errorMessage(error)}`);
  }

  const outcome: SolLunaWorkerReceipt["child"]["outcome"] = childTimedOut
    ? "worker_timed_out"
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
    preflight: {
      command: preflightShape(),
      exitCode: preflightExitCode,
      timedOut: preflightTimedOut,
      chatGptAuthenticated,
      editAuthority: editAuthorityPreflight,
      gitMetadataAuthority: gitMetadataAuthorityPreflight,
    },
    git: {
      headBefore,
      headAfter,
      baselineDirtyPaths,
      workerCreatedDirtyPaths,
      commitsMade,
      committedPaths,
      finalDirtyPaths,
      changedPaths,
    },
    child: {
      commandShape: commandShape(options),
      exitCode: childExitCode,
      timedOut: childTimedOut,
      wallClockTimeoutMs: options.timeoutMs,
      outcome,
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
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    throw new Error(`unable to write receipt at ${receiptPath}: ${errorMessage(error)}`);
  }

  return {
    receipt,
    receiptPath,
    exitCode: receipt.success ? 0 : childTimedOut
      ? 124
      : childExitCode !== null && childExitCode !== 0 && harnessError === null
        ? childExitCode
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
  readonly editAuthority?: SolLunaEditAuthority;
  readonly gitMetadataAuthority?: SolLunaGitMetadataAuthority;
  readonly reasoningEffort?: SolLunaReasoningEffort;
  readonly timeoutMs?: number;
  readonly codexBin?: string;
}

function usage(): string {
  return [
    "Usage: bun scripts/sol-luna-worker.ts --repository PATH --brief FILE --output-schema FILE",
    "  --output-dir DIR --run-id ID --assigned-role ROLE [--sandbox read-only|workspace-write]",
    "  [--edit-authority read-only|workspace-write] [--git-metadata-authority none|write]",
    "  [--reasoning-effort low|medium|high|xhigh|max] [--timeout-ms MS] [--codex-bin PATH]",
  ].join("\n");
}

function parseCli(argv: readonly string[]): ParsedCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") throw new Error(usage());
    if (key === undefined || !key.startsWith("--")) throw new Error(`invalid argument ${key ?? "missing"}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    const name = key.slice(2);
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
  const editAuthority = values.get("edit-authority");
  if (editAuthority !== undefined && !isEditAuthority(editAuthority)) throw new Error("--edit-authority must be read-only or workspace-write");
  const gitMetadataAuthority = values.get("git-metadata-authority");
  if (gitMetadataAuthority !== undefined && !isGitMetadataAuthority(gitMetadataAuthority)) throw new Error("--git-metadata-authority must be none or write");
  const reasoningEffort = values.get("reasoning-effort");
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) throw new Error("--reasoning-effort must be low, medium, high, xhigh, or max");
  const timeoutValue = values.get("timeout-ms");
  let timeoutMs: number | undefined;
  if (timeoutValue !== undefined) {
    const parsedTimeoutMs = Number(timeoutValue);
    if (!Number.isFinite(parsedTimeoutMs) || parsedTimeoutMs <= 0) throw new Error("--timeout-ms must be a positive finite number");
    timeoutMs = parsedTimeoutMs;
  }
  const known = new Set([...required, "sandbox", "edit-authority", "git-metadata-authority", "reasoning-effort", "timeout-ms", "codex-bin"]);
  for (const key of values.keys()) {
    if (!known.has(key)) throw new Error(`unknown argument --${key}`);
  }

  return {
    repository: values.get("repository") as string,
    brief: values.get("brief") as string,
    outputSchema: values.get("output-schema") as string,
    outputDir: values.get("output-dir") as string,
    runId: values.get("run-id") as string,
    assignedRole: values.get("assigned-role") as string,
    sandbox,
    ...(editAuthority === undefined ? {} : { editAuthority }),
    ...(gitMetadataAuthority === undefined ? {} : { gitMetadataAuthority }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    codexBin: values.get("codex-bin"),
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
