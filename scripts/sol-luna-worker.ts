import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CODEX_COMMAND = "codex";
const CODEX_MODEL = "gpt-5.6-luna";
const CODEX_REASONING_CONFIG = 'model_reasoning_effort="max"';
const CHATGPT_LOGIN_STATUS = "Logged in using ChatGPT";
const RECEIPT_SCHEMA_VERSION = "sol-luna-worker-receipt/1" as const;
const ARTIFACT_NAMES = {
  stdout: "stdout.jsonl",
  stderr: "stderr.log",
  workerResult: "worker-result.json",
  receipt: "receipt.json",
} as const;

export type SolLunaSandbox = "read-only" | "workspace-write";

export interface SolLunaWorkerOptions {
  readonly repository: string;
  readonly brief: string;
  readonly outputSchema: string;
  readonly outputDir: string;
  readonly runId: string;
  readonly assignedRole: string;
  readonly sandbox?: SolLunaSandbox;
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
    readonly chatGptAuthenticated: boolean;
  };
  readonly git: {
    readonly headBefore: string | null;
    readonly headAfter: string | null;
    readonly changedPaths: readonly string[];
  };
  readonly child: {
    readonly commandShape: {
      readonly executable: "codex";
      readonly args: readonly string[];
      readonly stdin: "canonical-brief";
    };
    readonly exitCode: number | null;
    readonly outcome: "not_started" | "worker_succeeded" | "worker_failed" | "harness_failed";
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
}

interface GitSnapshot {
  readonly head: string;
  readonly paths: readonly string[];
}

type JsonObject = Record<string, unknown>;

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function normalizeOptions(input: SolLunaWorkerOptions): Required<SolLunaWorkerOptions> {
  const sandbox = input.sandbox ?? "read-only";
  if (sandbox !== "read-only" && sandbox !== "workspace-write") {
    throw new Error("sandbox must be read-only or workspace-write");
  }
  return {
    repository: resolve(requireText(input.repository, "repository")),
    brief: resolve(requireText(input.brief, "brief")),
    outputSchema: resolve(requireText(input.outputSchema, "output schema")),
    outputDir: resolve(requireText(input.outputDir, "output directory")),
    runId: requireText(input.runId, "run ID"),
    assignedRole: requireText(input.assignedRole, "assigned role"),
    sandbox,
    codexBin: requireText(input.codexBin ?? CODEX_COMMAND, "Codex executable"),
  };
}

function codexEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  return environment;
}

async function captureProcess(
  command: readonly string[],
  options: { readonly stdin?: Uint8Array; readonly env?: Record<string, string> } = {},
): Promise<ProcessCapture> {
  const child = Bun.spawn([...command], {
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.env === undefined ? {} : { env: options.env }),
  });

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
  };
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
  const result = await captureProcess(["git", "-C", repository, ...args]);
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

async function committedChangedPaths(
  repository: string,
  headBefore: string | null,
  headAfter: string | null,
): Promise<string[]> {
  if (headBefore === null || headAfter === null || headBefore === headAfter) return [];
  const names = await gitOutput(repository, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    headBefore,
    headAfter,
    "--",
  ]);
  return parseNamePaths(names);
}

function commandShape(sandbox: SolLunaSandbox): SolLunaWorkerReceipt["child"]["commandShape"] {
  return {
    executable: CODEX_COMMAND,
    args: [
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      CODEX_MODEL,
      "--config",
      CODEX_REASONING_CONFIG,
      "--sandbox",
      sandbox,
      "--cd",
      "<repository>",
      "--output-schema",
      "<output-schema>",
      "-",
    ],
    stdin: "canonical-brief",
  };
}

function childArgs(options: Required<SolLunaWorkerOptions>): string[] {
  return [
    "exec",
    "--ephemeral",
    "--json",
    "--model",
    CODEX_MODEL,
    "--config",
    CODEX_REASONING_CONFIG,
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
  const emptyBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let stdoutBytes = emptyBytes;
  let stderrBytes = emptyBytes;
  let workerResultBytes: Uint8Array | null = null;
  let workerResult: JsonObject | null = null;
  let harnessError: string | null = null;
  let headBefore: string | null = null;
  let headAfter: string | null = null;
  let beforePaths: readonly string[] = [];
  let afterPaths: readonly string[] = [];
  let committedPaths: readonly string[] = [];
  let preflightExitCode: number | null = null;
  let chatGptAuthenticated = false;
  let childExitCode: number | null = null;
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
      const snapshot = await gitSnapshot(options.repository);
      headBefore = snapshot.head;
      beforePaths = snapshot.paths;
    } catch (error) {
      harnessError = appendHarnessError(harnessError, `unable to read Git state: ${errorMessage(error)}`);
    }

    if (harnessError === null) {
      try {
        const preflight = await captureProcess(
          [options.codexBin, "login", "status"],
          { env: codexEnvironment() },
        );
        preflightExitCode = preflight.exitCode;
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
          [options.codexBin, ...childArgs(options)],
          { stdin: new Uint8Array(briefBytes), env: codexEnvironment() },
        );
        stdoutBytes = child.stdout;
        stderrBytes = child.stderr;
        childExitCode = child.exitCode;
        const events = parseJsonLines(utf8(stdoutBytes));
        codexId = findCodexId(events);
        threadId = codexId;
        tokenUsage = findTokenUsage(events);
        workerResult = findWorkerResult(events);
        if (workerResult !== null) {
          workerResultBytes = new TextEncoder().encode(`${JSON.stringify(workerResult, null, 2)}\n`);
        }
        if (childExitCode === 0 && workerResult === null) {
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
    afterPaths = snapshot.paths;
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read final Git state: ${errorMessage(error)}`);
  }

  try {
    committedPaths = await committedChangedPaths(options.repository, headBefore, headAfter);
  } catch (error) {
    harnessError = appendHarnessError(harnessError, `unable to read committed Git changes: ${errorMessage(error)}`);
  }

  const changedPaths = [...new Set([...beforePaths, ...afterPaths, ...committedPaths])].sort();
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

  const outcome: SolLunaWorkerReceipt["child"]["outcome"] = childExitCode !== null && childExitCode !== 0
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
      chatGptAuthenticated,
    },
    git: {
      headBefore,
      headAfter,
      changedPaths,
    },
    child: {
      commandShape: commandShape(options.sandbox),
      exitCode: childExitCode,
      outcome,
    },
    codex: {
      sessionOrThreadId: codexId,
      threadId,
      tokenUsage,
    },
    artifacts,
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
    exitCode: receipt.success ? 0 : childExitCode !== null && childExitCode !== 0 && harnessError === null
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
  readonly codexBin?: string;
}

function usage(): string {
  return [
    "Usage: bun scripts/sol-luna-worker.ts --repository PATH --brief FILE --output-schema FILE",
    "  --output-dir DIR --run-id ID --assigned-role ROLE [--sandbox read-only|workspace-write]",
    "  [--codex-bin PATH]",
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
  const known = new Set([...required, "sandbox", "codex-bin"]);
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
