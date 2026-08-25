import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";

const execFileAsync = promisify(execFile);

export const CODEX_ROOT_CLOUD_PLACEMENT_V1 = 1 as const;

export type CodexCloudPlacementPhaseV1 = "pre_dispatch" | "pre_result_application";
export type CodexCloudCanonicalSettlementV1 = "open" | "settled" | "superseded";
export type CodexCloudExperimentFreezeV1 = "open" | "frozen";

export interface CodexCloudCanonicalPlacementFactsV1 {
  readonly ownerRef: string;
  readonly ownerGeneration: number;
  readonly remoteRef: string;
  readonly head: string;
  readonly settlement: CodexCloudCanonicalSettlementV1;
  readonly experimentFreeze: CodexCloudExperimentFreezeV1;
}

export interface CodexCloudCanonicalReadEvidenceV1 {
  readonly version: typeof CODEX_ROOT_CLOUD_PLACEMENT_V1;
  readonly receiptId: string;
  readonly observedAt: string;
  readonly facts: CodexCloudCanonicalPlacementFactsV1;
  readonly fingerprint: string;
}

export interface CodexCloudInspectionEvidenceV1 {
  readonly version: typeof CODEX_ROOT_CLOUD_PLACEMENT_V1;
  readonly receiptId: string;
  readonly observedAt: string;
  readonly isolatedTemporaryCwd: true;
  readonly repositoryDiagnosticPaths: readonly string[];
  readonly temporaryDiagnosticPaths: readonly string[];
  readonly fingerprint: string;
}

export interface CodexCloudPlacementEvidenceLinkV1 {
  readonly canonicalReadFingerprint: string;
  readonly canonicalReadObservedAt: string;
  readonly inspectionFingerprint: string;
  readonly inspectionObservedAt: string;
}

export interface CodexCloudPlacementPreflightInputV1 {
  readonly version: typeof CODEX_ROOT_CLOUD_PLACEMENT_V1;
  readonly phase: CodexCloudPlacementPhaseV1;
  readonly repository: string;
  readonly missionRef: string;
  readonly expected: CodexCloudCanonicalPlacementFactsV1;
  readonly canonicalRead: CodexCloudCanonicalReadEvidenceV1;
  readonly inspection: CodexCloudInspectionEvidenceV1;
  readonly priorDispatch: ({
    readonly preflightFingerprint: string;
  } & CodexCloudPlacementEvidenceLinkV1) | null;
}

export type CodexCloudPlacementDenialV1 =
  | "canonical_read_evidence_invalid"
  | "inspection_evidence_invalid"
  | "pre_dispatch_link_unexpected"
  | "pre_dispatch_link_missing"
  | "canonical_read_not_fresh"
  | "inspection_not_fresh"
  | "canonical_owner_changed"
  | "canonical_ref_changed"
  | "canonical_head_changed"
  | "canonical_mission_settled"
  | "canonical_mission_superseded"
  | "experiment_frozen"
  | "repository_diagnostic_created";

export interface CodexCloudPlacementPreflightV1 {
  readonly version: typeof CODEX_ROOT_CLOUD_PLACEMENT_V1;
  readonly phase: CodexCloudPlacementPhaseV1;
  readonly placementEligible: boolean;
  readonly disposition: "admit" | "stale_release";
  readonly authorizesDispatch: false;
  readonly authorizesResultApplication: false;
  readonly denials: readonly CodexCloudPlacementDenialV1[];
  readonly evidenceLink: CodexCloudPlacementEvidenceLinkV1;
  readonly fingerprint: string;
}

export interface CodexCloudInspectionCommandInputV1 {
  readonly executable: string;
  readonly args: readonly string[];
  readonly repositoryRoots: readonly string[];
  readonly diagnosticRelativePaths?: readonly string[];
  readonly timeoutMs?: number;
  readonly receiptId?: string;
  readonly clock?: () => Date;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CodexCloudInspectionCommandResultV1 {
  readonly stdout: string;
  readonly stderr: string;
  readonly evidence: CodexCloudInspectionEvidenceV1;
}

/**
 * Runs a Cloud CLI inspection in an owned temporary cwd, scans configured
 * repository diagnostics after execution, records temporary diagnostics, and
 * removes the owned cwd. It does not dispatch or apply a task by itself.
 */
export async function runCodexCloudInspectionCommandV1(
  input: CodexCloudInspectionCommandInputV1,
): Promise<CodexCloudInspectionCommandResultV1> {
  const executable = command(input.executable);
  const args = boundedArgs(input.args);
  const roots = await canonicalRoots(input.repositoryRoots);
  const diagnostics = diagnosticPaths(input.diagnosticRelativePaths ?? ["error.log"]);
  const timeoutMs = positiveInteger(input.timeoutMs ?? 120_000, "Cloud inspection timeout");
  const receiptId = identifier(input.receiptId ?? randomUUID(), "Cloud inspection receipt ID", 240);
  const clock = input.clock ?? (() => new Date());
  const inspectionCwd = await mkdtemp(join(tmpdir(), "stensibly-codex-cloud-"));
  try {
    const canonicalCwd = await realpath(inspectionCwd);
    for (const root of roots) {
      if (pathContains(root, canonicalCwd) || pathContains(canonicalCwd, root)) {
        throw new Error("Cloud inspection cwd overlaps a repository worktree");
      }
    }
    const result = await execFileAsync(executable, [...args], {
      cwd: canonicalCwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: input.environment ? { ...process.env, ...input.environment } : process.env,
    });
    const repositoryDiagnosticPaths = await scanRepositoryDiagnostics(roots, diagnostics);
    const temporaryDiagnosticPaths = await scanTemporaryDiagnostics(canonicalCwd, diagnostics);
    const evidence = inspectionEvidence({
      version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
      receiptId,
      observedAt: clock().toISOString(),
      isolatedTemporaryCwd: true,
      repositoryDiagnosticPaths,
      temporaryDiagnosticPaths,
    });
    return deepFreeze({ stdout: result.stdout, stderr: result.stderr, evidence });
  } finally {
    await rm(inspectionCwd, { recursive: true, force: true });
  }
}

/**
 * Binds facts returned by the canonical issue/PR owner read to one observation.
 * This proves integrity and replay identity, not that the caller had authority
 * to perform or interpret the provider read.
 */
export function codexCloudCanonicalReadEvidenceV1(input: {
  readonly receiptId: string;
  readonly observedAt: string;
  readonly facts: CodexCloudCanonicalPlacementFactsV1;
}): CodexCloudCanonicalReadEvidenceV1 {
  const evidence = {
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    receiptId: identifier(input.receiptId, "Canonical read receipt ID", 240),
    observedAt: timestamp(input.observedAt, "Canonical read observation time"),
    facts: placementFacts(input.facts, "Canonical read facts"),
  };
  return deepFreeze({ ...evidence, fingerprint: fingerprintCanonicalRequest(evidence) });
}

/**
 * Pure admission evidence. The owner supplies a newly observed canonical-read
 * receipt at each phase. Result application links the prior dispatch result and
 * rejects replay of either the canonical read or inspection receipt.
 */
export function adjudicateCodexCloudPlacementV1(
  input: CodexCloudPlacementPreflightInputV1,
): CodexCloudPlacementPreflightV1 {
  const parsed = parseInput(input);
  const denials: CodexCloudPlacementDenialV1[] = [];
  if (!parsed.canonicalRead.valid) denials.push("canonical_read_evidence_invalid");
  if (!parsed.inspection.valid) denials.push("inspection_evidence_invalid");
  if (parsed.phase === "pre_dispatch" && parsed.priorDispatch !== null) {
    denials.push("pre_dispatch_link_unexpected");
  }
  if (parsed.phase === "pre_result_application") {
    if (parsed.priorDispatch === null) {
      denials.push("pre_dispatch_link_missing");
    } else {
      if (
        parsed.canonicalRead.evidence.fingerprint === parsed.priorDispatch.canonicalReadFingerprint
        || Date.parse(parsed.canonicalRead.evidence.observedAt)
          <= Date.parse(parsed.priorDispatch.canonicalReadObservedAt)
      ) denials.push("canonical_read_not_fresh");
      if (
        parsed.inspection.evidence.fingerprint === parsed.priorDispatch.inspectionFingerprint
        || Date.parse(parsed.inspection.evidence.observedAt)
          <= Date.parse(parsed.priorDispatch.inspectionObservedAt)
      ) denials.push("inspection_not_fresh");
    }
  }
  const current = parsed.canonicalRead.evidence.facts;
  if (
    parsed.expected.ownerRef !== current.ownerRef
    || parsed.expected.ownerGeneration !== current.ownerGeneration
  ) denials.push("canonical_owner_changed");
  if (parsed.expected.remoteRef !== current.remoteRef) denials.push("canonical_ref_changed");
  if (parsed.expected.head !== current.head) denials.push("canonical_head_changed");
  if (current.settlement === "settled") denials.push("canonical_mission_settled");
  if (current.settlement === "superseded") denials.push("canonical_mission_superseded");
  if (current.experimentFreeze === "frozen") denials.push("experiment_frozen");
  if (parsed.inspection.evidence.repositoryDiagnosticPaths.length > 0) {
    denials.push("repository_diagnostic_created");
  }
  const uniqueDenials = [...new Set(denials)];
  const evidenceLink = deepFreeze({
    canonicalReadFingerprint: parsed.canonicalRead.evidence.fingerprint,
    canonicalReadObservedAt: parsed.canonicalRead.evidence.observedAt,
    inspectionFingerprint: parsed.inspection.evidence.fingerprint,
    inspectionObservedAt: parsed.inspection.evidence.observedAt,
  });
  const fingerprintInput = {
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    phase: parsed.phase,
    repository: parsed.repository,
    missionRef: parsed.missionRef,
    expected: parsed.expected,
    canonicalRead: parsed.canonicalRead.evidence,
    inspection: parsed.inspection.evidence,
    priorDispatch: parsed.priorDispatch,
  };
  return deepFreeze({
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    phase: parsed.phase,
    placementEligible: uniqueDenials.length === 0,
    disposition: uniqueDenials.length === 0 ? "admit" : "stale_release",
    authorizesDispatch: false,
    authorizesResultApplication: false,
    denials: uniqueDenials,
    evidenceLink,
    fingerprint: fingerprintCanonicalRequest(fingerprintInput),
  });
}

function parseInput(input: CodexCloudPlacementPreflightInputV1) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Codex cloud placement preflight input must be an object");
  }
  if (input.version !== CODEX_ROOT_CLOUD_PLACEMENT_V1) {
    throw new RangeError("Codex cloud placement preflight version is invalid");
  }
  if (input.phase !== "pre_dispatch" && input.phase !== "pre_result_application") {
    throw new RangeError("Codex cloud placement phase is invalid");
  }
  return deepFreeze({
    phase: input.phase,
    repository: identifier(input.repository, "Repository", 240),
    missionRef: identifier(input.missionRef, "Mission reference", 240),
    expected: placementFacts(input.expected, "Expected placement facts"),
    canonicalRead: parseCanonicalRead(input.canonicalRead),
    inspection: parseInspection(input.inspection),
    priorDispatch: priorDispatch(input.priorDispatch),
  });
}

function parseCanonicalRead(value: CodexCloudCanonicalReadEvidenceV1) {
  const recomputed = codexCloudCanonicalReadEvidenceV1({
    receiptId: value?.receiptId,
    observedAt: value?.observedAt,
    facts: value?.facts,
  });
  const suppliedFingerprint = fingerprint(value?.fingerprint);
  return deepFreeze({
    evidence: { ...recomputed, fingerprint: suppliedFingerprint },
    valid: recomputed.fingerprint === suppliedFingerprint,
  });
}

function parseInspection(value: CodexCloudInspectionEvidenceV1) {
  if (value?.version !== CODEX_ROOT_CLOUD_PLACEMENT_V1 || value.isolatedTemporaryCwd !== true) {
    throw new RangeError("Cloud inspection evidence is invalid");
  }
  const recomputed = inspectionEvidence({
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    receiptId: value.receiptId,
    observedAt: value.observedAt,
    isolatedTemporaryCwd: true,
    repositoryDiagnosticPaths: value.repositoryDiagnosticPaths,
    temporaryDiagnosticPaths: value.temporaryDiagnosticPaths,
  });
  const suppliedFingerprint = fingerprint(value.fingerprint);
  return deepFreeze({
    evidence: { ...recomputed, fingerprint: suppliedFingerprint },
    valid: recomputed.fingerprint === suppliedFingerprint,
  });
}

function inspectionEvidence(
  input: Omit<CodexCloudInspectionEvidenceV1, "fingerprint">,
): CodexCloudInspectionEvidenceV1 {
  if (input.version !== CODEX_ROOT_CLOUD_PLACEMENT_V1 || input.isolatedTemporaryCwd !== true) {
    throw new RangeError("Cloud inspection evidence is invalid");
  }
  const evidence = {
    version: CODEX_ROOT_CLOUD_PLACEMENT_V1,
    receiptId: identifier(input.receiptId, "Cloud inspection receipt ID", 240),
    observedAt: timestamp(input.observedAt, "Cloud inspection observation time"),
    isolatedTemporaryCwd: true as const,
    repositoryDiagnosticPaths: boundedPaths(input.repositoryDiagnosticPaths, "Repository diagnostic paths"),
    temporaryDiagnosticPaths: boundedPaths(input.temporaryDiagnosticPaths, "Temporary diagnostic paths"),
  };
  return deepFreeze({ ...evidence, fingerprint: fingerprintCanonicalRequest(evidence) });
}

function priorDispatch(
  value: CodexCloudPlacementPreflightInputV1["priorDispatch"],
): CodexCloudPlacementPreflightInputV1["priorDispatch"] {
  if (value === null) return null;
  return deepFreeze({
    preflightFingerprint: fingerprint(value.preflightFingerprint),
    canonicalReadFingerprint: fingerprint(value.canonicalReadFingerprint),
    canonicalReadObservedAt: timestamp(value.canonicalReadObservedAt, "Prior canonical read time"),
    inspectionFingerprint: fingerprint(value.inspectionFingerprint),
    inspectionObservedAt: timestamp(value.inspectionObservedAt, "Prior inspection time"),
  });
}

function placementFacts(value: CodexCloudCanonicalPlacementFactsV1, label: string): CodexCloudCanonicalPlacementFactsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (value.settlement !== "open" && value.settlement !== "settled" && value.settlement !== "superseded") {
    throw new RangeError(`${label} settlement is invalid`);
  }
  if (value.experimentFreeze !== "open" && value.experimentFreeze !== "frozen") {
    throw new RangeError(`${label} experiment freeze is invalid`);
  }
  return deepFreeze({
    ownerRef: identifier(value.ownerRef, `${label} owner`, 240),
    ownerGeneration: positiveInteger(value.ownerGeneration, `${label} owner generation`),
    remoteRef: gitRef(value.remoteRef, `${label} remote ref`),
    head: sha(value.head, `${label} head`),
    settlement: value.settlement,
    experimentFreeze: value.experimentFreeze,
  });
}

async function canonicalRoots(values: readonly string[]): Promise<readonly string[]> {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw new RangeError("Repository roots must be a non-empty bounded array");
  }
  const roots = await Promise.all(values.map(async (value) => {
    if (typeof value !== "string" || !isAbsolute(value)) throw new RangeError("Repository root must be absolute");
    return realpath(resolve(value));
  }));
  if (new Set(roots).size !== roots.length) throw new RangeError("Repository roots must be unique");
  return roots;
}

function diagnosticPaths(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw new RangeError("Diagnostic relative paths must be a non-empty bounded array");
  }
  const parsed = values.map((value) => {
    const path = identifier(value, "Diagnostic relative path", 512);
    if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw new RangeError("Diagnostic relative path is invalid");
    return path;
  });
  if (new Set(parsed).size !== parsed.length) throw new RangeError("Diagnostic relative paths must be unique");
  return parsed;
}

async function scanRepositoryDiagnostics(roots: readonly string[], diagnostics: readonly string[]): Promise<readonly string[]> {
  const found: string[] = [];
  for (const root of roots) {
    for (const diagnostic of diagnostics) {
      if (await pathExists(join(root, diagnostic))) found.push(`${root}:${diagnostic}`);
    }
  }
  return found.sort();
}

async function scanTemporaryDiagnostics(root: string, diagnostics: readonly string[]): Promise<readonly string[]> {
  const entries = new Set(await readdir(root));
  return diagnostics.filter((diagnostic) => !diagnostic.includes("/") && entries.has(diagnostic)).sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function boundedArgs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) throw new RangeError("Cloud inspection arguments must be bounded");
  return values.map((value) => text(value, "Cloud inspection argument", 32_768, true));
}

function boundedPaths(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 100) throw new RangeError(`${label} must be a bounded array`);
  const parsed = values.map((value) => text(value, `${label} entry`, 4_096));
  if (new Set(parsed).size !== parsed.length) throw new RangeError(`${label} must be unique`);
  return [...parsed].sort();
}

function command(value: unknown): string {
  return text(value, "Cloud inspection executable", 4_096);
}

function identifier(value: unknown, label: string, maximum: number): string {
  return text(value, label, maximum).trim();
}

function text(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text`);
  if ((!allowEmpty && !value.trim()) || value.length > maximum || /[\u0000\r\n]/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RangeError(`${label} must be positive`);
  return value as number;
}

function gitRef(value: unknown, label: string): string {
  const output = identifier(value, label, 1_024);
  if (!output.startsWith("refs/") || output.includes("..") || output.includes("@{") || output.endsWith("/")) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function sha(value: unknown, label: string): string {
  const output = identifier(value, label, 40);
  if (!/^[0-9a-f]{40}$/u.test(output)) throw new RangeError(`${label} must be an exact Git SHA-1`);
  return output;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new RangeError("Evidence fingerprint is invalid");
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const output = identifier(value, label, 64);
  const date = new Date(output);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== output) throw new RangeError(`${label} is invalid`);
  return output;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
