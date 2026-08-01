import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitAcceptedRepositoryInstructionSet,
  admitGitHubIssueContextAcceptanceSubject,
  admitGitHubIssueContextSnapshot,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
  type AcceptedRepositoryInstructionSet,
  type GitHubIssueContextAcceptanceOutcome,
  type GitHubIssueContextAcceptanceSubject,
} from "./github-project-context-admission.js";
import type { GitHubIssueContext } from "./github-issue-context.js";
import type {
  GetGitHubProjectContextInput,
  GitHubIssueContextHistoryProjection,
  GitHubIssueContextProjection,
  GitHubProjectContextLedger,
  GitHubProjectContextProjection,
} from "./github-project-context.js";
import { parseStrictJson } from "./strict-json.js";
import { snapshotBoundedJson } from "./github-repository-observation-admission.js";

const acceptRef = makeFunctionReference<"mutation">("githubProjectContexts:accept");
const getCurrentRef = makeFunctionReference<"query">("githubProjectContexts:getCurrent");
const listCurrentRef = makeFunctionReference<"query">("githubProjectContexts:listCurrent");
const listHistoryRef = makeFunctionReference<"query">("githubProjectContexts:listHistory");

const recordKeys = [
  "acceptedAt",
  "acceptedBy",
  "contentSha256",
  "degradedReasonCode",
  "externalId",
  "id",
  "instructionSetId",
  "instructionSetJson",
  "instructionSetSha256",
  "isCurrent",
  "observedAt",
  "observationRef",
  "outcome",
  "project",
  "projectAttachmentId",
  "projectAttachmentSnapshotSha256",
  "providerUpdatedAt",
  "repositoryFullName",
  "snapshotJson",
  "snapshotSha256",
  "sourceRevision",
  "syncCursor",
  "syncStatus",
] as const;
const acceptanceKeys = ["record", "replayed"] as const;
const outcomes = [
  "initial",
  "updated",
  "stale",
  "instruction_rebound",
  "synchronization_updated",
] as const;
const maximumObservationFutureSkewMs = 5 * 60_000;
const recoveryGuidance: GitHubProjectContextProjection["recovery"]["guidance"] = [
  {
    code: "use_normal_chat",
    instruction:
      "Use a normal ChatGPT conversation; agent mode and company knowledge do not expose the write-capable app combination used for GitHub and Stensibly dogfood.",
  },
  {
    code: "select_github_and_stensibly",
    instruction:
      "Explicitly select both GitHub and Stensibly before asking to continue the issue or repository workflow.",
  },
  {
    code: "start_new_conversation_on_host_binding_failure",
    instruction:
      "If schemas appear but GitHub calls are unavailable or forbidden before any Stensibly request receipt, start a new conversation because the failure is in conversation-host tool binding.",
  },
  {
    code: "refresh_stensibly_actions_on_manifest_drift",
    instruction:
      "If Stensibly reports a stale action manifest, refresh or recreate the Stensibly app before retrying.",
  },
  {
    code: "reconnect_oauth_on_worker_auth_failure",
    instruction:
      "If a request reaches Stensibly and reports authentication failure, reconnect OAuth and retry the same bounded read.",
  },
];

export interface AcceptHostedGitHubIssueContextInput
  extends GitHubIssueContextAcceptanceSubject {
  project: string;
}

export interface HostedGitHubIssueContextAcceptance {
  readonly recordId: string;
  readonly externalId: string;
  readonly outcome: GitHubIssueContextAcceptanceOutcome;
  readonly isCurrent: boolean;
  readonly replayed: boolean;
}

export interface ConvexGitHubProjectContextServiceOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

interface StoredRecord {
  id: string;
  project: string;
  externalId: string;
  repositoryFullName: string;
  sourceRevision: string;
  snapshotSha256: string;
  contentSha256: string;
  providerUpdatedAt: string;
  snapshotJson: string;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  instructionSetId: string;
  instructionSetSha256: string;
  instructionSetJson: string;
  syncStatus: "synchronized" | "degraded";
  syncCursor: string | null;
  degradedReasonCode: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
  acceptedAt: string;
  isCurrent: boolean;
  outcome: GitHubIssueContextAcceptanceOutcome;
}

interface AdmittedRecord {
  raw: StoredRecord;
  snapshot: GitHubIssueContext;
  instructionSet: AcceptedRepositoryInstructionSet;
}

export class GitHubProjectContextConflictError extends Error {
  readonly code = "github_project_context_conflict";

  constructor() {
    super("GitHub project context identity was reused with different accepted content");
    this.name = "GitHubProjectContextConflictError";
  }
}

export class GitHubProjectContextStorageError extends Error {
  readonly code = "github_project_context_storage_failed";

  constructor() {
    super("GitHub project context storage failed");
    this.name = "GitHubProjectContextStorageError";
  }
}

export class ConvexGitHubProjectContextService
  implements GitHubProjectContextLedger {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;

  constructor(options: ConvexGitHubProjectContextServiceOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = exactWorkspace(options.workspace ?? "default");
  }

  async acceptGitHubIssueContext(
    input: AcceptHostedGitHubIssueContextInput,
  ): Promise<HostedGitHubIssueContextAcceptance> {
    const project = exactProject(input.project);
    const subject = admitGitHubIssueContextAcceptanceSubject({
      snapshot: input.snapshot,
      instructionSet: input.instructionSet,
      syncStatus: input.syncStatus,
      syncCursor: input.syncCursor,
      degradedReasonCode: input.degradedReasonCode,
      observationRef: input.observationRef,
      observedAt: input.observedAt,
      acceptedBy: input.acceptedBy,
    });
    try {
      const raw = await this.client.mutation(acceptRef, this.args({
        project,
        snapshotJson: canonicalGitHubIssueContextJson(subject.snapshot),
        instructionSetJson: canonicalRepositoryInstructionSetJson(subject.instructionSet),
        syncStatus: subject.syncStatus,
        syncCursor: subject.syncCursor,
        degradedReasonCode: subject.degradedReasonCode,
        observationRef: subject.observationRef,
        observedAt: subject.observedAt,
        acceptedBy: subject.acceptedBy,
      }));
      const result = admitAcceptance(raw);
      const admitted = validateStoredRecord(result.record);
      if (!matchesSubject(admitted, project, subject)) {
        throw new GitHubProjectContextStorageError();
      }
      return Object.freeze({
        recordId: result.record.id,
        externalId: result.record.externalId,
        outcome: result.record.outcome,
        isCurrent: result.record.isCurrent,
        replayed: result.replayed,
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async getGitHubProjectContext(
    input: GetGitHubProjectContextInput,
  ): Promise<GitHubProjectContextProjection> {
    const project = exactProject(input.project);
    const limit = boundedLimit(input.limit ?? 20, 100, "GitHub project context limit");
    const historyLimit = boundedLimit(
      input.historyLimit ?? 10,
      50,
      "GitHub issue context history limit",
    );
    const requestedExternalId = input.externalId === undefined
      ? null
      : exactIssueExternalId(input.externalId);
    try {
      const rawRecords = requestedExternalId === null
        ? await this.client.query(listCurrentRef, this.args({ project, limit }))
        : await this.client.query(getCurrentRef, this.args({
          project,
          externalId: requestedExternalId,
        }));
      const currentRecords = requestedExternalId === null
        ? admitRows(rawRecords, limit)
        : rawRecords === null
          ? []
          : [admitStoredRecord(rawRecords)];
      const admittedCurrent = currentRecords.map(validateStoredRecord);
      for (const record of admittedCurrent) {
        if (record.raw.project !== project) throw new GitHubProjectContextStorageError();
      }
      const history = requestedExternalId === null
        ? []
        : admitRows(await this.client.query(listHistoryRef, this.args({
          project,
          externalId: requestedExternalId,
          limit: historyLimit,
        })), historyLimit).map(validateStoredRecord);
      for (const record of history) {
        if (
          record.raw.project !== project
          || record.raw.externalId !== requestedExternalId
        ) throw new GitHubProjectContextStorageError();
      }
      return buildProjection(
        this.workspace,
        project,
        requestedExternalId,
        admittedCurrent,
        history,
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private args(input: Record<string, unknown>): Record<string, unknown> {
    return {
      ...input,
      serviceSecret: this.serviceSecret,
      workspace: this.workspace,
    };
  }
}

function admitAcceptance(value: unknown): {
  record: StoredRecord;
  replayed: boolean;
} {
  const snapshot = snapshotBoundedJson(value, "GitHub project context mutation result");
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, acceptanceKeys)) {
    throw new GitHubProjectContextStorageError();
  }
  if (typeof snapshot.replayed !== "boolean") {
    throw new GitHubProjectContextStorageError();
  }
  return {
    record: admitStoredRecord(snapshot.record),
    replayed: snapshot.replayed,
  };
}

function admitRows(value: unknown, limit: number): StoredRecord[] {
  const snapshot = snapshotBoundedJson(value, "GitHub project context query result");
  if (!Array.isArray(snapshot) || snapshot.length > limit) {
    throw new GitHubProjectContextStorageError();
  }
  return snapshot.map(admitStoredRecord);
}

function admitStoredRecord(value: unknown): StoredRecord {
  if (!isRecord(value) || !hasExactKeys(value, recordKeys)) {
    throw new GitHubProjectContextStorageError();
  }
  const syncStatus = value.syncStatus;
  if (syncStatus !== "synchronized" && syncStatus !== "degraded") {
    throw new GitHubProjectContextStorageError();
  }
  const outcome = value.outcome;
  if (typeof outcome !== "string" || !outcomes.includes(
    outcome as GitHubIssueContextAcceptanceOutcome,
  )) {
    throw new GitHubProjectContextStorageError();
  }
  return {
    id: storedString(value.id),
    project: exactProject(storedString(value.project)),
    externalId: exactIssueExternalId(value.externalId),
    repositoryFullName: storedString(value.repositoryFullName),
    sourceRevision: storedString(value.sourceRevision),
    snapshotSha256: storedHash(value.snapshotSha256),
    contentSha256: storedHash(value.contentSha256),
    providerUpdatedAt: storedTimestamp(value.providerUpdatedAt),
    snapshotJson: storedString(value.snapshotJson),
    projectAttachmentId: storedString(value.projectAttachmentId),
    projectAttachmentSnapshotSha256: storedHash(
      value.projectAttachmentSnapshotSha256,
    ),
    instructionSetId: storedString(value.instructionSetId),
    instructionSetSha256: storedHash(value.instructionSetSha256),
    instructionSetJson: storedString(value.instructionSetJson),
    syncStatus,
    syncCursor: nullableStoredString(value.syncCursor),
    degradedReasonCode: nullableStoredString(value.degradedReasonCode),
    observationRef: storedString(value.observationRef),
    observedAt: storedTimestamp(value.observedAt),
    acceptedBy: storedString(value.acceptedBy),
    acceptedAt: storedTimestamp(value.acceptedAt),
    isCurrent: storedBoolean(value.isCurrent),
    outcome: outcome as GitHubIssueContextAcceptanceOutcome,
  };
}

function validateStoredRecord(raw: StoredRecord): AdmittedRecord {
  let snapshotValue: unknown;
  let instructionValue: unknown;
  try {
    snapshotValue = parseStrictJson(raw.snapshotJson, {
      maxBytes: 512_000,
      maxDepth: 20,
      maxStringLength: 131_072,
      maxObjectKeys: 128,
      maxArrayLength: 128,
      prefix: "GITHUB_PROJECT_CONTEXT_STORED_SNAPSHOT",
    });
    instructionValue = parseStrictJson(raw.instructionSetJson, {
      maxBytes: 128_000,
      maxDepth: 8,
      maxStringLength: 4_096,
      maxObjectKeys: 64,
      maxArrayLength: 32,
      prefix: "GITHUB_PROJECT_CONTEXT_STORED_INSTRUCTIONS",
    });
  } catch {
    throw new GitHubProjectContextStorageError();
  }
  const snapshot = admitGitHubIssueContextSnapshot(snapshotValue);
  const instructionSet = admitAcceptedRepositoryInstructionSet(instructionValue);
  const subject = admitGitHubIssueContextAcceptanceSubject({
    snapshot,
    instructionSet,
    syncStatus: raw.syncStatus,
    syncCursor: raw.syncCursor,
    degradedReasonCode: raw.degradedReasonCode,
    observationRef: raw.observationRef,
    observedAt: raw.observedAt,
    acceptedBy: raw.acceptedBy,
  });
  if (
    canonicalGitHubIssueContextJson(snapshot) !== raw.snapshotJson
    || canonicalRepositoryInstructionSetJson(instructionSet) !== raw.instructionSetJson
    || snapshot.reference.externalId !== raw.externalId
    || snapshot.reference.repositoryFullName !== raw.repositoryFullName
    || snapshot.sourceRevision !== raw.sourceRevision
    || snapshot.snapshotSha256 !== raw.snapshotSha256
    || snapshot.contentSha256 !== raw.contentSha256
    || snapshot.updatedAt !== raw.providerUpdatedAt
    || instructionSet.projectAttachmentId !== raw.projectAttachmentId
    || instructionSet.projectAttachmentSnapshotSha256
      !== raw.projectAttachmentSnapshotSha256
    || instructionSet.id !== raw.instructionSetId
    || instructionSet.sha256 !== raw.instructionSetSha256
    || Date.parse(subject.observedAt)
      > Date.parse(raw.acceptedAt) + maximumObservationFutureSkewMs
  ) {
    throw new GitHubProjectContextStorageError();
  }
  return { raw, snapshot, instructionSet };
}

function matchesSubject(
  record: AdmittedRecord,
  project: string,
  subject: GitHubIssueContextAcceptanceSubject,
): boolean {
  return record.raw.project === project
    && record.snapshot.snapshotSha256 === subject.snapshot.snapshotSha256
    && record.instructionSet.id === subject.instructionSet.id
    && record.raw.syncStatus === subject.syncStatus
    && record.raw.syncCursor === subject.syncCursor
    && record.raw.degradedReasonCode === subject.degradedReasonCode
    && record.raw.observationRef === subject.observationRef
    && record.raw.observedAt === subject.observedAt
    && record.raw.acceptedBy === subject.acceptedBy;
}

function buildProjection(
  workspace: string,
  project: string,
  requestedExternalId: string | null,
  records: readonly AdmittedRecord[],
  history: readonly AdmittedRecord[],
): GitHubProjectContextProjection {
  const issues = records.map(projectIssue);
  return Object.freeze({
    version: 1 as const,
    workspace,
    project,
    mode: requestedExternalId === null ? "project" as const : "issue" as const,
    requestedExternalId,
    issues,
    history: history.map(projectHistory),
    recovery: {
      canonicalSource: "github" as const,
      stensiblyProjection: "last_known_accepted_context" as const,
      incidentUrl: "https://github.com/teamleaderleo/stensibly/issues/490" as const,
      directGitHubUrls: issues.map((issue) => issue.canonicalUrl),
      guidance: recoveryGuidance.map((entry) => ({ ...entry })),
    },
  });
}

function projectIssue(record: AdmittedRecord): GitHubIssueContextProjection {
  const { raw, snapshot, instructionSet } = record;
  return {
    externalId: raw.externalId,
    canonicalUrl: snapshot.reference.canonicalUrl,
    repositoryFullName: snapshot.reference.repositoryFullName,
    issueNumber: snapshot.reference.number,
    title: snapshot.title,
    state: snapshot.state,
    stateReason: snapshot.stateReason,
    labels: [...snapshot.labels],
    assignees: [...snapshot.assignees],
    milestone: snapshot.milestone ? { ...snapshot.milestone } : null,
    relationships: snapshot.relationships.map((relationship) => ({
      kind: relationship.kind,
      externalId: relationship.target.externalId,
      canonicalUrl: relationship.target.canonicalUrl,
    })),
    provider: {
      sourceRevision: snapshot.sourceRevision,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    },
    synchronization: {
      status: raw.syncStatus,
      degradedReasonCode: raw.degradedReasonCode,
      observedAt: raw.observedAt,
      acceptedAt: raw.acceptedAt,
      acceptedBy: raw.acceptedBy,
      outcome: raw.outcome,
    },
    instructions: {
      id: instructionSet.id,
      sourcePaths: instructionSet.sources.map((source) => source.path),
    },
  };
}

function projectHistory(record: AdmittedRecord): GitHubIssueContextHistoryProjection {
  const { raw, snapshot, instructionSet } = record;
  return {
    externalId: raw.externalId,
    sourceRevision: snapshot.sourceRevision,
    providerUpdatedAt: snapshot.updatedAt,
    synchronizationStatus: raw.syncStatus,
    degradedReasonCode: raw.degradedReasonCode,
    observedAt: raw.observedAt,
    acceptedAt: raw.acceptedAt,
    outcome: raw.outcome,
    isCurrent: raw.isCurrent,
    instructionSetId: instructionSet.id,
  };
}

function mapStorageError(error: unknown): Error {
  if (error instanceof GitHubProjectContextConflictError) return error;
  if (error instanceof GitHubProjectContextStorageError) return error;
  const message = ownDataErrorMessage(error);
  if (
    message.includes("GITHUB_PROJECT_CONTEXT_OBSERVATION_CONFLICT")
    || message.includes("GITHUB_PROJECT_CONTEXT_SOURCE_REVISION_CONFLICT")
  ) return new GitHubProjectContextConflictError();
  return new GitHubProjectContextStorageError();
}

function ownDataErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : "";
}

function exactWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("Workspace must be an exact lowercase slug up to 80 characters");
  }
  return value;
}

function exactProject(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("GitHub project context project is invalid");
  }
  return value;
}

function exactIssueExternalId(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError("GitHub issue external ID is invalid");
  }
  const match = /^github:([a-z0-9](?:[a-z0-9-]{0,38}))\/([a-z0-9_.-]{1,100})#([1-9][0-9]*)$/u.exec(value);
  if (!match || match[2]?.includes("..")) {
    throw new RangeError("GitHub issue external ID is invalid");
  }
  return `github:${match[1]}/${match[2]}#${match[3]}`;
}

function boundedLimit(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}`);
  }
  return value;
}

function storedString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512_000) {
    throw new GitHubProjectContextStorageError();
  }
  return value;
}

function nullableStoredString(value: unknown): string | null {
  return value === null ? null : storedString(value);
}

function storedHash(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new GitHubProjectContextStorageError();
  }
  return value;
}

function storedTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || new Date(value).toISOString() !== value
  ) throw new GitHubProjectContextStorageError();
  return value;
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new GitHubProjectContextStorageError();
  return value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) throw new Error(`${label} is required`);
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const sortedExpected = [...expected].sort(codeUnitCompare);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
