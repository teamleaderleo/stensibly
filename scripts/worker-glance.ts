import { constants as fsConstants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const WORKER_GLANCE_SCHEMA_VERSION = "worker-glance/1" as const;
export const SOL_LUNA_RECEIPT_SCHEMA_VERSION = "sol-luna-worker-receipt/3" as const;
export const PI_LUNA_RECEIPT_SCHEMA_VERSION = "pi-luna-worker-receipt/1" as const;
export const WORKER_GLANCE_MAX_ARTIFACT_BYTES = 64 * 1024;
export const WORKER_GLANCE_MAX_ROWS = 32;
export const WORKER_GLANCE_MAX_PATHS = 4;
export const WORKER_GLANCE_MAX_OUTPUT_CHARS = 4_000;
export const WORKER_GLANCE_MAX_ID_CHARS = 96;
export const WORKER_GLANCE_MAX_ROLE_CHARS = 96;
export const WORKER_GLANCE_MAX_CHANGED_PATH_CHARS = 160;
export const WORKER_GLANCE_MAX_ROOT_CHARS = 512;
export const WORKER_GLANCE_MAX_POINTER_CHARS = 768;

const RECEIPT_NAME = "receipt.json" as const;
const RESULT_NAME = "worker-result.json" as const;
const NO_FOLLOW = fsConstants.O_NOFOLLOW;

type JsonObject = Record<string, unknown>;

export type WorkerGlanceBackend = "sol-luna" | "pi" | "unknown";
export type WorkerGlanceState = "terminal" | "running" | "missing" | "unknown";
export type WorkerGlanceResultStatus = "success" | "failed" | "blocked" | "partial" | "running" | "unknown";
export type WorkerGlanceVerificationPass = "passed" | "failed" | "mixed" | "ambiguous" | "unknown";
export type WorkerGlanceBlocker =
  | "none"
  | "receipt_missing"
  | "receipt_invalid"
  | "receipt_oversized"
  | "artifact_symlink"
  | "artifact_not_regular"
  | "artifact_unreadable"
  | "result_missing"
  | "result_invalid"
  | "result_oversized"
  | "run_directory_missing"
  | "run_directory_unreadable"
  | "run_path_oversized"
  | "unknown_schema"
  | "unknown_backend"
  | "artifact_reference_invalid"
  | "id_oversized"
  | "path_invalid"
  | "usage_invalid"
  | "usage_unknown"
  | "timeout"
  | "worker_failed"
  | "harness_failed"
  | "non_descendant"
  | "result_failed"
  | "result_blocked"
  | "result_partial"
  | "result_running"
  | "result_status_unknown"
  | "verification_failed"
  | "verification_ambiguous"
  | "verification_unknown";

export interface WorkerGlanceRow {
  readonly runId: string | null;
  readonly role: string | null;
  readonly backend: WorkerGlanceBackend;
  readonly state: WorkerGlanceState;
  readonly success: boolean | null;
  readonly provisional: boolean | null;
  readonly changedPathCount: number | null;
  readonly changedPaths: readonly string[];
  readonly changedPathsOmitted: number | null;
  readonly commitCount: number | null;
  readonly usage: {
    readonly input: number | null;
    readonly cached: number | null;
    readonly uncached: number | null;
    readonly cachePercentage: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
  };
  readonly resultStatus: WorkerGlanceResultStatus;
  readonly verificationCount: number | null;
  readonly verificationPass: WorkerGlanceVerificationPass;
  readonly blocker: WorkerGlanceBlocker;
  readonly receipt: string | null;
  readonly result: string | null;
}

export interface WorkerGlanceProjection {
  readonly schema: typeof WORKER_GLANCE_SCHEMA_VERSION;
  readonly root: string;
  readonly rows: readonly WorkerGlanceRow[];
  readonly omittedRows: number;
  readonly truncated: boolean;
}

export interface WorkerGlanceOptions {
  /** Optional absolute or relative root that every run directory must inhabit. */
  readonly root?: string;
  readonly maxRows?: number;
  readonly maxPaths?: number;
  readonly maxOutputChars?: number;
}

interface NormalizedWorkerGlanceOptions {
  readonly maxRows: number;
  readonly maxPaths: number;
  readonly maxOutputChars: number;
}

interface PreparedRun {
  readonly absoluteDirectory: string;
  readonly relativeDirectory: string | null;
  readonly receiptPointer: string | null;
  readonly resultPointer: string | null;
  readonly directoryBlocker: "run_directory_missing" | "run_directory_unreadable" | "run_path_oversized" | null;
}

interface RunDirectoryInput {
  readonly absoluteDirectory: string;
  readonly relativeDirectory: string | null;
  readonly receiptPointer: string | null;
  readonly resultPointer: string | null;
  readonly directoryBlocker: PreparedRun["directoryBlocker"];
}

interface ArtifactReadSuccess {
  readonly kind: "ok";
  readonly value: JsonObject;
}

type ArtifactReadFailureKind = "missing" | "symlink" | "not_regular" | "oversized" | "unreadable" | "invalid";

interface ArtifactReadFailure {
  readonly kind: ArtifactReadFailureKind;
}

type ArtifactRead = ArtifactReadSuccess | ArtifactReadFailure;

interface CurrentReceipt {
  readonly backend: Exclude<WorkerGlanceBackend, "unknown">;
  readonly runId: string | null;
  readonly role: string | null;
  readonly idOrRoleOversized: boolean;
  readonly changedPaths: readonly string[];
  readonly changedPathCountKnown: boolean;
  readonly commitCount: number | null;
  readonly success: boolean | null;
  readonly provisional: boolean | null;
  readonly outcome: SolLunaOutcome | null;
  readonly timedOut: boolean | null;
  readonly harnessError: boolean;
  readonly headRelationship: string | null;
  readonly usage: unknown;
  readonly resultArtifactClaim: "present" | "absent" | "unknown";
  readonly structuralInvalid: boolean;
  readonly artifactReferenceInvalid: boolean;
}

interface ResultProjection {
  readonly status: WorkerGlanceResultStatus;
  readonly verificationCount: number | null;
  readonly verificationPass: WorkerGlanceVerificationPass;
}

interface UsageProjection {
  readonly usage: WorkerGlanceRow["usage"];
  readonly issue: "usage_invalid" | "usage_unknown" | null;
}

interface ChangedPathProjection {
  readonly count: number | null;
  readonly paths: readonly string[];
  readonly omitted: number | null;
  readonly issue: "path_invalid" | null;
}

type SolLunaOutcome =
  | "not_started"
  | "worker_succeeded"
  | "worker_failed"
  | "timeout"
  | "harness_failed";

const SOL_LUNA_OUTCOMES: ReadonlySet<string> = new Set([
  "not_started",
  "worker_succeeded",
  "worker_failed",
  "timeout",
  "harness_failed",
]);

const RESULT_STATUS_ALIASES: Readonly<Record<string, WorkerGlanceResultStatus>> = {
  success: "success",
  succeeded: "success",
  pass: "success",
  passed: "success",
  complete: "success",
  completed: "success",
  done: "success",
  failed: "failed",
  failure: "failed",
  fail: "failed",
  error: "failed",
  errored: "failed",
  blocked: "blocked",
  partial: "partial",
  incomplete: "partial",
  running: "running",
  pending: "running",
  in_progress: "running",
  "in-progress": "running",
};

const VERIFICATION_STATUS_ALIASES: Readonly<Record<string, "passed" | "failed">> = {
  pass: "passed",
  passed: "passed",
  success: "passed",
  succeeded: "passed",
  ok: "passed",
  fail: "failed",
  failed: "failed",
  failure: "failed",
  error: "failed",
};

export class WorkerGlanceInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "WorkerGlanceInputError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(value: unknown, code: string): boolean {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && (value as { readonly code?: unknown }).code === code;
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedLabel(value: unknown, maximum: number): { readonly value: string | null; readonly oversized: boolean } {
  if (typeof value !== "string" || value.length === 0) return { value: null, oversized: false };
  if (value.length > maximum) return { value: null, oversized: true };
  if (/[\u0000-\u001f\u007f]/u.test(value)) return { value: null, oversized: false };
  const normalized = value.replace(/\s+/gu, " ").trim();
  return { value: normalized.length === 0 ? null : normalized, oversized: false };
}

function normalizedRelativePointer(value: string): string | null {
  if (value === "." || value.length === 0) return ".";
  if (isAbsolute(value)) return null;
  const portable = value.split(sep).join("/");
  if (portable.split("/").includes("..") || /[\u0000-\u001f\u007f]/u.test(portable)) {
    return null;
  }
  return portable;
}

function pathInside(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === ""
    || (candidateRelative !== ".."
      && !candidateRelative.startsWith(`..${sep}`)
      && !isAbsolute(candidateRelative));
}

function relativeRunDirectory(root: string, directory: string): string | null {
  const candidate = relative(root, directory);
  if (!pathInside(root, directory)) return null;
  const portable = candidate.length === 0 ? "." : candidate.split(sep).join("/");
  return normalizedRelativePointer(portable);
}

function pointerFor(relativeDirectory: string | null, artifactName: string): string | null {
  if (relativeDirectory === null) return null;
  const pointer = relativeDirectory === "." ? artifactName : `${relativeDirectory}/${artifactName}`;
  return pointer.length <= WORKER_GLANCE_MAX_POINTER_CHARS ? pointer : null;
}

function commonParentOfRunDirectories(directories: readonly string[]): string {
  let root = dirname(directories[0] ?? resolve("."));
  for (const directory of directories.slice(1)) {
    while (!pathInside(root, directory)) {
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  return root;
}

async function rejectSymlinkedDirectory(path: string, missingIsAllowed: boolean): Promise<"missing" | "ok"> {
  let directoryStat;
  try {
    directoryStat = await lstat(path);
  } catch (error) {
    if (missingIsAllowed && isNodeErrorWithCode(error, "ENOENT")) return "missing";
    throw new WorkerGlanceInputError("root_unreadable");
  }
  if (directoryStat.isSymbolicLink()) throw new WorkerGlanceInputError("symlinked_root");
  if (!directoryStat.isDirectory()) throw new WorkerGlanceInputError("root_not_directory");
  try {
    if (await realpath(path) !== path) throw new WorkerGlanceInputError("symlinked_root");
  } catch (error) {
    if (error instanceof WorkerGlanceInputError) throw error;
    throw new WorkerGlanceInputError("root_unreadable");
  }
  return "ok";
}

async function prepareRunDirectories(
  rawDirectories: readonly string[],
  requestedRoot: string | undefined,
): Promise<{ readonly root: string; readonly runs: readonly RunDirectoryInput[] }> {
  if (rawDirectories.length === 0) throw new WorkerGlanceInputError("no_run_directories");
  const directories = rawDirectories.map((directory) => {
    if (directory.length === 0 || directory === "-") throw new WorkerGlanceInputError("invalid_run_directory");
    return resolve(directory);
  });
  const duplicate = new Set<string>();
  for (const directory of directories) {
    if (duplicate.has(directory)) throw new WorkerGlanceInputError("duplicate_run_directory");
    duplicate.add(directory);
  }

  const root = resolve(requestedRoot ?? commonParentOfRunDirectories(directories));
  if (root.length > WORKER_GLANCE_MAX_ROOT_CHARS) throw new WorkerGlanceInputError("root_path_oversized");
  await rejectSymlinkedDirectory(root, true);
  for (const directory of directories) {
    if (!pathInside(root, directory)) throw new WorkerGlanceInputError("escaping_run_directory");
  }

  const prepared = await Promise.all(directories.map(async (directory): Promise<RunDirectoryInput> => {
    let directoryBlocker: PreparedRun["directoryBlocker"] = null;
    try {
      const directoryStat = await lstat(directory);
      if (directoryStat.isSymbolicLink()) throw new WorkerGlanceInputError("symlinked_run_directory");
      if (!directoryStat.isDirectory()) throw new WorkerGlanceInputError("run_directory_not_directory");
      try {
        if (await realpath(directory) !== directory) throw new WorkerGlanceInputError("symlinked_run_directory");
      } catch (error) {
        if (error instanceof WorkerGlanceInputError) throw error;
        directoryBlocker = "run_directory_unreadable";
      }
    } catch (error) {
      if (error instanceof WorkerGlanceInputError) throw error;
      if (isNodeErrorWithCode(error, "ENOENT")) directoryBlocker = "run_directory_missing";
      else directoryBlocker = "run_directory_unreadable";
    }
    const relativeDirectory = relativeRunDirectory(root, directory);
    if (relativeDirectory === null) throw new WorkerGlanceInputError("escaping_run_directory");
    const pointerTooLong = relativeDirectory.length > WORKER_GLANCE_MAX_POINTER_CHARS;
    return {
      absoluteDirectory: directory,
      relativeDirectory: pointerTooLong ? null : relativeDirectory,
      receiptPointer: pointerTooLong ? null : pointerFor(relativeDirectory, RECEIPT_NAME),
      resultPointer: pointerTooLong ? null : pointerFor(relativeDirectory, RESULT_NAME),
      directoryBlocker: pointerTooLong ? "run_path_oversized" : directoryBlocker,
    };
  }));

  return {
    root,
    runs: prepared.slice().sort((left, right) => compareStrings(left.relativeDirectory ?? "", right.relativeDirectory ?? "")),
  };
}

function normalizeOptions(options: WorkerGlanceOptions): NormalizedWorkerGlanceOptions {
  const maxRows = options.maxRows ?? WORKER_GLANCE_MAX_ROWS;
  const maxPaths = options.maxPaths ?? WORKER_GLANCE_MAX_PATHS;
  const maxOutputChars = options.maxOutputChars ?? WORKER_GLANCE_MAX_OUTPUT_CHARS;
  if (!finiteNonNegativeInteger(maxRows) || maxRows === 0) throw new WorkerGlanceInputError("invalid_max_rows");
  if (!finiteNonNegativeInteger(maxPaths) || maxPaths === 0) throw new WorkerGlanceInputError("invalid_max_paths");
  if (!finiteNonNegativeInteger(maxOutputChars) || maxOutputChars < 256) {
    throw new WorkerGlanceInputError("invalid_max_output_chars");
  }
  return {
    maxRows: Math.min(maxRows, WORKER_GLANCE_MAX_ROWS),
    maxPaths: Math.min(maxPaths, WORKER_GLANCE_MAX_PATHS),
    maxOutputChars: Math.min(maxOutputChars, WORKER_GLANCE_MAX_OUTPUT_CHARS),
  };
}

async function readCanonicalJson(path: string): Promise<ArtifactRead> {
  if (typeof NO_FOLLOW !== "number") return { kind: "unreadable" };
  let linkStat;
  try {
    linkStat = await lstat(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return { kind: "missing" };
    return { kind: "unreadable" };
  }
  if (linkStat.isSymbolicLink()) return { kind: "symlink" };
  if (!linkStat.isFile()) return { kind: "not_regular" };
  if (linkStat.size > WORKER_GLANCE_MAX_ARTIFACT_BYTES) return { kind: "oversized" };

  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) return { kind: "not_regular" };
    const bytes = Buffer.alloc(WORKER_GLANCE_MAX_ARTIFACT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > WORKER_GLANCE_MAX_ARTIFACT_BYTES) return { kind: "oversized" };
    try {
      const parsed = JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
      return isObject(parsed) ? { kind: "ok", value: parsed } : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "ELOOP")) return { kind: "symlink" };
    return { kind: "unreadable" };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The artifact was already bounded and parsed; close failures do not expose data.
      }
    }
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function property(object: JsonObject, key: string): unknown {
  return object[key];
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validUsageRecord(value: unknown): boolean {
  if (!isObject(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function validPiUsageRecord(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ["input", "cacheRead", "output", "reasoning"].every((key) =>
    !Object.prototype.hasOwnProperty.call(value, key) || finiteNonNegativeInteger(value[key]),
  );
}

function adaptCurrentReceipt(value: JsonObject, resultPath: string): CurrentReceipt | null {
  const schemaVersion = property(value, "schemaVersion");
  const backend = schemaVersion === SOL_LUNA_RECEIPT_SCHEMA_VERSION
    ? "sol-luna"
    : schemaVersion === PI_LUNA_RECEIPT_SCHEMA_VERSION
      ? "pi"
      : null;
  if (backend === null) return null;

  let structuralInvalid = false;
  const run = property(value, "run");
  const git = property(value, "git");
  const child = property(value, "child");
  const codex = property(value, "codex");
  const pi = property(value, "pi");
  const invocation = property(value, "invocation");
  const artifacts = property(value, "artifacts");
  const integration = property(value, "integration");
  if (!isObject(run) || !isObject(git) || !isObject(child) || !isObject(artifacts) || !isObject(integration)) {
    structuralInvalid = true;
  }
  if (backend === "sol-luna" && !isObject(codex)) structuralInvalid = true;
  if (backend === "pi" && (!isObject(pi) || !isObject(invocation))) structuralInvalid = true;

  const runIdValue = isObject(run) ? property(run, "id") : null;
  const roleValue = isObject(run) ? property(run, "assignedRole") : null;
  const runId = normalizedLabel(runIdValue, WORKER_GLANCE_MAX_ID_CHARS);
  const role = normalizedLabel(roleValue, WORKER_GLANCE_MAX_ROLE_CHARS);
  if (runId.value === null || role.value === null) structuralInvalid = true;
  const idOrRoleOversized = runId.oversized || role.oversized;

  const changedPathsValue = isObject(git) ? property(git, "changedPaths") : null;
  const commitsValue = isObject(git) ? property(git, "commitsMade") : null;
  if (!stringArray(changedPathsValue) || !stringArray(commitsValue)) structuralInvalid = true;
  const changedPaths = stringArray(changedPathsValue) ? changedPathsValue : [];
  const commitCount = stringArray(commitsValue) ? commitsValue.length : null;

  const successValue = property(value, "success");
  if (typeof successValue !== "boolean") structuralInvalid = true;
  const success = typeof successValue === "boolean" ? successValue : null;

  const outcomeValue = isObject(child) ? property(child, "outcome") : null;
  const timedOutValue = isObject(child) ? property(child, "timedOut") : null;
  if (typeof outcomeValue !== "string" || !SOL_LUNA_OUTCOMES.has(outcomeValue)) structuralInvalid = true;
  if (typeof timedOutValue !== "boolean") structuralInvalid = true;
  const outcome = typeof outcomeValue === "string" && SOL_LUNA_OUTCOMES.has(outcomeValue)
    ? outcomeValue as SolLunaOutcome
    : null;
  const timedOut = typeof timedOutValue === "boolean" ? timedOutValue : null;

  const tokenUsage = backend === "sol-luna"
    ? (isObject(codex) ? property(codex, "tokenUsage") : null)
    : property(value, "usage");
  const usageValid = tokenUsage === null
    || (backend === "sol-luna" ? validUsageRecord(tokenUsage) : validPiUsageRecord(tokenUsage));
  if (!usageValid) structuralInvalid = true;
  const usage = usageValid ? tokenUsage : null;

  const workerSuccessIsProvisional = isObject(integration) ? property(integration, "workerSuccessIsProvisional") : null;
  const integrationStatus = isObject(integration) ? property(integration, "status") : null;
  const gatesAdjudicated = isObject(integration) ? property(integration, "gatesAdjudicated") : null;
  if (workerSuccessIsProvisional !== true || integrationStatus !== "not_adjudicated" || gatesAdjudicated !== false) {
    structuralInvalid = true;
  }
  const provisional = workerSuccessIsProvisional === true ? true : null;

  const harnessErrorValue = property(value, "harnessError");
  if (!validNullableString(harnessErrorValue)) structuralInvalid = true;
  const harnessError = typeof harnessErrorValue === "string";

  const headRelationshipValue = isObject(git) ? property(git, "headRelationship") : null;
  const headRelationship = typeof headRelationshipValue === "string" ? headRelationshipValue : null;

  let resultArtifactClaim: CurrentReceipt["resultArtifactClaim"] = "unknown";
  let artifactReferenceInvalid = false;
  if (isObject(artifacts) && Object.prototype.hasOwnProperty.call(artifacts, "finalWorkerResult")) {
    const finalWorkerResult = property(artifacts, "finalWorkerResult");
    if (finalWorkerResult === null) {
      resultArtifactClaim = "absent";
    } else if (isObject(finalWorkerResult)) {
      const artifactPath = property(finalWorkerResult, "path");
      const artifactBytes = property(finalWorkerResult, "bytes");
      const artifactHash = property(finalWorkerResult, "sha256");
      if (typeof artifactPath !== "string" || !finiteNonNegativeInteger(artifactBytes) || typeof artifactHash !== "string") {
        structuralInvalid = true;
      } else {
        resultArtifactClaim = "present";
        if (resolve(artifactPath) !== resultPath) artifactReferenceInvalid = true;
      }
    } else {
      structuralInvalid = true;
    }
  } else {
    structuralInvalid = true;
  }

  if (success === true && outcome !== "worker_succeeded") structuralInvalid = true;
  if (success === false && outcome === "worker_succeeded") structuralInvalid = true;
  if (success === true && harnessError) structuralInvalid = true;

  return {
    backend,
    runId: runId.value,
    role: role.value,
    idOrRoleOversized,
    changedPaths,
    changedPathCountKnown: !structuralInvalid,
    commitCount: structuralInvalid ? null : commitCount,
    success,
    provisional: structuralInvalid ? null : provisional,
    outcome,
    timedOut,
    harnessError,
    headRelationship,
    usage: structuralInvalid ? null : usage,
    resultArtifactClaim,
    structuralInvalid,
    artifactReferenceInvalid,
  };
}

function unknownUsage(): WorkerGlanceRow["usage"] {
  return {
    input: null,
    cached: null,
    uncached: null,
    cachePercentage: null,
    output: null,
    reasoning: null,
  };
}

function usageNumber(object: JsonObject, keys: readonly string[]): { readonly value: number | null; readonly issue: boolean; readonly found: boolean } {
  const present = keys.filter((key) => Object.prototype.hasOwnProperty.call(object, key));
  if (present.length === 0) return { value: null, issue: false, found: false };
  const values = present.map((key) => object[key]);
  if (values.some((value) => !finiteNonNegativeInteger(value))) return { value: null, issue: true, found: true };
  const first = values[0] as number;
  if (values.some((value) => value !== first)) return { value: null, issue: true, found: true };
  return { value: first, issue: false, found: true };
}

function roundPercentage(value: number): number {
  return Number(value.toFixed(1));
}

function projectUsage(value: unknown): UsageProjection {
  if (value === null) return { usage: unknownUsage(), issue: null };
  if (!isObject(value)) return { usage: unknownUsage(), issue: "usage_invalid" };
  const input = usageNumber(value, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "input"]);
  const cached = usageNumber(value, ["cached_input_tokens", "cachedInputTokens", "cached_tokens", "cachedTokens", "cacheRead"]);
  const output = usageNumber(value, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "output"]);
  const reasoning = usageNumber(value, ["reasoning_tokens", "reasoningTokens", "reasoning"]);
  const issue = input.issue || cached.issue || output.issue || reasoning.issue;
  const recognized = input.found || cached.found || output.found || reasoning.found;
  const uncached = input.value !== null && cached.value !== null && cached.value <= input.value
    ? input.value - cached.value
    : null;
  const cachePercentage = input.value !== null && cached.value !== null && cached.value <= input.value && input.value > 0
    ? roundPercentage((cached.value / input.value) * 100)
    : null;
  return {
    usage: {
      input: input.value,
      cached: cached.value,
      uncached,
      cachePercentage,
      output: output.value,
      reasoning: reasoning.value,
    },
    issue: issue ? "usage_invalid" : recognized ? null : "usage_unknown",
  };
}

function safeChangedPath(value: string): boolean {
  if (value.length === 0 || value.length > WORKER_GLANCE_MAX_CHANGED_PATH_CHARS) return false;
  if (/^[\\/]/u.test(value) || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split(/[\\/]/u);
  return !segments.some((segment) => segment === "..");
}

function projectChangedPaths(value: readonly string[], maxPaths: number): ChangedPathProjection {
  const safe = [...new Set(value.filter(safeChangedPath))].sort(compareStrings);
  const paths = safe.slice(0, maxPaths);
  return {
    count: value.length,
    paths,
    omitted: Math.max(0, value.length - paths.length),
    issue: safe.length !== value.length ? "path_invalid" : null,
  };
}

function normalizeStatus(value: unknown): WorkerGlanceResultStatus {
  if (typeof value !== "string") return "unknown";
  return RESULT_STATUS_ALIASES[value.trim().toLowerCase()] ?? "unknown";
}

function verificationAtom(value: unknown): "passed" | "failed" | "unknown" {
  if (typeof value === "boolean") return value ? "passed" : "failed";
  if (typeof value !== "string") {
    if (isObject(value)) {
      const passed = value.passed ?? value.pass;
      if (typeof passed === "boolean") return passed ? "passed" : "failed";
      return verificationAtom(value.status);
    }
    return "unknown";
  }
  return VERIFICATION_STATUS_ALIASES[value.trim().toLowerCase()] ?? "unknown";
}

function aggregateVerification(values: readonly unknown[]): WorkerGlanceVerificationPass {
  if (values.length === 0) return "unknown";
  const atoms = values.map(verificationAtom);
  const hasPassed = atoms.includes("passed");
  const hasFailed = atoms.includes("failed");
  const hasUnknown = atoms.includes("unknown");
  if (hasUnknown) return "ambiguous";
  if (hasPassed && hasFailed) return "mixed";
  return hasPassed ? "passed" : "failed";
}

function verificationFromValue(value: unknown): { readonly count: number | null; readonly pass: WorkerGlanceVerificationPass } {
  if (Array.isArray(value)) return { count: value.length, pass: aggregateVerification(value) };
  if (typeof value === "boolean") return { count: 1, pass: value ? "passed" : "failed" };
  if (!isObject(value)) return { count: null, pass: "unknown" };

  const list = value.checks ?? value.items ?? value.results;
  const listProjection = Array.isArray(list)
    ? { count: list.length, pass: aggregateVerification(list) }
    : { count: null, pass: "unknown" as const };
  const countValue = value.count;
  const count = finiteNonNegativeInteger(countValue) ? countValue : listProjection.count;
  const explicitPass = typeof value.passed === "boolean"
    ? (value.passed ? "passed" : "failed")
    : typeof value.pass === "boolean"
      ? (value.pass ? "passed" : "failed")
      : typeof value.status === "string"
        ? VERIFICATION_STATUS_ALIASES[value.status.trim().toLowerCase()] ?? "unknown"
        : "unknown";
  if (listProjection.count !== null && explicitPass !== "unknown" && listProjection.pass !== explicitPass) {
    return { count, pass: "ambiguous" };
  }
  return {
    count,
    pass: listProjection.count !== null ? listProjection.pass : explicitPass,
  };
}

function projectVerification(value: JsonObject): { readonly count: number | null; readonly pass: WorkerGlanceVerificationPass } {
  if (Object.prototype.hasOwnProperty.call(value, "verification")) {
    const direct = verificationFromValue(value.verification);
    const explicitCount = value.verificationCount ?? value.verification_count;
    const count = finiteNonNegativeInteger(explicitCount) ? explicitCount : direct.count;
    const explicitPassed = value.verificationPassed ?? value.verification_passed;
    if (typeof explicitPassed === "boolean") {
      const explicitPass = explicitPassed ? "passed" : "failed";
      if (direct.pass !== "unknown" && direct.pass !== explicitPass) return { count, pass: "ambiguous" };
      return { count, pass: explicitPass };
    }
    return { count, pass: direct.pass };
  }
  const countValue = value.verificationCount ?? value.verification_count;
  const passedValue = value.verificationPassed ?? value.verification_passed;
  const statusValue = value.verificationStatus ?? value.verification_status;
  const count = finiteNonNegativeInteger(countValue) ? countValue : null;
  if (typeof passedValue === "boolean") return { count, pass: passedValue ? "passed" : "failed" };
  if (typeof statusValue === "string") return { count, pass: VERIFICATION_STATUS_ALIASES[statusValue.trim().toLowerCase()] ?? "unknown" };
  return { count, pass: "unknown" };
}

function projectResult(value: JsonObject): ResultProjection {
  const statusValue = value.status ?? value.resultStatus ?? value.result_status;
  const verification = projectVerification(value);
  return {
    status: normalizeStatus(statusValue),
    verificationCount: verification.count,
    verificationPass: verification.pass,
  };
}

function emptyRow(input: PreparedRun, blocker: WorkerGlanceBlocker, state: WorkerGlanceState = "unknown"): WorkerGlanceRow {
  return {
    runId: null,
    role: null,
    backend: "unknown",
    state,
    success: null,
    provisional: null,
    changedPathCount: null,
    changedPaths: [],
    changedPathsOmitted: null,
    commitCount: null,
    usage: unknownUsage(),
    resultStatus: "unknown",
    verificationCount: null,
    verificationPass: "unknown",
    blocker,
    receipt: input.receiptPointer,
    result: input.resultPointer,
  };
}

function artifactBlocker(kind: ArtifactReadFailureKind, artifact: "receipt" | "result"): WorkerGlanceBlocker {
  if (kind === "missing") return artifact === "receipt" ? "receipt_missing" : "result_missing";
  if (kind === "symlink") return "artifact_symlink";
  if (kind === "not_regular") return "artifact_not_regular";
  if (kind === "oversized") return artifact === "receipt" ? "receipt_oversized" : "result_oversized";
  if (kind === "unreadable") return "artifact_unreadable";
  return artifact === "receipt" ? "receipt_invalid" : "result_invalid";
}

function outcomeBlocker(receipt: CurrentReceipt): WorkerGlanceBlocker | null {
  if (receipt.timedOut === true || receipt.outcome === "timeout") return "timeout";
  if (receipt.outcome === "worker_failed") return "worker_failed";
  if (receipt.outcome === "harness_failed" || receipt.outcome === "not_started" || receipt.harnessError) return "harness_failed";
  if (receipt.headRelationship === "non_descendant") return "non_descendant";
  return null;
}

function resultBlocker(result: ResultProjection): WorkerGlanceBlocker | null {
  if (result.status === "failed") return "result_failed";
  if (result.status === "blocked") return "result_blocked";
  if (result.status === "partial") return "result_partial";
  if (result.status === "running") return "result_running";
  if (result.status === "unknown") return "result_status_unknown";
  if (result.verificationPass === "failed") return "verification_failed";
  if (result.verificationPass === "mixed" || result.verificationPass === "ambiguous") return "verification_ambiguous";
  if (result.verificationPass === "unknown") return "verification_unknown";
  return null;
}

async function projectRun(input: PreparedRun, options: NormalizedWorkerGlanceOptions): Promise<WorkerGlanceRow> {
  if (input.directoryBlocker !== null) return emptyRow(input, input.directoryBlocker, input.directoryBlocker === "run_directory_missing" ? "missing" : "unknown");
  if (input.receiptPointer === null || input.resultPointer === null) return emptyRow(input, "run_path_oversized");

  const receiptRead = await readCanonicalJson(resolve(input.absoluteDirectory, RECEIPT_NAME));
  if (receiptRead.kind !== "ok") {
    return emptyRow(input, artifactBlocker(receiptRead.kind, "receipt"), receiptRead.kind === "missing" ? "missing" : "unknown");
  }
  const schemaVersion = property(receiptRead.value, "schemaVersion");
  if (schemaVersion !== SOL_LUNA_RECEIPT_SCHEMA_VERSION && schemaVersion !== PI_LUNA_RECEIPT_SCHEMA_VERSION) {
    return emptyRow(input, "unknown_schema");
  }
  const resultPath = resolve(input.absoluteDirectory, RESULT_NAME);
  const receipt = adaptCurrentReceipt(receiptRead.value, resultPath);
  if (receipt === null) return emptyRow(input, "unknown_schema");
  if (receipt.structuralInvalid) {
    return {
      ...emptyRow(input, receipt.idOrRoleOversized ? "id_oversized" : "receipt_invalid"),
      backend: receipt.backend,
      state: "unknown",
    };
  }

  const changed = projectChangedPaths(receipt.changedPaths, options.maxPaths);
  const usage = projectUsage(receipt.usage);
  const resultRead = await readCanonicalJson(resultPath);
  let resultProjection: ResultProjection = {
    status: "unknown",
    verificationCount: null,
    verificationPass: "unknown",
  };
  if (resultRead.kind === "ok" && receipt.resultArtifactClaim !== "absent") {
    resultProjection = projectResult(resultRead.value);
  }

  let blocker: WorkerGlanceBlocker = "none";
  if (receipt.artifactReferenceInvalid || (receipt.resultArtifactClaim === "absent" && resultRead.kind === "ok")) {
    blocker = "artifact_reference_invalid";
  }
  else if (resultRead.kind !== "ok" && !(resultRead.kind === "missing" && outcomeBlocker(receipt) !== null)) {
    blocker = artifactBlocker(resultRead.kind, "result");
  } else if (receipt.idOrRoleOversized) blocker = "id_oversized";
  else if (usage.issue === "usage_invalid") blocker = "usage_invalid";
  else if (changed.issue !== null) blocker = changed.issue;
  else blocker = outcomeBlocker(receipt) ?? (resultRead.kind === "ok" ? resultBlocker(resultProjection) ?? "none" : "none");

  return {
    runId: receipt.runId,
    role: receipt.role,
    backend: receipt.backend,
    state: "terminal",
    success: receipt.success,
    provisional: receipt.provisional,
    changedPathCount: receipt.changedPathCountKnown ? changed.count : null,
    changedPaths: receipt.changedPathCountKnown ? changed.paths : [],
    changedPathsOmitted: receipt.changedPathCountKnown ? changed.omitted : null,
    commitCount: receipt.commitCount,
    usage: usage.usage,
    resultStatus: resultProjection.status,
    verificationCount: resultProjection.verificationCount,
    verificationPass: resultProjection.verificationPass,
    blocker,
    receipt: input.receiptPointer,
    result: input.resultPointer,
  };
}

function rowForOutput(row: WorkerGlanceRow, paths: readonly string[], omitted: number): WorkerGlanceRow {
  return {
    ...row,
    changedPaths: paths,
    changedPathsOmitted: row.changedPathsOmitted === null ? null : row.changedPathsOmitted + omitted,
  };
}

function projectionJson(root: string, rows: readonly WorkerGlanceRow[], omittedRows: number): string {
  const truncated = omittedRows > 0 || rows.some((row) => (row.changedPathsOmitted ?? 0) > 0);
  return JSON.stringify({
    schema: WORKER_GLANCE_SCHEMA_VERSION,
    root,
    rows,
    omittedRows,
    truncated,
  });
}

function fitProjection(
  root: string,
  visibleRows: readonly WorkerGlanceRow[],
  initiallyOmittedRows: number,
  options: NormalizedWorkerGlanceOptions,
): WorkerGlanceProjection {
  let rows: WorkerGlanceRow[] = [...visibleRows];
  let omittedRows = initiallyOmittedRows;
  const reducePaths = (): boolean => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row !== undefined && row.changedPaths.length > 0) {
        rows = rows.map((candidate, candidateIndex) =>
          candidateIndex === index ? rowForOutput(candidate, candidate.changedPaths.slice(0, -1), 1) : candidate,
        );
        return true;
      }
    }
    return false;
  };

  let json = projectionJson(root, rows, omittedRows);
  while (json.length > options.maxOutputChars && reducePaths()) json = projectionJson(root, rows, omittedRows);
  while (json.length > options.maxOutputChars && rows.length > 0) {
    rows = rows.slice(0, -1);
    omittedRows += 1;
    json = projectionJson(root, rows, omittedRows);
  }
  if (json.length > options.maxOutputChars) {
    omittedRows += rows.length;
    rows = [];
    json = projectionJson(root, rows, omittedRows);
  }
  if (json.length > options.maxOutputChars) throw new WorkerGlanceInputError("projection_bound_unrepresentable");
  return JSON.parse(json) as WorkerGlanceProjection;
}

export async function buildWorkerGlance(
  runDirectories: readonly string[],
  options: WorkerGlanceOptions = {},
): Promise<WorkerGlanceProjection> {
  const normalized = normalizeOptions(options);
  const prepared = await prepareRunDirectories(runDirectories, options.root);
  const runsToProject = prepared.runs.slice(0, normalized.maxRows);
  const rows = await Promise.all(runsToProject.map((run) => projectRun(run, normalized)));
  return fitProjection(prepared.root, rows, prepared.runs.length - runsToProject.length, normalized);
}

interface ParsedCli {
  readonly directories: readonly string[];
  readonly options: WorkerGlanceOptions;
}

function requiredCliValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new WorkerGlanceInputError(`missing_${option.replaceAll("-", "_")}`);
  return value;
}

function cliInteger(value: string, option: string): number {
  if (!/^\d+$/u.test(value)) throw new WorkerGlanceInputError(`invalid_${option.replaceAll("-", "_")}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed === 0) throw new WorkerGlanceInputError(`invalid_${option.replaceAll("-", "_")}`);
  return parsed;
}

export function parseWorkerGlanceCli(argv: readonly string[]): ParsedCli | "help" {
  const directories: string[] = [];
  let root: string | undefined;
  let maxRows: number | undefined;
  let maxPaths: number | undefined;
  let maxOutputChars: number | undefined;
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument === "--help") return "help";
    if (!positionalOnly && argument === "--root") {
      root = requiredCliValue(argv, index, "root");
      index += 1;
      continue;
    }
    if (!positionalOnly && argument === "--max-rows") {
      maxRows = cliInteger(requiredCliValue(argv, index, "max-rows"), "max-rows");
      index += 1;
      continue;
    }
    if (!positionalOnly && argument === "--max-paths") {
      maxPaths = cliInteger(requiredCliValue(argv, index, "max-paths"), "max-paths");
      index += 1;
      continue;
    }
    if (!positionalOnly && argument === "--max-output-chars") {
      maxOutputChars = cliInteger(requiredCliValue(argv, index, "max-output-chars"), "max-output-chars");
      index += 1;
      continue;
    }
    if (!positionalOnly && argument.startsWith("-")) throw new WorkerGlanceInputError("unknown_argument");
    directories.push(argument);
  }
  return {
    directories,
    options: {
      ...(root === undefined ? {} : { root }),
      ...(maxRows === undefined ? {} : { maxRows }),
      ...(maxPaths === undefined ? {} : { maxPaths }),
      ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
    },
  };
}

export function workerGlanceUsage(): string {
  return [
    "Usage: bun scripts/worker-glance.ts [options] RUN_DIR...",
    "",
    "Reads only bounded receipt.json and worker-result.json files and emits one minified JSON projection.",
    "Options: --root PATH --max-rows N --max-paths N --max-output-chars N",
  ].join("\n");
}

export async function runWorkerGlanceCli(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseWorkerGlanceCli(argv);
    if (parsed === "help") {
      process.stdout.write(`${workerGlanceUsage()}\n`);
      return 0;
    }
    const projection = await buildWorkerGlance(parsed.directories, parsed.options);
    process.stdout.write(`${JSON.stringify(projection)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof WorkerGlanceInputError ? error.code : "glance_failed";
    process.stderr.write(`${code}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await runWorkerGlanceCli(process.argv.slice(2));
}
