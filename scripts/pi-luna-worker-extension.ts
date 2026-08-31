/**
 * The one reviewed extension loaded by scripts/pi-luna-worker.ts.
 *
 * This file intentionally has no runtime dependency on Pi. Pi loads it through
 * its TypeScript extension loader, while the runner and tests can import the
 * bounded operations directly. There is no shell-shaped model tool here.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { chmod, lstat, opendir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  PI_LUNA_EXTENSION_VERSION,
  PI_LUNA_RESULT_LIMITS,
  PI_LUNA_TOOL_NAMES,
  type PiLunaEditAuthority,
  type PiLunaExtensionConfig,
  type PiLunaOsBoundary,
  type PiLunaResult,
  type PiLunaResultStatus,
  type PiLunaVerificationCommand,
} from "./pi-luna-worker-contract.ts";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_PATH_CHARS = 400;
const MAX_QUERY_CHARS = 2_000;
const MAX_SEARCH_FILES = 2_000;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_EDIT_BYTES = 1_024 * 1_024;
const MAX_PATCH_BYTES = 128 * 1_024;
const KILL_ESCALATION_GRACE_MS = 250;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const SYSTEM_MOUNT_DIRS = ["/usr", "/bin", "/lib", "/lib64", "/etc"] as const;
const SHELL_EXECUTABLES = new Set(["ash", "bash", "cmd", "fish", "pwsh", "sh", "zsh"]);

type JsonSchema = Record<string, unknown>;

interface PiToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details?: unknown;
  readonly terminate?: boolean;
  readonly isError?: boolean;
}

interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly parameters: JsonSchema;
  readonly executionMode?: "sequential" | "parallel";
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<PiToolResult>;
}

interface ExtensionAPI {
  registerTool(tool: PiToolDefinition): void;
}

interface ToolCapture {
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
}

interface BoundedAccumulator {
  push(chunk: Uint8Array): void;
  snapshot(): { readonly data: Buffer; readonly fullBytes: number; readonly omittedBytes: number };
}

interface ResolvedRepositoryPath {
  readonly absolute: string;
  readonly relative: string;
  readonly exists: boolean;
}

interface ReadTextResult {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

interface ReadBytesResult {
  readonly data: Buffer;
  readonly truncated: boolean;
}

function pathIsWithin(target: string, parent: string): boolean {
  const difference = relative(parent, target);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").slice(0, 500);
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 32))}\n…[truncated]`;
}

function textResult(text: string, details?: unknown, isError = false): PiToolResult {
  return {
    content: [{ type: "text", text: clip(text, 8_000) }],
    ...(details === undefined ? {} : { details }),
    ...(isError ? { isError: true } : {}),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalStringValue(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label, maxLength);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
      fullBytes += bytes.length;
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

type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

function signalProcessTree(pid: number, child: CapturedChild, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process tree is already gone.
    }
  }
}

function captureProcess(
  command: readonly string[],
  options: {
    readonly env: Record<string, string>;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly captureCapBytes: number;
    readonly signal?: AbortSignal;
  },
): Promise<ToolCapture> {
  return new Promise<ToolCapture>((resolveCapture) => {
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
      });
      return;
    }
    let child: CapturedChild;
    try {
      child = spawn(command[0] ?? "", [...command.slice(1)], {
        cwd: options.cwd,
        detached: true,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
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
      });
      return;
    }

    const stdoutAccumulator = createBoundedAccumulator(options.captureCapBytes);
    const stderrAccumulator = createBoundedAccumulator(options.captureCapBytes);
    let exited = false;
    let exitCode: number | null = null;
    let termSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let aborted = false;
    let streamsOpen = 2;
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    const terminateTree = (): void => {
      if (child.pid === undefined) return;
      signalProcessTree(child.pid, child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!settled) signalProcessTree(child.pid!, child, "SIGKILL");
      }, KILL_ESCALATION_GRACE_MS);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateTree();
    }, options.timeoutMs);
    const abortHandler = (): void => {
      aborted = true;
      terminateTree();
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    const finish = (): void => {
      if (settled || !exited || streamsOpen > 0) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      const stdout = stdoutAccumulator.snapshot();
      const stderr = stderrAccumulator.snapshot();
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
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      options.signal?.removeEventListener("abort", abortHandler);
      const stdout = stdoutAccumulator.snapshot();
      const stderr = stderrAccumulator.snapshot();
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
      finish();
    });
  });
}

function systemEnvironment(config: PiLunaExtensionConfig): Record<string, string> {
  return {
    PATH: config.toolPath,
    HOME: config.toolHome,
    TMPDIR: config.toolTmpdir,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function addNamespaceParentDirs(args: string[], target: string): void {
  const parents: string[] = [];
  let current = dirname(target);
  while (current !== "/" && current.length > 0) {
    parents.push(current);
    current = dirname(current);
  }
  for (const parent of parents.reverse()) args.push("--dir", parent);
}

/** Build the nested Linux boundary used for every model-visible child process. */
export function buildNestedBubblewrapCommand(
  command: readonly string[],
  config: PiLunaExtensionConfig,
): readonly string[] {
  if (config.osBoundary !== "bwrap" || config.bwrapBin === null) return command;
  const args: string[] = [
    config.bwrapBin,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-net",
  ];
  for (const mount of SYSTEM_MOUNT_DIRS) args.push("--ro-bind", mount, mount);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  addNamespaceParentDirs(args, config.repository);
  args.push("--bind", config.repository, config.repository);
  for (const directory of config.verificationExecutableDirs) {
    addNamespaceParentDirs(args, directory);
    args.push("--ro-bind", directory, directory);
  }
  addNamespaceParentDirs(args, config.toolHome);
  addNamespaceParentDirs(args, config.toolTmpdir);
  args.push(
    "--dir", config.toolHome,
    "--dir", config.toolTmpdir,
    "--chdir", config.repository,
    "--clearenv",
  );
  for (const [key, value] of Object.entries(systemEnvironment(config))) args.push("--setenv", key, value);
  args.push("--", ...command);
  return args;
}

function effectiveCommand(
  command: readonly string[],
  config: PiLunaExtensionConfig,
): readonly string[] {
  return buildNestedBubblewrapCommand(command, config);
}

async function readBoundedBytes(path: string, cap: number): Promise<ReadBytesResult> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const information = await handle.stat();
    if (!information.isFile()) throw new Error("path is not a regular file");
    const buffer = Buffer.alloc(Math.min(cap + 1, Number.MAX_SAFE_INTEGER));
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    return { data: Buffer.from(buffer.subarray(0, Math.min(bytes, cap))), truncated: bytes > cap };
  } finally {
    await handle.close();
  }
}

async function readBoundedText(path: string, cap: number): Promise<ReadTextResult> {
  const result = await readBoundedBytes(path, cap);
  return {
    text: new TextDecoder().decode(result.data),
    bytes: result.data.byteLength,
    truncated: result.truncated,
  };
}

async function resolveExistingRepositoryRoot(repository: string): Promise<string> {
  const root = await realpath(repository);
  const information = await lstat(root);
  if (!information.isDirectory()) throw new Error("configured repository is not a directory");
  return root;
}

/**
 * Resolve a model-supplied repository path without following symlinks. Rejecting
 * symlink components is deliberately conservative and makes the guard stable
 * across both existing and prospective edit paths.
 */
export async function resolveRepositoryPath(
  repository: string,
  candidate: string,
  allowMissing = false,
): Promise<ResolvedRepositoryPath> {
  const root = await resolveExistingRepositoryRoot(repository);
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PATH_CHARS) {
    throw new Error("repository path must be a non-empty bounded string");
  }
  if (isAbsolute(candidate) || candidate.includes("\0") || candidate.includes("\\")) {
    throw new Error("repository paths must be relative POSIX paths without symlink escapes");
  }
  const components = candidate.split("/");
  let current = root;
  const stack: string[] = [];
  let exists = true;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    if (component === undefined || component.length === 0 || component === ".") continue;
    if (component === "..") {
      if (stack.length === 0) throw new Error("repository path escapes the repository");
      stack.pop();
      current = dirname(current);
      continue;
    }
    const next = join(current, component);
    try {
      const information = await lstat(next);
      if (information.isSymbolicLink()) throw new Error("symlink repository paths are rejected");
      const hasFollowingPath = components.slice(index + 1).some((part) => part.length > 0);
      if (hasFollowingPath && !information.isDirectory()) {
        throw new Error("repository path crosses a non-directory");
      }
      current = next;
      stack.push(component);
    } catch (error) {
      if (error instanceof Error && "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR") &&
        allowMissing && !components.slice(index + 1).some((part) => part.length > 0)) {
        current = next;
        exists = false;
        break;
      }
      throw error;
    }
  }
  if (!allowMissing && !exists) throw new Error("repository path does not exist");
  const canonical = resolve(current);
  if (!pathIsWithin(canonical, root)) throw new Error("repository path escapes the repository");
  return { absolute: canonical, relative: relative(root, canonical) || ".", exists };
}

async function regularFilePath(config: PiLunaExtensionConfig, candidate: unknown): Promise<ResolvedRepositoryPath> {
  const path = await resolveRepositoryPath(config.repository, stringValue(candidate, "path", MAX_PATH_CHARS));
  const information = await lstat(path.absolute);
  if (!information.isFile()) throw new Error("repository path is not a regular file");
  return path;
}

function resultArray(value: unknown, label: string, itemLimit: number, itemLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length > itemLimit) {
    throw new Error(`${label} must be an array of at most ${itemLimit} strings`);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(stringValue(value[index], `${label}[${index}]`, itemLength));
  }
  return result;
}

export function validateResult(value: unknown): PiLunaResult {
  const object = record(value, "result");
  const fields = new Set(["status", "summary", "changedPaths", "verification", "remainingLimits"]);
  for (const key of Object.keys(object)) {
    if (!fields.has(key)) throw new Error(`result has an unexpected field: ${key}`);
  }
  const status = stringValue(object.status, "result.status", 20);
  if (status !== "complete" && status !== "partial" && status !== "blocked") {
    throw new Error("result.status must be complete, partial, or blocked");
  }
  const summary = stringValue(object.summary, "result.summary", PI_LUNA_RESULT_LIMITS.summaryChars);
  const changedPaths = resultArray(
    object.changedPaths,
    "result.changedPaths",
    PI_LUNA_RESULT_LIMITS.listItems,
    PI_LUNA_RESULT_LIMITS.pathChars,
  );
  const verification = resultArray(
    object.verification,
    "result.verification",
    PI_LUNA_RESULT_LIMITS.listItems,
    PI_LUNA_RESULT_LIMITS.listItemChars,
  );
  const remainingLimits = resultArray(
    object.remainingLimits,
    "result.remainingLimits",
    PI_LUNA_RESULT_LIMITS.listItems,
    PI_LUNA_RESULT_LIMITS.listItemChars,
  );
  return { status: status as PiLunaResultStatus, summary, changedPaths, verification, remainingLimits };
}

async function verifyExpectedHash(path: string, expectedHash: string | undefined, cap: number): Promise<Buffer> {
  const content = await readBoundedBytes(path, cap);
  if (content.truncated) throw new Error(`existing file exceeds the ${cap}-byte edit bound`);
  const bytes = content.data;
  if (expectedHash !== undefined && expectedHash !== sha256(bytes)) {
    throw new Error("expectedSha256 does not match the current file");
  }
  return bytes;
}

async function atomicRepositoryWrite(path: string, content: Uint8Array): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.pi-luna-edit-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink()) throw new Error("edit target became a symlink");
      if (existing.isFile()) await chmod(temporaryPath, existing.mode & 0o777);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function executeRepositoryRead(
  config: PiLunaExtensionConfig,
  params: unknown,
): Promise<PiToolResult> {
  const object = record(params, "read parameters");
  const path = await regularFilePath(config, object.path);
  const startLine = boundedInteger(object.startLine, "startLine", 1, 1_000_000, 1);
  const maxLines = boundedInteger(object.maxLines, "maxLines", 1, 500, 100);
  const content = await readBoundedText(path.absolute, config.fileReadCapBytes);
  const lines = content.text.split(/\r?\n/u);
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  const output = selected
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
  return textResult(output || "(no lines)", {
    path: path.relative,
    startLine,
    lines: selected.length,
    truncated: content.truncated || startLine - 1 + maxLines < lines.length,
  });
}

interface SearchState {
  filesVisited: number;
  matches: number;
  output: string[];
  outputBytes: number;
  truncated: boolean;
}

function addSearchMatch(
  state: SearchState,
  rendered: string,
  maxResults: number,
  outputCapBytes: number,
): boolean {
  if (state.matches >= maxResults) {
    state.truncated = true;
    return false;
  }
  const renderedBytes = Buffer.byteLength(rendered, "utf8") + 1;
  if (state.outputBytes + renderedBytes > outputCapBytes) {
    state.truncated = true;
    return false;
  }
  state.output.push(rendered);
  state.outputBytes += renderedBytes;
  state.matches += 1;
  return true;
}

async function searchDirectory(
  config: PiLunaExtensionConfig,
  directory: ResolvedRepositoryPath,
  query: string,
  caseSensitive: boolean,
  maxResults: number,
  state: SearchState,
): Promise<void> {
  const handle = await opendir(directory.absolute);
  try {
    for await (const entry of handle) {
      if (state.filesVisited >= MAX_SEARCH_FILES || state.matches >= maxResults) {
        state.truncated = true;
        return;
      }
      if (entry.name === ".git") continue;
      const childCandidate = directory.relative === "." ? entry.name : `${directory.relative}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      const child = await resolveRepositoryPath(config.repository, childCandidate, false);
      if (entry.isDirectory()) {
        await searchDirectory(config, child, query, caseSensitive, maxResults, state);
        if (state.truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;
      state.filesVisited += 1;
      let content: ReadTextResult;
      try {
        content = await readBoundedText(child.absolute, Math.min(config.fileReadCapBytes, MAX_SEARCH_FILE_BYTES));
      } catch {
        continue;
      }
      if (content.truncated) {
        state.truncated = true;
        continue;
      }
      if (content.text.includes("\0")) continue;
      const needle = caseSensitive ? query : query.toLowerCase();
      const lines = content.text.split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const comparable = caseSensitive ? line : line.toLowerCase();
        if (!comparable.includes(needle)) continue;
        if (!addSearchMatch(state, `${child.relative}:${index + 1}: ${line}`, maxResults, config.toolOutputCapBytes)) return;
      }
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function executeRepositorySearch(
  config: PiLunaExtensionConfig,
  params: unknown,
): Promise<PiToolResult> {
  const object = record(params, "search parameters");
  const query = stringValue(object.query, "query", MAX_QUERY_CHARS);
  const caseSensitive = booleanValue(object.caseSensitive, "caseSensitive", true);
  const maxResults = boundedInteger(object.maxResults, "maxResults", 1, 100, 50);
  const start = object.path === undefined ? "." : stringValue(object.path, "path", MAX_PATH_CHARS);
  const root = await resolveRepositoryPath(config.repository, start, false);
  const state: SearchState = { filesVisited: 0, matches: 0, output: [], outputBytes: 0, truncated: false };
  const information = await lstat(root.absolute);
  if (information.isDirectory()) {
    await searchDirectory(config, root, query, caseSensitive, maxResults, state);
  } else if (information.isFile()) {
    state.filesVisited = 1;
    const content = await readBoundedText(root.absolute, Math.min(config.fileReadCapBytes, MAX_SEARCH_FILE_BYTES));
    if (content.truncated) state.truncated = true;
    if (!content.truncated && !content.text.includes("\0")) {
      const lines = content.text.split(/\r?\n/u);
      const needle = caseSensitive ? query : query.toLowerCase();
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const comparable = caseSensitive ? line : line.toLowerCase();
        if (comparable.includes(needle) &&
          !addSearchMatch(state, `${root.relative}:${index + 1}: ${line}`, maxResults, config.toolOutputCapBytes)) break;
      }
    }
  } else {
    throw new Error("search path is not a regular file or directory");
  }
  return textResult(state.output.join("\n") || "(no matches)", {
    query,
    path: root.relative,
    matches: state.matches,
    filesVisited: state.filesVisited,
    truncated: state.truncated,
  });
}

async function executeFixedGit(
  config: PiLunaExtensionConfig,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<PiToolResult> {
  const command = effectiveCommand(["git", "-c", "core.fsmonitor=false", ...args], config);
  const capture = await captureProcess(command, {
    cwd: config.repository,
    env: systemEnvironment(config),
    timeoutMs: config.toolTimeoutMs,
    captureCapBytes: config.toolOutputCapBytes,
    signal,
  });
  if (capture.spawnError !== null) return textResult(`Git failed to start: ${capture.spawnError}`, undefined, true);
  if (capture.aborted) return textResult("Git observation aborted", undefined, true);
  const stdout = new TextDecoder().decode(capture.stdout);
  const stderr = new TextDecoder().decode(capture.stderr);
  const text = [stdout, stderr ? `stderr: ${stderr}` : ""].filter((part) => part.length > 0).join("\n");
  return textResult(text || `(git exited ${capture.exitCode ?? "unknown"})`, {
    exitCode: capture.exitCode,
    signal: capture.signal,
    timedOut: capture.timedOut,
    truncated: capture.stdoutOmittedBytes > 0 || capture.stderrOmittedBytes > 0,
    stdoutBytes: capture.stdoutFullBytes,
    stderrBytes: capture.stderrFullBytes,
  }, capture.timedOut || capture.exitCode !== 0);
}

export async function executeRepositoryGit(
  config: PiLunaExtensionConfig,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<PiToolResult> {
  const object = record(params, "Git parameters");
  const action = stringValue(object.action, "action", 16);
  if (action === "history") {
    const limit = boundedInteger(object.limit, "limit", 1, 50, 20);
    const args = ["log", "--no-ext-diff", "--format=%h %ad %s", "--date=short", "-n", String(limit)];
    if (object.path !== undefined) {
      const path = await resolveRepositoryPath(config.repository, stringValue(object.path, "path", MAX_PATH_CHARS), false);
      args.push("--", path.relative);
    }
    return executeFixedGit(config, args, signal);
  }
  if (action === "status") {
    return executeFixedGit(config, ["status", "--short", "--branch", "--untracked-files=all"], signal);
  }
  if (action === "diff") {
    const args = ["diff", "--no-ext-diff", "--unified=3"];
    if (booleanValue(object.staged, "staged", false)) args.push("--cached");
    if (object.path !== undefined) {
      const path = await resolveRepositoryPath(config.repository, stringValue(object.path, "path", MAX_PATH_CHARS), false);
      args.push("--", path.relative);
    }
    return executeFixedGit(config, args, signal);
  }
  throw new Error("action must be history, status, or diff");
}

function expectedHash(value: unknown): string | undefined {
  const hash = optionalStringValue(value, "expectedSha256", 80);
  if (hash !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(hash)) {
    throw new Error("expectedSha256 must be sha256:<64 lowercase hex characters>");
  }
  return hash;
}

export async function executeRepositoryMutation(
  config: PiLunaExtensionConfig,
  params: unknown,
): Promise<PiToolResult> {
  if (config.editAuthority !== "workspace-write") return textResult("workspace edits are disabled", undefined, true);
  const object = record(params, "mutation parameters");
  const mode = stringValue(object.mode, "mode", 16);
  if (mode === "edit") {
    const path = await resolveRepositoryPath(config.repository, stringValue(object.path, "path", MAX_PATH_CHARS), true);
    const content = stringValue(object.content, "content", MAX_EDIT_BYTES);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.byteLength > MAX_EDIT_BYTES) throw new Error(`content exceeds the ${MAX_EDIT_BYTES}-byte bound`);
    if (path.exists) await verifyExpectedHash(path.absolute, expectedHash(object.expectedSha256), MAX_EDIT_BYTES);
    else if (object.expectedSha256 !== undefined) throw new Error("expectedSha256 cannot be used for a new file");
    await atomicRepositoryWrite(path.absolute, bytes);
    return textResult(`edited ${path.relative}`, { mode, path: path.relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  if (mode === "patch") {
    const path = await regularFilePath(config, object.path);
    const oldText = stringValue(object.oldText, "oldText", MAX_PATCH_BYTES);
    const newText = stringValue(object.newText, "newText", MAX_EDIT_BYTES);
    const original = await verifyExpectedHash(path.absolute, expectedHash(object.expectedSha256), MAX_EDIT_BYTES);
    const originalText = original.toString("utf8");
    const first = originalText.indexOf(oldText);
    if (first < 0) throw new Error("oldText was not found exactly");
    if (originalText.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error("oldText occurs more than once; use a narrower patch");
    }
    const updated = `${originalText.slice(0, first)}${newText}${originalText.slice(first + oldText.length)}`;
    const bytes = Buffer.from(updated, "utf8");
    if (bytes.byteLength > MAX_EDIT_BYTES) throw new Error(`patched file exceeds the ${MAX_EDIT_BYTES}-byte bound`);
    await atomicRepositoryWrite(path.absolute, bytes);
    return textResult(`patched ${path.relative}`, { mode, path: path.relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  throw new Error("mode must be edit or patch");
}

function findVerificationCommand(config: PiLunaExtensionConfig, commandId: unknown): PiLunaVerificationCommand {
  const id = stringValue(commandId, "commandId", 64);
  const command = config.verificationCommands.find((candidate) => candidate.id === id);
  if (command === undefined) throw new Error(`verification command is not declared: ${id}`);
  return command;
}

function commandName(argv: readonly string[]): string {
  return basename(argv[0] ?? "command");
}

/** Run only a coordinator-provided argv array, never a model-provided string. */
export async function executeVerification(
  config: PiLunaExtensionConfig,
  commandId: unknown,
  signal?: AbortSignal,
): Promise<PiToolResult> {
  const command = findVerificationCommand(config, commandId);
  const capture = await captureProcess(effectiveCommand(command.argv, config), {
    cwd: config.repository,
    env: systemEnvironment(config),
    timeoutMs: config.toolTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
    captureCapBytes: config.toolOutputCapBytes,
    signal,
  });
  if (capture.spawnError !== null) return textResult(`verification failed to start: ${capture.spawnError}`, { commandId: command.id }, true);
  if (capture.aborted) return textResult(`verification aborted: ${command.id}`, { commandId: command.id }, true);
  const stdout = new TextDecoder().decode(capture.stdout);
  const stderr = new TextDecoder().decode(capture.stderr);
  const output = [stdout, stderr ? `stderr: ${stderr}` : ""].filter((part) => part.length > 0).join("\n");
  const failed = capture.timedOut || capture.exitCode !== 0;
  return textResult(output || `(verification exited ${capture.exitCode ?? "unknown"})`, {
    commandId: command.id,
    executable: commandName(command.argv),
    exitCode: capture.exitCode,
    signal: capture.signal,
    timedOut: capture.timedOut,
    truncated: capture.stdoutOmittedBytes > 0 || capture.stderrOmittedBytes > 0,
    stdoutBytes: capture.stdoutFullBytes,
    stderrBytes: capture.stderrFullBytes,
  }, failed);
}

function schemaObject(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function stringSchema(description: string, maxLength: number): JsonSchema {
  return { type: "string", description, minLength: 1, maxLength };
}

function arraySchema(description: string, maxItems: number, maxLength: number): JsonSchema {
  return {
    type: "array",
    description,
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

function loadExtensionConfig(): PiLunaExtensionConfig {
  const configPath = process.env.PI_LUNA_CONFIG_PATH;
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error("PI_LUNA_CONFIG_PATH is required");
  }
  const raw = readFileSync(configPath);
  if (raw.byteLength > MAX_CONFIG_BYTES) throw new Error("Pi Luna extension configuration is too large");
  const object = record(JSON.parse(raw.toString("utf8")) as unknown, "extension configuration");
  if (object.schemaVersion !== PI_LUNA_EXTENSION_VERSION) throw new Error("unsupported Pi Luna extension configuration");
  const repository = stringValue(object.repository, "repository", 4_096);
  const editAuthority = stringValue(object.editAuthority, "editAuthority", 32);
  if (editAuthority !== "read-only" && editAuthority !== "workspace-write") throw new Error("invalid edit authority");
  const osBoundary = stringValue(object.osBoundary, "osBoundary", 16);
  if (osBoundary !== "bwrap" && osBoundary !== "none") throw new Error("invalid OS boundary");
  const commandsValue = object.verificationCommands;
  if (!Array.isArray(commandsValue) || commandsValue.length > 100) {
    throw new Error("verificationCommands must be a bounded array");
  }
  const verificationCommands: PiLunaVerificationCommand[] = commandsValue.map((value, index) => {
    const command = record(value, `verificationCommands[${index}]`);
    const id = stringValue(command.id, "verification command id", 64);
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(id)) throw new Error(`invalid verification command id: ${id}`);
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.length > 64) {
      throw new Error(`verification command ${id} must have a bounded argv array`);
    }
    const argv = command.argv.map((arg, argIndex) => stringValue(arg, `${id}.argv[${argIndex}]`, 4_096));
    if (SHELL_EXECUTABLES.has(basename(argv[0] ?? ""))) {
      throw new Error(`verification command ${id} may not invoke a shell executable`);
    }
    return { id, argv };
  });
  const ids = new Set<string>();
  for (const command of verificationCommands) {
    if (ids.has(command.id)) throw new Error(`duplicate verification command id: ${command.id}`);
    ids.add(command.id);
  }
  const dirsValue = object.verificationExecutableDirs;
  if (!Array.isArray(dirsValue) || dirsValue.length > 100) throw new Error("verificationExecutableDirs must be bounded");
  const verificationExecutableDirs = dirsValue.map((value, index) => {
    const directory = stringValue(value, `verificationExecutableDirs[${index}]`, 4_096);
    if (!isAbsolute(directory)) throw new Error("verification executable directories must be absolute");
    return directory;
  });
  const boundary = osBoundary as PiLunaOsBoundary;
  const bwrapBin = object.bwrapBin === null ? null : stringValue(object.bwrapBin, "bwrapBin", 4_096);
  if (boundary === "bwrap" && bwrapBin === null) throw new Error("bwrap boundary requires bwrapBin");
  return {
    schemaVersion: PI_LUNA_EXTENSION_VERSION,
    repository,
    editAuthority: editAuthority as PiLunaEditAuthority,
    toolOutputCapBytes: boundedInteger(object.toolOutputCapBytes, "toolOutputCapBytes", 2, 64 * 1024 * 1024, 64 * 1024),
    fileReadCapBytes: boundedInteger(object.fileReadCapBytes, "fileReadCapBytes", 2, 4 * 1024 * 1024, 256 * 1024),
    toolTimeoutMs: boundedInteger(object.toolTimeoutMs, "toolTimeoutMs", 1, 600_000, DEFAULT_TOOL_TIMEOUT_MS),
    osBoundary: boundary,
    bwrapBin,
    toolPath: stringValue(object.toolPath, "toolPath", 8_192),
    toolHome: stringValue(object.toolHome, "toolHome", 4_096),
    toolTmpdir: stringValue(object.toolTmpdir, "toolTmpdir", 4_096),
    verificationExecutableDirs,
    verificationCommands,
  };
}

function toolError(error: unknown): PiToolResult {
  return textResult(errorMessage(error), undefined, true);
}

function registerToolSafely(pi: ExtensionAPI, tool: PiToolDefinition): void {
  pi.registerTool(tool);
}

export function registerPiLunaTools(pi: ExtensionAPI, config: PiLunaExtensionConfig): void {
  const pathProperty = stringSchema("Repository-relative path", MAX_PATH_CHARS);
  registerToolSafely(pi, {
    name: "luna_repo_read",
    label: "Repository read",
    description: "Read bounded lines from a repository file.",
    promptSnippet: "Read repository file",
    parameters: schemaObject({
      path: pathProperty,
      startLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
      maxLines: { type: "integer", minimum: 1, maximum: 500 },
    }, ["path"]),
    executionMode: "sequential",
    execute: async (_id, params) => {
      try {
        return await executeRepositoryRead(config, params);
      } catch (error) {
        return toolError(error);
      }
    },
  });
  registerToolSafely(pi, {
    name: "luna_repo_search",
    label: "Repository search",
    description: "Search bounded repository text literally.",
    promptSnippet: "Search repository text",
    parameters: schemaObject({
      query: stringSchema("Literal text to find", MAX_QUERY_CHARS),
      path: pathProperty,
      caseSensitive: { type: "boolean" },
      maxResults: { type: "integer", minimum: 1, maximum: 100 },
    }, ["query"]),
    executionMode: "sequential",
    execute: async (_id, params) => {
      try {
        return await executeRepositorySearch(config, params);
      } catch (error) {
        return toolError(error);
      }
    },
  });
  registerToolSafely(pi, {
    name: "luna_repo_git",
    label: "Repository Git",
    description: "Observe bounded Git history, status, or diff.",
    promptSnippet: "Inspect repository Git",
    parameters: schemaObject({
      action: {
        type: "string",
        enum: ["history", "status", "diff"],
        description: "Observation action",
      },
      path: pathProperty,
      limit: { type: "integer", minimum: 1, maximum: 50 },
      staged: { type: "boolean" },
    }, ["action"]),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      try {
        return await executeRepositoryGit(config, params, signal);
      } catch (error) {
        return toolError(error);
      }
    },
  });
  registerToolSafely(pi, {
    name: "luna_repo_mutate",
    label: "Repository mutation",
    description: "Atomically edit or patch one repository file.",
    promptSnippet: "Change repository file",
    parameters: schemaObject({
      mode: {
        type: "string",
        enum: ["edit", "patch"],
        description: "Mutation mode",
      },
      path: pathProperty,
      content: stringSchema("Replacement content", MAX_EDIT_BYTES),
      oldText: stringSchema("Unique text to replace", MAX_PATCH_BYTES),
      newText: stringSchema("Replacement text", MAX_EDIT_BYTES),
      expectedSha256: stringSchema("Expected SHA-256", 80),
    }, ["mode", "path"]),
    executionMode: "sequential",
    execute: async (_id, params) => {
      try {
        return await executeRepositoryMutation(config, params);
      } catch (error) {
        return toolError(error);
      }
    },
  });
  registerToolSafely(pi, {
    name: "luna_verify",
    label: "Coordinator verification",
    description: "Run a declared verification command.",
    promptSnippet: "Run verification",
    parameters: schemaObject({
      commandId: {
        type: "string",
        enum: config.verificationCommands.map((command) => command.id),
        description: "Declared command ID",
      },
    }, ["commandId"]),
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      try {
        const object = record(params, "verification parameters");
        return await executeVerification(config, object.commandId, signal);
      } catch (error) {
        return toolError(error);
      }
    },
  });
  registerToolSafely(pi, {
    name: "luna_result",
    label: "Terminating Luna result",
    description: "Record the final structured result and terminate.",
    promptSnippet: "Finish with result",
    parameters: schemaObject({
      status: { type: "string", enum: ["complete", "partial", "blocked"] },
      summary: stringSchema("Outcome summary", PI_LUNA_RESULT_LIMITS.summaryChars),
      changedPaths: arraySchema("Changed repository paths", PI_LUNA_RESULT_LIMITS.listItems, PI_LUNA_RESULT_LIMITS.pathChars),
      verification: arraySchema("Verification notes", PI_LUNA_RESULT_LIMITS.listItems, PI_LUNA_RESULT_LIMITS.listItemChars),
      remainingLimits: arraySchema("Remaining limits", PI_LUNA_RESULT_LIMITS.listItems, PI_LUNA_RESULT_LIMITS.listItemChars),
    }, ["status", "summary", "changedPaths", "verification", "remainingLimits"]),
    executionMode: "sequential",
    execute: async (_id, params) => {
      try {
        const result = validateResult(params);
        return {
          content: [{ type: "text", text: "Structured Luna result recorded." }],
          details: result,
          terminate: true,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });
}

export default function piLunaExtension(pi: ExtensionAPI): void {
  const config = loadExtensionConfig();
  if (PI_LUNA_TOOL_NAMES.length > 6) throw new Error("Pi Luna tool catalogue is too large");
  registerPiLunaTools(pi, config);
}
