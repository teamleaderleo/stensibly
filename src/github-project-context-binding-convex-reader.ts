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
} from "./github-project-context-admission.js";
import {
  parseGitHubIssueExternalId,
  type GitHubIssueContext,
} from "./github-issue-context.js";
import { GitHubProjectContextStorageError } from "./github-project-context-convex-ledger.js";
import { fingerprintCanonicalRequest } from "./idempotency-request-fingerprint.js";
import { parseStrictJson } from "./strict-json.js";

export const HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1 = 1 as const;

export interface GetHostedGitHubIssueContextBindingInput {
  project: string;
  externalId: string;
}

export interface HostedGitHubIssueContextBindingV1 {
  readonly version: typeof HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1;
  readonly workspace: string;
  readonly recordId: string;
  readonly project: string;
  readonly externalId: string;
  readonly repositoryFullName: string;
  readonly snapshot: GitHubIssueContext;
  readonly instructionSet: AcceptedRepositoryInstructionSet;
  readonly synchronization: {
    readonly status: "synchronized" | "degraded";
    readonly cursor: string | null;
    readonly degradedReasonCode: string | null;
    readonly observationRef: string;
    readonly observedAt: string;
    readonly acceptedBy: string;
    readonly acceptedAt: string;
    readonly outcome: GitHubIssueContextAcceptanceOutcome;
    readonly isCurrent: true;
  };
}

export interface HostedGitHubIssueContextBindingReader {
  getCurrentGitHubIssueContextBinding(
    input: GetHostedGitHubIssueContextBindingInput,
  ): Promise<HostedGitHubIssueContextBindingV1 | null>;
}

export interface ConvexGitHubProjectContextBindingReaderOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
  now?: () => number;
}

const getCurrentRef = makeFunctionReference<"query">(
  "githubProjectContexts:getCurrent",
);
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
const outcomes = [
  "initial",
  "updated",
  "stale",
  "instruction_rebound",
  "synchronization_updated",
] as const;
const maximumObservationFutureSkewMs = 5 * 60_000;

type StoredRecord = {
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
};

export class ConvexGitHubProjectContextBindingReader
  implements HostedGitHubIssueContextBindingReader {
  readonly client: ConvexCaller;
  readonly serviceSecret: string;
  readonly workspace: string;
  readonly now: () => number;

  constructor(options: ConvexGitHubProjectContextBindingReaderOptions) {
    this.client = options.client;
    this.serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.workspace = exactWorkspace(options.workspace ?? "default");
    this.now = options.now ?? Date.now;
  }

  async getCurrentGitHubIssueContextBinding(
    input: GetHostedGitHubIssueContextBindingInput,
  ): Promise<HostedGitHubIssueContextBindingV1 | null> {
    const project = exactProject(input.project);
    const externalId = exactIssueExternalId(input.externalId);
    try {
      const raw = await this.client.query(getCurrentRef, {
        serviceSecret: this.serviceSecret,
        workspace: this.workspace,
        project,
        externalId,
      });
      if (raw === null) return null;
      const record = admitStoredRecord(raw);
      const admitted = validateStoredRecord(record, exactServiceTime(this.now));
      if (
        record.project !== project
        || record.externalId !== externalId
        || record.isCurrent !== true
        || record.id !== deterministicRecordId(
          this.workspace,
          project,
          record.observationRef,
        )
      ) {
        throw new GitHubProjectContextStorageError();
      }
      return deepFreeze({
        version: HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1,
        workspace: this.workspace,
        recordId: record.id,
        project,
        externalId,
        repositoryFullName: record.repositoryFullName,
        snapshot: admitted.snapshot,
        instructionSet: admitted.instructionSet,
        synchronization: {
          status: record.syncStatus,
          cursor: record.syncCursor,
          degradedReasonCode: record.degradedReasonCode,
          observationRef: record.observationRef,
          observedAt: record.observedAt,
          acceptedBy: record.acceptedBy,
          acceptedAt: record.acceptedAt,
          outcome: record.outcome,
          isCurrent: true as const,
        },
      });
    } catch (error) {
      if (error instanceof GitHubProjectContextStorageError) throw error;
      throw new GitHubProjectContextStorageError();
    }
  }
}

function admitStoredRecord(value: unknown): StoredRecord {
  const record = exactDataRecord(value, recordKeys);
  const syncStatus = record.syncStatus;
  if (syncStatus !== "synchronized" && syncStatus !== "degraded") {
    throw new GitHubProjectContextStorageError();
  }
  const outcome = record.outcome;
  if (
    typeof outcome !== "string"
    || !outcomes.includes(outcome as GitHubIssueContextAcceptanceOutcome)
  ) {
    throw new GitHubProjectContextStorageError();
  }
  return {
    id: storedString(record.id),
    project: exactProject(storedString(record.project)),
    externalId: exactIssueExternalId(record.externalId),
    repositoryFullName: storedString(record.repositoryFullName),
    sourceRevision: storedString(record.sourceRevision),
    snapshotSha256: storedHash(record.snapshotSha256),
    contentSha256: storedHash(record.contentSha256),
    providerUpdatedAt: storedTimestamp(record.providerUpdatedAt),
    snapshotJson: storedString(record.snapshotJson),
    projectAttachmentId: storedString(record.projectAttachmentId),
    projectAttachmentSnapshotSha256: storedHash(
      record.projectAttachmentSnapshotSha256,
    ),
    instructionSetId: storedString(record.instructionSetId),
    instructionSetSha256: storedHash(record.instructionSetSha256),
    instructionSetJson: storedString(record.instructionSetJson),
    syncStatus,
    syncCursor: nullableStoredString(record.syncCursor),
    degradedReasonCode: nullableStoredString(record.degradedReasonCode),
    observationRef: storedString(record.observationRef),
    observedAt: storedTimestamp(record.observedAt),
    acceptedBy: storedString(record.acceptedBy),
    acceptedAt: storedTimestamp(record.acceptedAt),
    isCurrent: storedBoolean(record.isCurrent),
    outcome: outcome as GitHubIssueContextAcceptanceOutcome,
  };
}

function validateStoredRecord(
  raw: StoredRecord,
  serviceNow: number,
): {
  snapshot: GitHubIssueContext;
  instructionSet: AcceptedRepositoryInstructionSet;
} {
  let snapshotValue: unknown;
  let instructionValue: unknown;
  try {
    snapshotValue = parseStrictJson(raw.snapshotJson, {
      maxBytes: 512_000,
      maxDepth: 20,
      maxStringLength: 131_072,
      maxObjectKeys: 128,
      maxArrayLength: 128,
      prefix: "GITHUB_PROJECT_CONTEXT_BINDING_STORED_SNAPSHOT",
    });
    instructionValue = parseStrictJson(raw.instructionSetJson, {
      maxBytes: 128_000,
      maxDepth: 8,
      maxStringLength: 4_096,
      maxObjectKeys: 64,
      maxArrayLength: 32,
      prefix: "GITHUB_PROJECT_CONTEXT_BINDING_STORED_INSTRUCTIONS",
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
    || canonicalRepositoryInstructionSetJson(instructionSet)
      !== raw.instructionSetJson
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
    || Date.parse(raw.acceptedAt)
      > serviceNow + maximumObservationFutureSkewMs
  ) {
    throw new GitHubProjectContextStorageError();
  }
  return { snapshot, instructionSet };
}

function exactDataRecord<const K extends readonly string[]>(
  value: unknown,
  keys: K,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubProjectContextStorageError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GitHubProjectContextStorageError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) =>
      typeof key !== "string" || !(keys as readonly string[]).includes(key)
    )
  ) {
    throw new GitHubProjectContextStorageError();
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new GitHubProjectContextStorageError();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function deterministicRecordId(
  workspace: string,
  project: string,
  observationRef: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace,
    project,
    observationRef,
  });
  return `github_context_${digest.slice("sha256:".length)}`;
}

function exactServiceTime(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    throw new GitHubProjectContextStorageError();
  }
  if (!Number.isFinite(value)) throw new GitHubProjectContextStorageError();
  return value;
}

function exactWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError(
      "Workspace must be an exact lowercase slug up to 80 characters",
    );
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
  const externalId = parseGitHubIssueExternalId(value).externalId;
  if (externalId !== value) {
    throw new RangeError("GitHub issue external ID must be canonical");
  }
  return externalId;
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
  ) {
    throw new GitHubProjectContextStorageError();
  }
  return value;
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new GitHubProjectContextStorageError();
  return value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
