import { createHash, randomUUID } from "node:crypto";
import {
  compareGitHubIssueContexts,
  type GitHubIssueContext,
} from "./github-issue-context.js";
import {
  ensureProjectAttachmentSchema,
  getSqliteProjectAttachment,
} from "./project-attachments-sqlite.js";
import type { StensiblyStore } from "./store.js";

export const githubIssueContextSyncStatuses = [
  "synchronized",
  "degraded",
] as const;

export type GitHubIssueContextSyncStatus =
  typeof githubIssueContextSyncStatuses[number];

export type GitHubIssueContextAcceptanceOutcome =
  | "initial"
  | "updated"
  | "stale"
  | "instruction_rebound"
  | "synchronization_updated";

export interface RepositoryInstructionSourceInput {
  path: string;
  revision: string;
  contentSha256: string;
}

export interface RepositoryInstructionSource {
  path: string;
  revision: string;
  contentSha256: string;
}

export interface AcceptedRepositoryInstructionSet {
  version: 1;
  id: string;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: RepositoryInstructionSource[];
  sha256: string;
}

export interface AcceptSqliteGitHubIssueContextInput {
  workspace: string;
  project: string;
  snapshot: GitHubIssueContext;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  instructionSources: readonly RepositoryInstructionSourceInput[];
  syncStatus: GitHubIssueContextSyncStatus;
  syncCursor?: string | null;
  degradedReasonCode?: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
}

export interface GitHubIssueContextRecord {
  id: string;
  workspace: string;
  project: string;
  externalId: string;
  snapshot: GitHubIssueContext;
  instructionSet: AcceptedRepositoryInstructionSet;
  syncStatus: GitHubIssueContextSyncStatus;
  syncCursor: string | null;
  degradedReasonCode: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
  acceptedAt: string;
  isCurrent: boolean;
  outcome: GitHubIssueContextAcceptanceOutcome;
}

export interface GitHubIssueContextAcceptance {
  record: GitHubIssueContextRecord;
  replayed: boolean;
}

interface GitHubIssueContextRow {
  sequence: number;
  id: string;
  workspace_id: string;
  project_id: string;
  external_id: string;
  source_revision: string;
  snapshot_sha256: string;
  content_sha256: string;
  provider_updated_at: string;
  snapshot_json: string;
  project_attachment_id: string;
  project_attachment_snapshot_sha256: string;
  instruction_set_id: string;
  instruction_set_sha256: string;
  instruction_set_json: string;
  sync_status: GitHubIssueContextSyncStatus;
  sync_cursor: string | null;
  degraded_reason_code: string | null;
  observation_ref: string;
  observed_at: string;
  accepted_by: string;
  accepted_at: string;
  is_current: number;
  acceptance_outcome: GitHubIssueContextAcceptanceOutcome;
}

const limits = {
  workspace: 80,
  project: 80,
  identifier: 240,
  sourcePath: 240,
  sourceRevision: 512,
  sources: 32,
  cursor: 512,
  reasonCode: 160,
} as const;

const workspacePattern = /^[a-z0-9][a-z0-9_-]*$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/;
const sourceRevisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/;
const reasonCodePattern = /^[a-z0-9][a-z0-9._-]*$/;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const MAX_OBSERVATION_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export class GitHubIssueContextConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubIssueContextConflictError";
  }
}

export function ensureGitHubIssueContextSchema(store: StensiblyStore): void {
  ensureProjectAttachmentSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS github_issue_contexts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      provider_updated_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      project_attachment_id TEXT NOT NULL,
      project_attachment_snapshot_sha256 TEXT NOT NULL,
      instruction_set_id TEXT NOT NULL,
      instruction_set_sha256 TEXT NOT NULL,
      instruction_set_json TEXT NOT NULL,
      sync_status TEXT NOT NULL CHECK (sync_status IN ('synchronized', 'degraded')),
      sync_cursor TEXT,
      degraded_reason_code TEXT,
      observation_ref TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      accepted_by TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
      acceptance_outcome TEXT NOT NULL CHECK (
        acceptance_outcome IN (
          'initial',
          'updated',
          'stale',
          'instruction_rebound',
          'synchronization_updated'
        )
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_context_observation
      ON github_issue_contexts(workspace_id, project_id, observation_ref);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_context_single_current
      ON github_issue_contexts(workspace_id, project_id, external_id)
      WHERE is_current = 1;

    CREATE INDEX IF NOT EXISTS idx_github_issue_context_current
      ON github_issue_contexts(workspace_id, project_id, external_id, is_current, sequence DESC);

    CREATE INDEX IF NOT EXISTS idx_github_issue_context_revision
      ON github_issue_contexts(workspace_id, project_id, external_id, source_revision, sequence DESC);
  `);
}

export function buildAcceptedRepositoryInstructionSet(input: {
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: readonly RepositoryInstructionSourceInput[];
}): AcceptedRepositoryInstructionSet {
  const projectAttachmentId = boundedIdentifier(
    input.projectAttachmentId,
    "Project attachment ID",
  );
  const projectAttachmentSnapshotSha256 = boundedSha256(
    input.projectAttachmentSnapshotSha256,
    "Project attachment snapshot fingerprint",
  );
  const sources = canonicalInstructionSources(input.sources);
  const canonical = {
    version: 1 as const,
    projectAttachmentId,
    projectAttachmentSnapshotSha256,
    sources,
  };
  const sha256 = hash(stableJson(canonical));
  return deepFreeze({
    ...canonical,
    id: `instructions_${sha256.slice("sha256:".length)}`,
    sha256,
  });
}

export function acceptSqliteGitHubIssueContext(
  store: StensiblyStore,
  input: AcceptSqliteGitHubIssueContextInput,
): GitHubIssueContextAcceptance {
  ensureGitHubIssueContextSchema(store);
  const prepared = prepareAcceptance(store, input);
  const transaction = store.db.transaction(() => {
    const observedRow = getRowByObservationRef(
      store,
      prepared.workspace,
      prepared.project,
      prepared.observationRef,
    );
    if (observedRow) {
      const observed = mapRecord(observedRow);
      if (!isExactObservationReplay(observed, prepared)) {
        throw new GitHubIssueContextConflictError(
          `GitHub observation reference ${prepared.observationRef} was reused with altered content`,
        );
      }
      return { record: observed, replayed: true };
    }

    const sameRevision = listRowsForRevision(
      store,
      prepared.workspace,
      prepared.project,
      prepared.snapshot.reference.externalId,
      prepared.snapshot.sourceRevision,
    );
    for (const row of sameRevision) {
      const record = mapRecord(row);
      if (record.snapshot.contentSha256 !== prepared.snapshot.contentSha256) {
        throw new GitHubIssueContextConflictError(
          `GitHub issue source revision ${prepared.snapshot.sourceRevision} was reused with altered content`,
        );
      }
    }

    const current = getCurrentSqliteGitHubIssueContext(store, {
      workspace: prepared.workspace,
      project: prepared.project,
      externalId: prepared.snapshot.reference.externalId,
    });
    const classification = classifyAcceptance(
      current,
      prepared.snapshot,
      prepared.instructionSet.id,
      prepared.observedAt,
    );
    if (classification.isCurrent) {
      store.db.query(`
        UPDATE github_issue_contexts
        SET is_current = 0
        WHERE workspace_id = ?1
          AND project_id = ?2
          AND external_id = ?3
          AND is_current = 1
      `).run(
        prepared.workspace,
        prepared.project,
        prepared.snapshot.reference.externalId,
      );
    }

    const acceptedAt = new Date().toISOString();
    const id = `github_context_${randomUUID()}`;
    store.db.query(`
      INSERT INTO github_issue_contexts (
        id,
        workspace_id,
        project_id,
        external_id,
        source_revision,
        snapshot_sha256,
        content_sha256,
        provider_updated_at,
        snapshot_json,
        project_attachment_id,
        project_attachment_snapshot_sha256,
        instruction_set_id,
        instruction_set_sha256,
        instruction_set_json,
        sync_status,
        sync_cursor,
        degraded_reason_code,
        observation_ref,
        observed_at,
        accepted_by,
        accepted_at,
        is_current,
        acceptance_outcome
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
      )
    `).run(
      id,
      prepared.workspace,
      prepared.project,
      prepared.snapshot.reference.externalId,
      prepared.snapshot.sourceRevision,
      prepared.snapshot.snapshotSha256,
      prepared.snapshot.contentSha256,
      prepared.snapshot.updatedAt,
      JSON.stringify(prepared.snapshot),
      prepared.instructionSet.projectAttachmentId,
      prepared.instructionSet.projectAttachmentSnapshotSha256,
      prepared.instructionSet.id,
      prepared.instructionSet.sha256,
      JSON.stringify(prepared.instructionSet),
      prepared.syncStatus,
      prepared.syncCursor,
      prepared.degradedReasonCode,
      prepared.observationRef,
      prepared.observedAt,
      prepared.acceptedBy,
      acceptedAt,
      classification.isCurrent ? 1 : 0,
      classification.outcome,
    );

    const row = getRowById(store, id);
    if (!row) throw new Error("Accepted GitHub issue context disappeared");
    return { record: mapRecord(row), replayed: false };
  });
  return transaction();
}

export function getCurrentSqliteGitHubIssueContext(
  store: StensiblyStore,
  input: { workspace: string; project: string; externalId: string },
): GitHubIssueContextRecord | null {
  ensureGitHubIssueContextSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const externalId = boundedIdentifier(input.externalId, "GitHub issue external ID");
  const row = store.db.query<GitHubIssueContextRow, [string, string, string]>(`
    SELECT *
    FROM github_issue_contexts
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND external_id = ?3
      AND is_current = 1
    ORDER BY sequence DESC
    LIMIT 1
  `).get(workspace, project, externalId);
  return row ? mapRecord(row) : null;
}

export function listSqliteGitHubIssueContextHistory(
  store: StensiblyStore,
  input: { workspace: string; project: string; externalId: string },
): GitHubIssueContextRecord[] {
  ensureGitHubIssueContextSchema(store);
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  const externalId = boundedIdentifier(input.externalId, "GitHub issue external ID");
  return store.db.query<GitHubIssueContextRow, [string, string, string]>(`
    SELECT *
    FROM github_issue_contexts
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND external_id = ?3
    ORDER BY sequence ASC
  `).all(workspace, project, externalId).map(mapRecord);
}

function prepareAcceptance(
  store: StensiblyStore,
  input: AcceptSqliteGitHubIssueContextInput,
) {
  const workspace = boundedWorkspace(input.workspace, "Workspace");
  const project = boundedWorkspace(input.project, "Project");
  validateSnapshot(input.snapshot);
  if (input.snapshot.reference.repositoryFullName.length === 0) {
    throw new RangeError("GitHub issue snapshot repository identity is invalid");
  }

  const attachment = getSqliteProjectAttachment(store, project);
  if (!attachment) {
    throw new GitHubIssueContextConflictError(
      `Project ${project} has no accepted project attachment`,
    );
  }
  const projectAttachmentId = boundedIdentifier(
    input.projectAttachmentId,
    "Project attachment ID",
  );
  const projectAttachmentSnapshotSha256 = boundedSha256(
    input.projectAttachmentSnapshotSha256,
    "Project attachment snapshot fingerprint",
  );
  if (
    attachment.id !== projectAttachmentId
    || attachment.snapshot.snapshotSha256 !== projectAttachmentSnapshotSha256
  ) {
    throw new GitHubIssueContextConflictError(
      "GitHub issue context must bind the current accepted project attachment",
    );
  }
  if (!attachmentDeclaresGitHubRepository(
    attachment.snapshot.contract.repositories,
    input.snapshot.reference.repositoryFullName,
  )) {
    throw new GitHubIssueContextConflictError(
      `Repository ${input.snapshot.reference.repositoryFullName} is not declared by the accepted project attachment`,
    );
  }

  const instructionSet = buildAcceptedRepositoryInstructionSet({
    projectAttachmentId,
    projectAttachmentSnapshotSha256,
    sources: input.instructionSources,
  });
  const syncStatus = exactEnum(
    input.syncStatus,
    githubIssueContextSyncStatuses,
    "GitHub issue synchronization status",
  );
  const degradedReasonCode = input.degradedReasonCode === undefined
      || input.degradedReasonCode === null
    ? null
    : boundedReasonCode(input.degradedReasonCode);
  if (syncStatus === "degraded" && degradedReasonCode === null) {
    throw new RangeError("Degraded GitHub issue synchronization requires a reason code");
  }
  if (syncStatus === "synchronized" && degradedReasonCode !== null) {
    throw new RangeError("Synchronized GitHub issue context cannot carry a degraded reason");
  }
  const observedAt = canonicalTimestamp(input.observedAt, "GitHub observation time");
  if (Date.parse(observedAt) > Date.now() + MAX_OBSERVATION_FUTURE_SKEW_MS) {
    throw new RangeError("GitHub observation time cannot be in the future");
  }

  return {
    workspace,
    project,
    snapshot: input.snapshot,
    instructionSet,
    syncStatus,
    syncCursor: input.syncCursor === undefined || input.syncCursor === null
      ? null
      : boundedIdentifier(input.syncCursor, "GitHub synchronization cursor", limits.cursor),
    degradedReasonCode,
    observationRef: boundedIdentifier(input.observationRef, "GitHub observation reference"),
    observedAt,
    acceptedBy: boundedIdentifier(input.acceptedBy, "GitHub context accepting actor"),
  };
}

function isExactObservationReplay(
  current: GitHubIssueContextRecord,
  candidate: ReturnType<typeof prepareAcceptance>,
): boolean {
  return current.externalId === candidate.snapshot.reference.externalId
    && current.snapshot.snapshotSha256 === candidate.snapshot.snapshotSha256
    && current.instructionSet.id === candidate.instructionSet.id
    && current.syncStatus === candidate.syncStatus
    && current.syncCursor === candidate.syncCursor
    && current.degradedReasonCode === candidate.degradedReasonCode
    && current.observedAt === candidate.observedAt
    && current.acceptedBy === candidate.acceptedBy;
}

function classifyAcceptance(
  current: GitHubIssueContextRecord | null,
  snapshot: GitHubIssueContext,
  instructionSetId: string,
  observedAt: string,
): { outcome: GitHubIssueContextAcceptanceOutcome; isCurrent: boolean } {
  if (!current) return { outcome: "initial", isCurrent: true };
  const comparison = compareGitHubIssueContexts(current.snapshot, snapshot);
  switch (comparison.outcome) {
    case "altered_revision_conflict":
      throw new GitHubIssueContextConflictError(
        `GitHub issue source revision ${comparison.sourceRevision} was reused with altered content`,
      );
    case "different_issue":
      throw new GitHubIssueContextConflictError(
        "Cannot compare different GitHub issue identities inside one scoped history",
      );
    case "stale":
      return { outcome: "stale", isCurrent: false };
    case "updated":
      return { outcome: "updated", isCurrent: true };
    case "identical":
      if (current.instructionSet.id !== instructionSetId) {
        return { outcome: "instruction_rebound", isCurrent: true };
      }
      return Date.parse(observedAt) < Date.parse(current.observedAt)
        ? { outcome: "stale", isCurrent: false }
        : { outcome: "synchronization_updated", isCurrent: true };
  }
}

function getRowByObservationRef(
  store: StensiblyStore,
  workspace: string,
  project: string,
  observationRef: string,
): GitHubIssueContextRow | null {
  return store.db.query<GitHubIssueContextRow, [string, string, string]>(`
    SELECT *
    FROM github_issue_contexts
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND observation_ref = ?3
    ORDER BY sequence DESC
    LIMIT 1
  `).get(workspace, project, observationRef) ?? null;
}

function listRowsForRevision(
  store: StensiblyStore,
  workspace: string,
  project: string,
  externalId: string,
  sourceRevision: string,
): GitHubIssueContextRow[] {
  return store.db.query<GitHubIssueContextRow, [string, string, string, string]>(`
    SELECT *
    FROM github_issue_contexts
    WHERE workspace_id = ?1
      AND project_id = ?2
      AND external_id = ?3
      AND source_revision = ?4
    ORDER BY sequence DESC
  `).all(workspace, project, externalId, sourceRevision);
}

function getRowById(store: StensiblyStore, id: string): GitHubIssueContextRow | null {
  return store.db.query<GitHubIssueContextRow, [string]>(`
    SELECT * FROM github_issue_contexts WHERE id = ?1
  `).get(id) ?? null;
}

function mapRecord(row: GitHubIssueContextRow): GitHubIssueContextRecord {
  const snapshot = parseStoredSnapshot(row.snapshot_json, row.id);
  if (
    snapshot.reference.externalId !== row.external_id
    || snapshot.sourceRevision !== row.source_revision
    || snapshot.snapshotSha256 !== row.snapshot_sha256
    || snapshot.contentSha256 !== row.content_sha256
    || snapshot.updatedAt !== row.provider_updated_at
  ) {
    throw new Error(`Stored GitHub issue context ${row.id} metadata does not match its snapshot`);
  }
  const instructionSet = parseInstructionSet(row.instruction_set_json, row.id);
  if (
    instructionSet.id !== row.instruction_set_id
    || instructionSet.sha256 !== row.instruction_set_sha256
    || instructionSet.projectAttachmentId !== row.project_attachment_id
    || instructionSet.projectAttachmentSnapshotSha256
      !== row.project_attachment_snapshot_sha256
  ) {
    throw new Error(`Stored GitHub issue context ${row.id} instruction binding is invalid`);
  }
  return {
    id: row.id,
    workspace: row.workspace_id,
    project: row.project_id,
    externalId: row.external_id,
    snapshot,
    instructionSet,
    syncStatus: row.sync_status,
    syncCursor: row.sync_cursor,
    degradedReasonCode: row.degraded_reason_code,
    observationRef: row.observation_ref,
    observedAt: row.observed_at,
    acceptedBy: row.accepted_by,
    acceptedAt: row.accepted_at,
    isCurrent: row.is_current === 1,
    outcome: row.acceptance_outcome,
  };
}

function parseStoredSnapshot(value: string, id: string): GitHubIssueContext {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error(`Stored GitHub issue context ${id} is not valid JSON`);
  }
  if (!isRecord(raw)) throw new Error(`Stored GitHub issue context ${id} is invalid`);
  const snapshot = raw as unknown as GitHubIssueContext;
  validateSnapshot(snapshot);
  return snapshot;
}

function validateSnapshot(snapshot: GitHubIssueContext): void {
  const comparison = compareGitHubIssueContexts(snapshot, snapshot);
  if (comparison.outcome !== "identical") {
    throw new RangeError("GitHub issue context snapshot is invalid");
  }
}

function parseInstructionSet(value: string, recordId: string): AcceptedRepositoryInstructionSet {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error(`Stored GitHub issue context ${recordId} instruction set is not valid JSON`);
  }
  if (!isRecord(raw) || !Array.isArray(raw.sources)) {
    throw new Error(`Stored GitHub issue context ${recordId} instruction set is invalid`);
  }
  const parsed = buildAcceptedRepositoryInstructionSet({
    projectAttachmentId: raw.projectAttachmentId as string,
    projectAttachmentSnapshotSha256: raw.projectAttachmentSnapshotSha256 as string,
    sources: raw.sources as RepositoryInstructionSourceInput[],
  });
  if (raw.version !== 1 || raw.id !== parsed.id || raw.sha256 !== parsed.sha256) {
    throw new Error(`Stored GitHub issue context ${recordId} instruction set fingerprint is invalid`);
  }
  return parsed;
}

function canonicalInstructionSources(
  values: readonly RepositoryInstructionSourceInput[],
): RepositoryInstructionSource[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > limits.sources) {
    throw new RangeError(`Repository instruction sources must contain 1-${limits.sources} entries`);
  }
  const seen = new Set<string>();
  const sources = values.map((value) => {
    if (!isRecord(value)) throw new RangeError("Repository instruction source must be an object");
    const path = boundedSourcePath(value.path);
    if (seen.has(path)) throw new RangeError("Repository instruction source paths must be unique");
    seen.add(path);
    return {
      path,
      revision: boundedPattern(
        value.revision,
        "Repository instruction source revision",
        limits.sourceRevision,
        sourceRevisionPattern,
      ),
      contentSha256: boundedSha256(
        value.contentSha256,
        "Repository instruction source fingerprint",
      ),
    };
  });
  return sources.sort((left, right) => codeUnitCompare(left.path, right.path));
}

function attachmentDeclaresGitHubRepository(
  repositories: readonly string[],
  repositoryFullName: string,
): boolean {
  const target = canonicalGitHubRepository(repositoryFullName);
  return target !== null && repositories.some((repository) =>
    canonicalGitHubRepository(repository) === target
  );
}

function canonicalGitHubRepository(value: string): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  let owner: string | undefined;
  let repository: string | undefined;

  const plain = /^([^/:]+)\/([^/]+)$/.exec(normalized);
  if (plain) {
    owner = plain[1];
    repository = plain[2];
  } else {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      return null;
    }
    if (
      url.hostname.toLowerCase() !== "github.com"
      || !["http:", "https:", "ssh:"].includes(url.protocol)
      || url.password
      || url.search
      || url.hash
    ) return null;
    if (
      (url.protocol === "http:" || url.protocol === "https:") && url.username
    ) return null;
    if (url.protocol === "ssh:" && url.username && url.username !== "git") return null;
    if (url.port && url.port !== "22") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    [owner, repository] = parts;
  }

  repository = repository?.replace(/\.git$/i, "");
  if (
    !owner
    || !repository
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || repository === "."
    || repository === ".."
    || repository.includes("..")
  ) return null;
  return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function boundedSourcePath(value: string): string {
  if (typeof value !== "string") throw new RangeError("Repository instruction source path must be a string");
  if (unsafeTextPattern.test(value)) throw new RangeError("Repository instruction source path contains unsafe characters");
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized
    || normalized.length > limits.sourcePath
    || normalized.startsWith("/")
    || normalized.startsWith("\\")
    || normalized.includes("\\")
    || normalized.includes("//")
    || normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new RangeError("Repository instruction source path must be a relative traversal-free path");
  }
  return normalized;
}

function boundedWorkspace(value: string, label: string): string {
  return boundedPattern(value, label, limits.workspace, workspacePattern).toLowerCase();
}

function boundedIdentifier(
  value: string,
  label: string,
  maximum: number = limits.identifier,
): string {
  return boundedPattern(value, label, maximum, identifierPattern);
}

function boundedReasonCode(value: string): string {
  return boundedPattern(value, "Degraded reason code", limits.reasonCode, reasonCodePattern).toLowerCase();
}

function boundedSha256(value: string, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedPattern(
  value: string,
  label: string,
  maximum: number,
  pattern: RegExp,
): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  if (unsafeTextPattern.test(value)) throw new RangeError(`${label} contains unsafe characters`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || !pattern.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new RangeError(`${label} must be an ISO UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function exactEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Canonical JSON number must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) throw new RangeError("Canonical JSON value is invalid");
  const keys = Object.keys(value).sort(codeUnitCompare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
