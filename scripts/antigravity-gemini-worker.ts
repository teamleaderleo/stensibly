import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ANTIGRAVITY_AUTH_CLASS,
  ANTIGRAVITY_HARNESS,
  ANTIGRAVITY_MODEL,
  ANTIGRAVITY_PROVIDER,
  ANTIGRAVITY_REASONING_EFFORT,
  ANTIGRAVITY_RECEIPT_SCHEMA_VERSION,
  ANTIGRAVITY_RESULT_SCHEMA,
  ANTIGRAVITY_RESULT_SCHEMA_VERSION,
  type AntigravityEconomics,
  type AntigravityQuotaObservation,
  type AntigravityQuotaSnapshot,
  type AntigravityUsage,
  type AntigravityWorkerResult,
} from "./antigravity-gemini-worker-contract";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CAPTURE_CAP_BYTES = 8 * 1024 * 1024;
const MAX_BRIEF_BYTES = 2 * 1024 * 1024;
const MAX_ID_CHARS = 200;
const MAX_ERROR_CHARS = 1_000;
const QUOTA_CAPTURE_CAP_BYTES = 256 * 1024;
const KILL_GRACE_MS = 500;

export const ANTIGRAVITY_ARTIFACT_NAMES = {
  marker: ".antigravity-gemini-attempt",
  stdout: "stdout.jsonl",
  stderr: "stderr.txt",
  quotaBefore: "quota-before.txt",
  quotaAfter: "quota-after.txt",
  result: "worker-result.json",
  receipt: "receipt.json",
} as const;

type JsonObject = Record<string, unknown>;

export interface AntigravityWorkerOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeGeneration: number;
  readonly assignedRole?: string;
  readonly agyBin?: string;
  readonly timeoutMs?: number;
  readonly captureCapBytes?: number;
  readonly attempt?: number;
}

export interface AntigravityStreamArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly fullOutputBytes: number;
  readonly omittedBytes: number;
}

export interface AntigravityArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface CommandCapture {
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutFullBytes: number;
  readonly stderrFullBytes: number;
  readonly spawnError: string | null;
  readonly wallTimeMs: number;
}

interface GitSnapshot {
  readonly head: string | null;
  readonly tree: string | null;
  readonly dirtyPaths: readonly string[];
  readonly clean: boolean;
}

export interface ParsedAntigravityOutput {
  readonly conversationId: string | null;
  readonly status: string | null;
  readonly error: string | null;
  readonly response: string | null;
  readonly result: AntigravityWorkerResult | null;
  readonly usage: AntigravityUsage;
  readonly durationSeconds: number | null;
  readonly turns: number | null;
  readonly stepCount: number;
  readonly agentStepCount: number;
  readonly toolStepCount: number;
  readonly subagentCount: number;
  readonly toolCounts: Readonly<Record<string, number>>;
  readonly init: {
    readonly model: string | null;
    readonly permissionMode: string | null;
    readonly tools: readonly string[];
  } | null;
}

export interface AntigravityWorkerReceipt {
  readonly schemaVersion: typeof ANTIGRAVITY_RECEIPT_SCHEMA_VERSION;
  readonly run: {
    readonly id: string;
    readonly attempt: number;
    readonly assignedRole: string;
  };
  readonly brief: {
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly node: {
    readonly id: string;
    readonly generation: number;
    readonly fleetPrimaryNode: "big-red";
  };
  readonly source: {
    readonly repositoryIdentity: string | null;
    readonly headBefore: string | null;
    readonly treeBefore: string | null;
    readonly headAfter: string | null;
    readonly treeAfter: string | null;
    readonly headRelationship: "unchanged" | "descendant" | "non_descendant" | "unknown";
    readonly cleanBefore: boolean;
    readonly cleanAfter: boolean;
    readonly dirtyPathsBefore: readonly string[];
    readonly dirtyPathsAfter: readonly string[];
    readonly changedPaths: readonly string[];
  };
  readonly harness: {
    readonly provider: typeof ANTIGRAVITY_PROVIDER;
    readonly name: typeof ANTIGRAVITY_HARNESS;
    readonly version: string | null;
    readonly authClass: typeof ANTIGRAVITY_AUTH_CLASS;
    readonly model: typeof ANTIGRAVITY_MODEL;
    readonly reasoningEffort: typeof ANTIGRAVITY_REASONING_EFFORT;
    readonly binary: string;
    readonly modelAvailable: boolean;
    readonly accountSessionReady: boolean;
  };
  readonly invocation: {
    readonly args: readonly string[];
    readonly promptTransport: "stdin-stream-json";
    readonly outputFormat: "stream-json";
    readonly structuredOutputSchema: typeof ANTIGRAVITY_RESULT_SCHEMA_VERSION;
    readonly sandbox: true;
    readonly dangerouslySkipPermissions: false;
    readonly timeoutMs: number;
    readonly environment: {
      readonly inherit: "allowlist";
      readonly keys: readonly string[];
      readonly apiKeyVariablesForwarded: false;
      readonly isolatedHome: true;
    };
    readonly effectivePermissionMode: string | null;
  };
  readonly child: {
    readonly exitCode: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly wallTimeMs: number;
    readonly outcome: "worker_succeeded" | "worker_failed" | "timeout" | "not_started";
  };
  readonly usage: AntigravityUsage;
  readonly activity: {
    readonly requests: number | null;
    readonly turns: number | null;
    readonly steps: number;
    readonly agentSteps: number;
    readonly toolSteps: number;
    readonly subagents: number;
    readonly toolCounts: Readonly<Record<string, number>>;
  };
  readonly quota: {
    readonly before: AntigravityQuotaSnapshot;
    readonly after: AntigravityQuotaSnapshot;
  };
  readonly workerResult: AntigravityWorkerResult | null;
  readonly provisional: {
    readonly acceptedOutcome: "unknown";
    readonly verificationOutcome: "unknown";
    readonly note: string;
  };
  readonly economics: AntigravityEconomics;
  readonly artifacts: {
    readonly stdoutJsonl: AntigravityStreamArtifact | null;
    readonly stderr: AntigravityStreamArtifact | null;
    readonly quotaBefore: AntigravityStreamArtifact | null;
    readonly quotaAfter: AntigravityStreamArtifact | null;
    readonly workerResult: AntigravityArtifact | null;
  };
  readonly success: boolean;
  readonly harnessError: string | null;
}

export interface AntigravityWorkerRun {
  readonly receipt: AntigravityWorkerReceipt;
  readonly receiptPath: string;
  readonly exitCode: number;
}

interface NormalizedOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeGeneration: number;
  readonly assignedRole: string;
  readonly agyBin: string;
  readonly timeoutMs: number;
  readonly captureCapBytes: number;
  readonly attempt: number;
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function boundedText(value: unknown, max = MAX_ERROR_CHARS): string | null {
  if (typeof value !== "string") return null;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function requireText(value: unknown, label: string, max = MAX_ID_CHARS): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string, fallback?: number): number {
  const candidate = value ?? fallback;
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 1)
    throw new Error(`${label} must be a positive integer`);
  return candidate;
}

function within(target: string, parent: string): boolean {
  const rel = relative(parent, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalProspectivePath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await realpath(dirname(absolute));
    return join(parent, absolute.slice(dirname(absolute).length + 1));
  }
}

async function normalizeOptions(input: AntigravityWorkerOptions): Promise<NormalizedOptions> {
  const repository = await realpath(resolve(input.repository));
  const brief = await realpath(resolve(input.brief));
  const outputDir = await canonicalProspectivePath(input.outputDir);
  if (!(await stat(repository)).isDirectory()) throw new Error("repository must be a directory");
  if (!(await stat(brief)).isFile()) throw new Error("brief must be a file");
  if ((await stat(brief)).size > MAX_BRIEF_BYTES) throw new Error("brief exceeds the size limit");
  if (within(outputDir, repository)) throw new Error("outputDir must be outside the admitted repository");
  return {
    repository,
    brief,
    outputDir,
    runId: requireText(input.runId, "runId"),
    nodeId: requireText(input.nodeId, "nodeId"),
    nodeGeneration: requirePositiveInteger(input.nodeGeneration, "nodeGeneration"),
    assignedRole: requireText(input.assignedRole ?? "implementation-worker", "assignedRole"),
    agyBin: resolve(input.agyBin ?? join(process.env.HOME ?? "", ".local/bin/agy")),
    timeoutMs: requirePositiveInteger(input.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS),
    captureCapBytes: requirePositiveInteger(
      input.captureCapBytes,
      "captureCapBytes",
      DEFAULT_CAPTURE_CAP_BYTES,
    ),
    attempt: requirePositiveInteger(input.attempt, "attempt", 1),
  };
}

function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function boundedAppend(
  chunks: Uint8Array[],
  chunk: Uint8Array,
  retained: number,
  cap: number,
): number {
  if (retained >= cap) return retained;
  const remaining = cap - retained;
  const keep = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(keep);
  return retained + keep.byteLength;
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

async function captureCommand(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stdin?: Uint8Array;
    readonly timeoutMs: number;
    readonly captureCapBytes: number;
  },
): Promise<CommandCapture> {
  const startedAt = performance.now();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command[0]!, command.slice(1), {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      command, exitCode: null, signal: null, timedOut: false,
      stdout: new Uint8Array(), stderr: new Uint8Array(),
      stdoutFullBytes: 0, stderrFullBytes: 0,
      spawnError: boundedText(error instanceof Error ? error.message : String(error)),
      wallTimeMs: Math.round(performance.now() - startedAt),
    };
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutRetained = 0;
  let stderrRetained = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    stdoutRetained = boundedAppend(stdoutChunks, chunk, stdoutRetained, options.captureCapBytes);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    stderrRetained = boundedAppend(stderrChunks, chunk, stderrRetained, options.captureCapBytes);
  });

  if (options.stdin) child.stdin.end(options.stdin);
  else child.stdin.end();

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killTree(child, "SIGTERM");
    setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
  }, options.timeoutMs);

  const result = await new Promise<{ exitCode: number | null; signal: string | null; spawnError: string | null }>(resolveResult => {
    let spawnError: string | null = null;
    child.once("error", error => { spawnError = boundedText(error.message); });
    child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal, spawnError }));
  });
  clearTimeout(timeout);
  return {
    command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut,
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    stdoutFullBytes: stdoutBytes,
    stderrFullBytes: stderrBytes,
    spawnError: result.spawnError,
    wallTimeMs: Math.round(performance.now() - startedAt),
  };
}

export const ANTIGRAVITY_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

export function antigravityEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ANTIGRAVITY_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.LANG ??= "C.UTF-8";
  environment.LC_ALL ??= "C.UTF-8";
  return environment;
}

export function buildAntigravityArgs(): readonly string[] {
  return [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--model", ANTIGRAVITY_MODEL,
    "--effort", ANTIGRAVITY_REASONING_EFFORT,
    "--mode", "accept-edits",
    "--sandbox",
    "--disable-slash-commands",
    "--json-schema", JSON.stringify(ANTIGRAVITY_RESULT_SCHEMA),
  ];
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stringArray(value: unknown, maxItems: number, maxChars: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > maxChars) return null;
    output.push(item);
  }
  return output;
}

function parseWorkerResult(value: unknown): AntigravityWorkerResult | null {
  const object = jsonObject(value);
  if (!object || !["complete", "partial", "blocked"].includes(String(object.status))) return null;
  const summary = boundedText(object.summary, 4_000);
  const changedPaths = stringArray(object.changed_paths, 100, 400);
  const verificationAttempts = stringArray(object.verification_attempts, 100, 500);
  const remainingLimits = stringArray(object.remaining_limits, 100, 500);
  if (summary === null || changedPaths === null || verificationAttempts === null || remainingLimits === null)
    return null;
  return {
    status: object.status as AntigravityWorkerResult["status"],
    summary,
    changedPaths,
    verificationAttempts,
    remainingLimits,
  };
}

export function parseAntigravityStream(stdout: string): ParsedAntigravityOutput {
  let init: ParsedAntigravityOutput["init"] = null;
  let terminal: JsonObject | null = null;
  const doneSteps = new Map<number, JsonObject>();
  const subagents = new Set<string>();
  const toolCounts: Record<string, number> = {};

  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let event: JsonObject | null = null;
    try { event = jsonObject(JSON.parse(line)); } catch { continue; }
    if (!event) continue;
    if (event.event === "init") {
      const value = jsonObject(event.init);
      init = value ? {
        model: boundedText(value.model, 200),
        permissionMode: boundedText(value.permission_mode, 100),
        tools: stringArray(value.tools, 200, 200) ?? [],
      } : null;
    }
    if (event.event === "step_update") {
      const step = jsonObject(event.step_update);
      const index = nonnegativeInteger(step?.step_index);
      if (step && index !== null && step.state === "DONE") doneSteps.set(index, step);
      const info = jsonObject(step?.subagent_info);
      const list = Array.isArray(info?.subagents) ? info.subagents : [];
      for (const entry of list) {
        const candidate = jsonObject(entry)?.conversation_id;
        if (typeof candidate === "string") subagents.add(candidate);
      }
    }
    if (event.event === "result") terminal = jsonObject(event.result);
  }

  for (const step of doneSteps.values()) {
    if (step.step_type !== "tool") continue;
    const name = boundedText(step.tool_name, 200) ?? "unknown";
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
  }
  const usage = jsonObject(terminal?.usage);
  return {
    conversationId: boundedText(terminal?.conversation_id, 200),
    status: boundedText(terminal?.status, 100),
    error: boundedText(terminal?.error),
    response: boundedText(terminal?.response, 8_000),
    result: parseWorkerResult(terminal?.structured_output),
    usage: {
      inputTokens: nonnegativeInteger(usage?.input_tokens),
      cachedInputTokens: nonnegativeInteger(usage?.cache_read_tokens),
      outputTokens: nonnegativeInteger(usage?.output_tokens),
      reasoningTokens: nonnegativeInteger(usage?.thinking_tokens),
      totalRecordedTokens: nonnegativeInteger(usage?.total_tokens),
    },
    durationSeconds: finiteNumber(terminal?.duration_seconds),
    turns: nonnegativeInteger(terminal?.num_turns),
    stepCount: doneSteps.size,
    agentStepCount: [...doneSteps.values()].filter(step => step.step_type === "agent_response").length,
    toolStepCount: [...doneSteps.values()].filter(step => step.step_type === "tool").length,
    subagentCount: subagents.size,
    toolCounts,
    init,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function quotaWindow(line: string): Pick<AntigravityQuotaObservation, "windowClass" | "windowMinutes"> {
  if (/\b(?:5|five)[ -]?hour\b|\b300\s*(?:m|min|minutes)\b/iu.test(line))
    return { windowClass: "five_hour", windowMinutes: 300 };
  if (/\bweek(?:ly)?\b|\b7[ -]?day\b|\b10080\s*(?:m|min|minutes)\b/iu.test(line))
    return { windowClass: "weekly", windowMinutes: 10_080 };
  return { windowClass: "unknown", windowMinutes: null };
}

function isoFromLine(line: string): string | null {
  const match = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/u);
  if (!match) return null;
  const parsed = Date.parse(match[0]);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseQuotaText(
  text: string,
  observedAt: string,
  commandSucceeded = true,
): AntigravityQuotaSnapshot {
  const clean = stripAnsi(text).replace(/\r/gu, "");
  const observations: AntigravityQuotaObservation[] = [];
  for (const line of clean.split("\n").slice(0, 500)) {
    if (!line.includes("%")) continue;
    const percent = line.match(/\b(100|\d{1,2})(?:\.(\d+))?\s*%\s*(used|remaining|left)?/iu);
    if (!percent) continue;
    const value = Number(`${percent[1]}${percent[2] ? `.${percent[2]}` : ""}`);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    const qualifier = percent[3]?.toLowerCase() ?? "";
    const modelMatch = line.match(/\b(?:Gemini|Claude|GPT)[A-Za-z0-9 .()_-]{0,80}/u);
    observations.push({
      model: modelMatch?.[0].trim() ?? null,
      ...quotaWindow(line),
      usedPercent: qualifier === "used" ? value : null,
      remainingPercent: qualifier === "remaining" || qualifier === "left" ? value : null,
      resetsAt: isoFromLine(line),
    });
  }
  const sourceSha256 = clean === "" ? null : sha256(clean);
  const generation = observations.length === 0
    ? null
    : sha256(JSON.stringify(observations.map(item => ({
        model: item.model,
        windowClass: item.windowClass,
        windowMinutes: item.windowMinutes,
        resetsAt: item.resetsAt,
      }))));
  return {
    observedAt,
    commandSucceeded,
    parseState: !commandSucceeded
      ? "unavailable"
      : observations.length > 0
        ? "recorded"
        : /quota|usage|limit/iu.test(clean)
          ? "not_exposed"
          : "unrecognized",
    generation,
    sourceSha256,
    observations,
  };
}

function quotaUsedPercent(observation: AntigravityQuotaObservation): number | null {
  if (observation.usedPercent !== null) return observation.usedPercent;
  if (observation.remainingPercent !== null) return 100 - observation.remainingPercent;
  return null;
}

export function quotaDelta(
  before: AntigravityQuotaSnapshot,
  after: AntigravityQuotaSnapshot,
  windowClass: "five_hour" | "weekly",
): number | null {
  const left = before.observations.find(item => item.windowClass === windowClass);
  const right = after.observations.find(item => item.windowClass === windowClass);
  if (!left || !right) return null;
  if (left.resetsAt !== null && right.resetsAt !== null && left.resetsAt !== right.resetsAt) return null;
  const leftUsed = quotaUsedPercent(left);
  const rightUsed = quotaUsedPercent(right);
  if (leftUsed === null || rightUsed === null || rightUsed < leftUsed) return null;
  return Math.round((rightUsed - leftUsed) * 1_000) / 1_000;
}

function emptyEconomics(
  before: AntigravityQuotaSnapshot,
  after: AntigravityQuotaSnapshot,
): AntigravityEconomics {
  return {
    acceptedOutcome: "unknown",
    verificationOutcome: "unknown",
    fiveHourQuotaDeltaPercent: quotaDelta(before, after, "five_hour"),
    weeklyQuotaDeltaPercent: quotaDelta(before, after, "weekly"),
    acceptedTasksPerFiveHourQuotaPercent: null,
    acceptedTasksPerWeeklyQuotaPercent: null,
    acceptedTasksPerSubscriptionDollar: null,
    acceptedTasksPerWallClockHourPerQuotaPercent: null,
    tokensPerAcceptedTask: null,
    operatorMinutesPerAcceptedTask: null,
    operatorInterventionMinutes: null,
    retries: 0,
    cleanupOrRework: "unknown",
  };
}

async function gitCapture(repository: string, args: readonly string[]): Promise<CommandCapture> {
  return captureCommand(["git", "-C", repository, ...args], {
    cwd: repository,
    env: antigravityEnvironment(),
    timeoutMs: 30_000,
    captureCapBytes: 1024 * 1024,
  });
}

async function gitText(
  repository: string,
  args: readonly string[],
  trim = true,
): Promise<string | null> {
  const capture = await gitCapture(repository, args);
  if (capture.exitCode !== 0 || capture.timedOut || capture.spawnError) return null;
  const output = new TextDecoder().decode(capture.stdout);
  return trim ? output.trim() : output;
}

async function gitSnapshot(repository: string): Promise<GitSnapshot> {
  const [head, tree, statusText] = await Promise.all([
    gitText(repository, ["rev-parse", "HEAD"]),
    gitText(repository, ["rev-parse", "HEAD^{tree}"]),
    gitText(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], false),
  ]);
  const dirtyPaths = statusText === null || statusText === ""
    ? []
    : [...new Set(statusText.split("\0").filter(Boolean).map(entry => entry.slice(3)))].sort();
  return { head, tree, dirtyPaths, clean: dirtyPaths.length === 0 };
}

async function repositoryIdentity(repository: string): Promise<string | null> {
  const remote = await gitText(repository, ["remote", "get-url", "origin"]);
  if (!remote) return null;
  const match = remote.match(/(?:github\.com[/:])([^/\s]+\/[^/\s]+?)(?:\.git)?$/iu);
  return match?.[1]?.replace(/\.git$/u, "").toLowerCase() ?? null;
}

async function headRelationship(
  repository: string,
  before: string | null,
  after: string | null,
): Promise<AntigravityWorkerReceipt["source"]["headRelationship"]> {
  if (!before || !after) return "unknown";
  if (before === after) return "unchanged";
  const capture = await gitCapture(repository, ["merge-base", "--is-ancestor", before, after]);
  if (capture.exitCode === 0) return "descendant";
  if (capture.exitCode === 1) return "non_descendant";
  return "unknown";
}

async function changedPaths(
  repository: string,
  before: GitSnapshot,
  after: GitSnapshot,
): Promise<readonly string[]> {
  const paths = new Set([...before.dirtyPaths, ...after.dirtyPaths]);
  if (before.head && after.head && before.head !== after.head) {
    const committed = await gitText(repository, ["diff", "--name-only", "-z", before.head, after.head]);
    for (const path of committed?.split("\0").filter(Boolean) ?? []) paths.add(path);
  }
  return [...paths].sort();
}

async function publish(path: string, bytes: Uint8Array): Promise<AntigravityArtifact> {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function publishCapture(
  path: string,
  bytes: Uint8Array,
  fullBytes: number,
): Promise<AntigravityStreamArtifact> {
  const artifact = await publish(path, bytes);
  return {
    ...artifact,
    truncated: fullBytes > bytes.byteLength,
    fullOutputBytes: fullBytes,
    omittedBytes: Math.max(0, fullBytes - bytes.byteLength),
  };
}

function appendError(current: string | null, next: unknown): string {
  const message = boundedText(next instanceof Error ? next.message : String(next)) ?? "unknown error";
  return current ? `${current}; ${message}` : message;
}

function emptyQuota(observedAt: string): AntigravityQuotaSnapshot {
  return {
    observedAt,
    commandSucceeded: false,
    parseState: "unavailable",
    generation: null,
    sourceSha256: null,
    observations: [],
  };
}

function emptyParsed(): ParsedAntigravityOutput {
  return {
    conversationId: null, status: null, error: null, response: null, result: null,
    usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, totalRecordedTokens: null },
    durationSeconds: null, turns: null, stepCount: 0, agentStepCount: 0,
    toolStepCount: 0, subagentCount: 0, toolCounts: {}, init: null,
  };
}

function emptyCapture(command: readonly string[]): CommandCapture {
  return {
    command, exitCode: null, signal: null, timedOut: false,
    stdout: new Uint8Array(), stderr: new Uint8Array(),
    stdoutFullBytes: 0, stderrFullBytes: 0, spawnError: null, wallTimeMs: 0,
  };
}

export async function runAntigravityGeminiWorker(
  input: AntigravityWorkerOptions,
): Promise<AntigravityWorkerRun> {
  const options = await normalizeOptions(input);
  await mkdir(options.outputDir, { recursive: false, mode: 0o700 });
  await chmod(options.outputDir, 0o700);
  await publish(join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.marker), new TextEncoder().encode(`${options.runId}\n`));

  const runtimeHome = join(options.outputDir, ".agy-home");
  await mkdir(runtimeHome, { mode: 0o700 });
  const env = antigravityEnvironment({ ...process.env, HOME: runtimeHome });
  const briefBytes = await readFile(options.brief);
  const before = await gitSnapshot(options.repository);
  const identity = await repositoryIdentity(options.repository);
  let harnessError: string | null = before.head ? null : "unable to observe Git HEAD before worker";
  let version: string | null = null;
  let modelAvailable = false;
  let accountSessionReady = false;
  let quotaBefore = emptyQuota(new Date().toISOString());
  let quotaAfter = emptyQuota(new Date().toISOString());
  let workerCapture = emptyCapture([options.agyBin, ...buildAntigravityArgs()]);
  let parsed = emptyParsed();
  let stdoutArtifact: AntigravityStreamArtifact | null = null;
  let stderrArtifact: AntigravityStreamArtifact | null = null;
  let quotaBeforeArtifact: AntigravityStreamArtifact | null = null;
  let quotaAfterArtifact: AntigravityStreamArtifact | null = null;
  let resultArtifact: AntigravityArtifact | null = null;
  let workerStarted = false;

  const preflight = async (args: readonly string[], cap = QUOTA_CAPTURE_CAP_BYTES) =>
    captureCommand([options.agyBin, ...args], {
      cwd: options.repository,
      env,
      timeoutMs: 60_000,
      captureCapBytes: cap,
    });

  try {
    const versionCapture = await preflight(["--version"], 16 * 1024);
    version = versionCapture.exitCode === 0
      ? new TextDecoder().decode(versionCapture.stdout).trim().slice(0, 100)
      : null;
    if (!version) harnessError = appendError(harnessError, "Antigravity version preflight failed");

    const modelsCapture = await preflight(["models"]);
    const models = new TextDecoder().decode(modelsCapture.stdout);
    modelAvailable = modelsCapture.exitCode === 0 && models.includes(ANTIGRAVITY_MODEL);
    accountSessionReady = modelsCapture.exitCode === 0;
    if (!accountSessionReady) harnessError = appendError(harnessError, "Google account subscription session is not ready");
    else if (!modelAvailable) harnessError = appendError(harnessError, `required model ${ANTIGRAVITY_MODEL} is unavailable`);

    if (harnessError === null) {
      const observedAt = new Date().toISOString();
      const capture = await preflight(["-p", "/usage", "--output-format", "text"]);
      const quotaText = new TextDecoder().decode(capture.stdout);
      quotaBefore = parseQuotaText(quotaText, observedAt, capture.exitCode === 0 && !capture.timedOut);
      quotaBeforeArtifact = await publishCapture(
        join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.quotaBefore),
        capture.stdout,
        capture.stdoutFullBytes,
      );

      const message = `${JSON.stringify({ event: "user", message: { content: briefBytes.toString("utf8") } })}\n`;
      workerStarted = true;
      workerCapture = await captureCommand([options.agyBin, ...buildAntigravityArgs()], {
        cwd: options.repository,
        env,
        stdin: new TextEncoder().encode(message),
        timeoutMs: options.timeoutMs,
        captureCapBytes: options.captureCapBytes,
      });
      parsed = parseAntigravityStream(new TextDecoder().decode(workerCapture.stdout));
      stdoutArtifact = await publishCapture(
        join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.stdout),
        workerCapture.stdout,
        workerCapture.stdoutFullBytes,
      );
      stderrArtifact = await publishCapture(
        join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.stderr),
        workerCapture.stderr,
        workerCapture.stderrFullBytes,
      );
      if (workerCapture.timedOut) harnessError = appendError(harnessError, "Antigravity worker timed out");
      if (workerCapture.spawnError) harnessError = appendError(harnessError, workerCapture.spawnError);
      if (workerCapture.exitCode !== 0 || workerCapture.signal !== null)
        harnessError = appendError(harnessError, `Antigravity worker process did not exit cleanly (exit ${workerCapture.exitCode ?? "unknown"}, signal ${workerCapture.signal ?? "none"})`);
      if (parsed.status !== "SUCCESS") harnessError = appendError(harnessError, parsed.error ?? `Antigravity status ${parsed.status ?? "unknown"}`);
      if (parsed.init?.model !== ANTIGRAVITY_MODEL)
        harnessError = appendError(harnessError, "Antigravity init did not confirm the pinned model");
      if (!["request-review", "proceed-in-sandbox", "strict"].includes(parsed.init?.permissionMode ?? ""))
        harnessError = appendError(harnessError, "Antigravity effective permission mode was not fail-closed");
      if (parsed.result === null) harnessError = appendError(harnessError, "Antigravity did not return the required structured result");
      if (parsed.result) {
        resultArtifact = await publish(
          join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.result),
          new TextEncoder().encode(`${JSON.stringify(parsed.result, null, 2)}\n`),
        );
      }

      const quotaObservedAt = new Date().toISOString();
      const afterCapture = await preflight(["-p", "/usage", "--output-format", "text"]);
      const afterText = new TextDecoder().decode(afterCapture.stdout);
      quotaAfter = parseQuotaText(afterText, quotaObservedAt, afterCapture.exitCode === 0 && !afterCapture.timedOut);
      quotaAfterArtifact = await publishCapture(
        join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.quotaAfter),
        afterCapture.stdout,
        afterCapture.stdoutFullBytes,
      );
    }
  } catch (error) {
    harnessError = appendError(harnessError, error);
  }

  try {
    await rm(runtimeHome, { recursive: true, force: true });
  } catch (error) {
    harnessError = appendError(harnessError, `unable to remove isolated Antigravity home: ${String(error)}`);
  }

  let after = await gitSnapshot(options.repository);
  if (!after.head) harnessError = appendError(harnessError, "unable to observe Git HEAD after worker");
  const relationship = await headRelationship(options.repository, before.head, after.head);
  const paths = await changedPaths(options.repository, before, after);
  const success = harnessError === null && parsed.status === "SUCCESS" && parsed.result !== null;
  const childOutcome = workerCapture.timedOut
    ? "timeout"
    : !workerStarted
      ? "not_started"
      : success
        ? "worker_succeeded"
        : "worker_failed";
  const economics = emptyEconomics(quotaBefore, quotaAfter);
  const receipt: AntigravityWorkerReceipt = {
    schemaVersion: ANTIGRAVITY_RECEIPT_SCHEMA_VERSION,
    run: { id: options.runId, attempt: options.attempt, assignedRole: options.assignedRole },
    brief: { sha256: sha256(briefBytes), bytes: briefBytes.byteLength },
    node: { id: options.nodeId, generation: options.nodeGeneration, fleetPrimaryNode: "big-red" },
    source: {
      repositoryIdentity: identity,
      headBefore: before.head,
      treeBefore: before.tree,
      headAfter: after.head,
      treeAfter: after.tree,
      headRelationship: relationship,
      cleanBefore: before.clean,
      cleanAfter: after.clean,
      dirtyPathsBefore: before.dirtyPaths,
      dirtyPathsAfter: after.dirtyPaths,
      changedPaths: paths,
    },
    harness: {
      provider: ANTIGRAVITY_PROVIDER,
      name: ANTIGRAVITY_HARNESS,
      version,
      authClass: ANTIGRAVITY_AUTH_CLASS,
      model: ANTIGRAVITY_MODEL,
      reasoningEffort: ANTIGRAVITY_REASONING_EFFORT,
      binary: options.agyBin,
      modelAvailable,
      accountSessionReady,
    },
    invocation: {
      args: buildAntigravityArgs(),
      promptTransport: "stdin-stream-json",
      outputFormat: "stream-json",
      structuredOutputSchema: ANTIGRAVITY_RESULT_SCHEMA_VERSION,
      sandbox: true,
      dangerouslySkipPermissions: false,
      timeoutMs: options.timeoutMs,
      environment: {
        inherit: "allowlist",
        keys: ANTIGRAVITY_ENVIRONMENT_KEYS.filter(key => env[key] !== undefined),
        apiKeyVariablesForwarded: false,
        isolatedHome: true,
      },
      effectivePermissionMode: parsed.init?.permissionMode ?? null,
    },
    child: {
      exitCode: workerCapture.exitCode,
      signal: workerCapture.signal,
      timedOut: workerCapture.timedOut,
      wallTimeMs: workerCapture.wallTimeMs,
      outcome: childOutcome,
    },
    usage: parsed.usage,
    activity: {
      requests: parsed.turns === null ? null : 1,
      turns: parsed.turns,
      steps: parsed.stepCount,
      agentSteps: parsed.agentStepCount,
      toolSteps: parsed.toolStepCount,
      subagents: parsed.subagentCount,
      toolCounts: parsed.toolCounts,
    },
    quota: { before: quotaBefore, after: quotaAfter },
    workerResult: parsed.result,
    provisional: {
      acceptedOutcome: "unknown",
      verificationOutcome: "unknown",
      note: "Worker completion grants no acceptance, publication, merge, or verification authority; Glaeda/Stensibly must settle the exact Git result.",
    },
    economics,
    artifacts: {
      stdoutJsonl: stdoutArtifact,
      stderr: stderrArtifact,
      quotaBefore: quotaBeforeArtifact,
      quotaAfter: quotaAfterArtifact,
      workerResult: resultArtifact,
    },
    success,
    harnessError,
  };
  const receiptPath = join(options.outputDir, ANTIGRAVITY_ARTIFACT_NAMES.receipt);
  await publish(receiptPath, new TextEncoder().encode(`${JSON.stringify(receipt, null, 2)}\n`));
  return { receipt, receiptPath, exitCode: success ? 0 : workerCapture.timedOut ? 124 : 1 };
}

function usage(): string {
  return [
    "Usage: bun scripts/antigravity-gemini-worker.ts",
    "  --repository PATH --brief PATH --output-dir PATH --run-id ID",
    "  --node-id ID --node-generation INTEGER",
    "  [--assigned-role ROLE] [--agy-bin PATH] [--timeout-ms INTEGER] [--capture-cap-bytes INTEGER] [--attempt INTEGER]",
  ].join("\n");
}

function parseCli(argv: readonly string[]): AntigravityWorkerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (key === "--help") throw new Error(usage());
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(usage());
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, value);
  }
  const required = ["--repository", "--brief", "--output-dir", "--run-id", "--node-id", "--node-generation"];
  for (const key of required) if (!values.has(key)) throw new Error(`missing ${key}\n${usage()}`);
  const known = new Set([...required, "--assigned-role", "--agy-bin", "--timeout-ms", "--capture-cap-bytes", "--attempt"]);
  for (const key of values.keys()) if (!known.has(key)) throw new Error(`unknown option: ${key}`);
  const integer = (key: string): number | undefined => {
    const value = values.get(key);
    if (value === undefined) return undefined;
    if (!/^\d+$/u.test(value)) throw new Error(`${key} must be an integer`);
    return Number(value);
  };
  return {
    repository: values.get("--repository")!,
    brief: values.get("--brief")!,
    outputDir: values.get("--output-dir")!,
    runId: values.get("--run-id")!,
    nodeId: values.get("--node-id")!,
    nodeGeneration: integer("--node-generation")!,
    ...(values.has("--assigned-role") ? { assignedRole: values.get("--assigned-role")! } : {}),
    ...(values.has("--agy-bin") ? { agyBin: values.get("--agy-bin")! } : {}),
    ...(values.has("--timeout-ms") ? { timeoutMs: integer("--timeout-ms")! } : {}),
    ...(values.has("--capture-cap-bytes") ? { captureCapBytes: integer("--capture-cap-bytes")! } : {}),
    ...(values.has("--attempt") ? { attempt: integer("--attempt")! } : {}),
  };
}

export async function runAntigravityCli(argv: readonly string[]): Promise<number> {
  try {
    const run = await runAntigravityGeminiWorker(parseCli(argv));
    console.log(JSON.stringify({ receipt: run.receiptPath, success: run.receipt.success }));
    return run.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === usage()) {
      console.log(message);
      return 0;
    }
    console.error(message);
    return 2;
  }
}

if (import.meta.main) process.exit(await runAntigravityCli(process.argv.slice(2)));
