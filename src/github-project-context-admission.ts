import type { GitHubIssueContext } from "./github-issue-context.js";
import { snapshotBoundedJson } from "./github-repository-observation-admission.js";
import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "./idempotency-request-fingerprint.js";

export const githubIssueContextSyncStatuses = [
  "synchronized",
  "degraded",
] as const;
export type GitHubIssueContextSyncStatus =
  typeof githubIssueContextSyncStatuses[number];

export const githubIssueContextAcceptanceOutcomes = [
  "initial",
  "updated",
  "stale",
  "instruction_rebound",
  "synchronization_updated",
] as const;
export type GitHubIssueContextAcceptanceOutcome =
  typeof githubIssueContextAcceptanceOutcomes[number];

export interface RepositoryInstructionSourceInput {
  path: string;
  revision: string;
  contentSha256: string;
}

export interface AcceptedRepositoryInstructionSet {
  version: 1;
  id: string;
  projectAttachmentId: string;
  projectAttachmentSnapshotSha256: string;
  sources: RepositoryInstructionSourceInput[];
  sha256: string;
}

export interface GitHubIssueContextAcceptanceSubject {
  snapshot: GitHubIssueContext;
  instructionSet: AcceptedRepositoryInstructionSet;
  syncStatus: GitHubIssueContextSyncStatus;
  syncCursor: string | null;
  degradedReasonCode: string | null;
  observationRef: string;
  observedAt: string;
  acceptedBy: string;
}

export interface GitHubIssueContextCurrentEvidence {
  sourceRevision: string;
  contentSha256: string;
  providerUpdatedAt: string;
  instructionSetId: string;
  observedAt: string;
}

export interface GitHubIssueContextClassification {
  outcome: GitHubIssueContextAcceptanceOutcome;
  isCurrent: boolean;
}

const snapshotKeys = [
  "assignees",
  "bodyRevision",
  "containsIssueBody",
  "contentSha256",
  "createdAt",
  "labels",
  "milestone",
  "provider",
  "providerNodeId",
  "reference",
  "relationships",
  "snapshotSha256",
  "sourceRevision",
  "state",
  "stateReason",
  "title",
  "updatedAt",
  "version",
] as const;
const referenceKeys = [
  "canonicalUrl",
  "externalId",
  "host",
  "number",
  "owner",
  "provider",
  "repository",
  "repositoryFullName",
] as const;
const bodyRevisionKeys = ["byteLength", "present", "sha256"] as const;
const milestoneKeys = ["number", "title"] as const;
const relationshipKeys = ["kind", "target"] as const;
const instructionSetKeys = [
  "id",
  "projectAttachmentId",
  "projectAttachmentSnapshotSha256",
  "sha256",
  "sources",
  "version",
] as const;
const instructionSourceKeys = ["contentSha256", "path", "revision"] as const;
const acceptanceKeys = [
  "acceptedBy",
  "degradedReasonCode",
  "instructionSet",
  "observationRef",
  "observedAt",
  "snapshot",
  "syncCursor",
  "syncStatus",
] as const;

const relationshipKinds = [
  "parent",
  "sub_issue",
  "blocked_by",
  "blocks",
  "related",
] as const;
const stateReasons = ["completed", "not_planned", "reopened"] as const;
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/u;
const repositoryPattern = /^[a-z0-9_.-]+$/u;
const sourceRevisionPattern = /^[A-Za-z0-9._:/@#-]+$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/u;
const reasonCodePattern = /^[a-z0-9][a-z0-9._-]*$/u;
const providerNodeIdPattern = /^[A-Za-z0-9_:-]+$/u;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const credentialPattern =
  /(?:^|[._:/-])(?:(?:env|secret):\/\/|bearer(?:[._:/-]|$)|github_pat_|gh[pousr]_|stn\.tok_|sk-|xox[baprs]-|eyJ[a-zA-Z0-9_-]{8,}\.)/iu;

export function admitGitHubIssueContextSnapshot(
  value: unknown,
): GitHubIssueContext {
  const snapshot = exactRecord(
    snapshotBoundedJson(value, "GitHub issue context snapshot"),
    "GitHub issue context snapshot",
    snapshotKeys,
  );
  if (
    snapshot.version !== 1
    || snapshot.provider !== "github"
    || snapshot.containsIssueBody !== false
  ) {
    throw new RangeError("GitHub issue context snapshot metadata is invalid");
  }

  const reference = admitReference(snapshot.reference, "GitHub issue reference");
  const title = canonicalDisplayText(snapshot.title, "GitHub issue title", 256);
  const bodyRevision = exactRecord(
    snapshot.bodyRevision,
    "GitHub issue body revision",
    bodyRevisionKeys,
  );
  const bodyPresent = exactBoolean(
    bodyRevision.present,
    "GitHub issue body presence",
  );
  const bodyByteLength = boundedInteger(
    bodyRevision.byteLength,
    "GitHub issue body byte length",
    0,
    128 * 1024,
  );
  const bodySha256 = exactHash(
    bodyRevision.sha256,
    "GitHub issue body fingerprint",
  );
  if (!bodyPresent && bodyByteLength !== 0) {
    throw new RangeError("Absent GitHub issue body must have zero bytes");
  }

  const state = enumValue(
    snapshot.state,
    "GitHub issue state",
    ["open", "closed"] as const,
  );
  const stateReason = snapshot.stateReason === null
    ? null
    : enumValue(
      snapshot.stateReason,
      "GitHub issue state reason",
      stateReasons,
    );
  const labels = canonicalDisplayList(
    snapshot.labels,
    "GitHub issue labels",
    100,
    100,
  );
  const assignees = canonicalOwnerList(snapshot.assignees);
  const milestone = snapshot.milestone === null
    ? null
    : admitMilestone(snapshot.milestone);
  const relationships = admitRelationships(
    snapshot.relationships,
    reference.externalId,
  );
  const createdAt = exactTimestamp(
    snapshot.createdAt,
    "GitHub issue created time",
  );
  const updatedAt = exactTimestamp(
    snapshot.updatedAt,
    "GitHub issue updated time",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RangeError(
      "GitHub issue updated time must not precede creation time",
    );
  }
  const providerNodeId = snapshot.providerNodeId === null
    ? null
    : exactPatternText(
      snapshot.providerNodeId,
      "GitHub provider node ID",
      256,
      providerNodeIdPattern,
    );
  const sourceRevision = exactCredentialSafePatternText(
    snapshot.sourceRevision,
    "GitHub issue source revision",
    512,
    sourceRevisionPattern,
  );
  const contentSha256 = exactHash(
    snapshot.contentSha256,
    "GitHub issue content fingerprint",
  );
  const snapshotSha256 = exactHash(
    snapshot.snapshotSha256,
    "GitHub issue snapshot fingerprint",
  );

  const content = {
    version: 1 as const,
    provider: "github" as const,
    reference,
    title,
    bodyRevision: {
      present: bodyPresent,
      byteLength: bodyByteLength,
      sha256: bodySha256,
    },
    state,
    stateReason,
    labels,
    assignees,
    milestone,
    relationships,
    createdAt,
    updatedAt,
    providerNodeId,
    containsIssueBody: false as const,
  };
  if (fingerprintCanonicalRequest(content) !== contentSha256) {
    throw new RangeError("GitHub issue content fingerprint is invalid");
  }
  const withoutSnapshotFingerprint = {
    ...content,
    sourceRevision,
    contentSha256,
  };
  if (
    fingerprintCanonicalRequest(withoutSnapshotFingerprint)
      !== snapshotSha256
  ) {
    throw new RangeError("GitHub issue snapshot fingerprint is invalid");
  }
  return deepFreeze({
    ...withoutSnapshotFingerprint,
    snapshotSha256,
  });
}

export function buildAcceptedRepositoryInstructionSet(
  value: unknown,
): AcceptedRepositoryInstructionSet {
  const record = exactRecord(
    snapshotBoundedJson(value, "Repository instruction binding"),
    "Repository instruction binding",
    [
      "projectAttachmentId",
      "projectAttachmentSnapshotSha256",
      "sources",
    ] as const,
  );
  const projectAttachmentId = exactCredentialSafeIdentifier(
    record.projectAttachmentId,
    "Project attachment ID",
    240,
  );
  const projectAttachmentSnapshotSha256 = exactHash(
    record.projectAttachmentSnapshotSha256,
    "Project attachment snapshot fingerprint",
  );
  const sourcesValue = exactArray(
    record.sources,
    "Repository instruction sources",
    1,
    32,
  );
  const seen = new Set<string>();
  const sources = sourcesValue.map((entry) => {
    const source = exactRecord(
      entry,
      "Repository instruction source",
      instructionSourceKeys,
    );
    const path = exactSourcePath(source.path);
    if (seen.has(path)) {
      throw new RangeError(
        "Repository instruction source paths must be unique",
      );
    }
    seen.add(path);
    return {
      path,
      revision: exactCredentialSafeIdentifier(
        source.revision,
        "Repository instruction source revision",
        512,
      ),
      contentSha256: exactHash(
        source.contentSha256,
        "Repository instruction source fingerprint",
      ),
    };
  }).sort((left, right) => codeUnitCompare(left.path, right.path));
  const canonical = {
    version: 1 as const,
    projectAttachmentId,
    projectAttachmentSnapshotSha256,
    sources,
  };
  const sha256 = fingerprintCanonicalRequest(canonical);
  return deepFreeze({
    ...canonical,
    id: `instructions_${sha256.slice("sha256:".length)}`,
    sha256,
  });
}

export function admitAcceptedRepositoryInstructionSet(
  value: unknown,
): AcceptedRepositoryInstructionSet {
  const record = exactRecord(
    snapshotBoundedJson(value, "Accepted repository instruction set"),
    "Accepted repository instruction set",
    instructionSetKeys,
  );
  const rebuilt = buildAcceptedRepositoryInstructionSet({
    projectAttachmentId: record.projectAttachmentId,
    projectAttachmentSnapshotSha256:
      record.projectAttachmentSnapshotSha256,
    sources: record.sources,
  });
  if (
    canonicalJsonString(record.sources)
      !== canonicalJsonString(rebuilt.sources)
  ) {
    throw new RangeError(
      "Accepted repository instruction sources must use canonical order",
    );
  }
  if (
    record.version !== 1
    || record.id !== rebuilt.id
    || record.sha256 !== rebuilt.sha256
  ) {
    throw new RangeError(
      "Accepted repository instruction set fingerprint is invalid",
    );
  }
  return rebuilt;
}

export function admitGitHubIssueContextAcceptanceSubject(
  value: unknown,
): GitHubIssueContextAcceptanceSubject {
  const record = exactRecord(
    snapshotBoundedJson(value, "GitHub issue context acceptance"),
    "GitHub issue context acceptance",
    acceptanceKeys,
  );
  const snapshot = admitGitHubIssueContextSnapshot(record.snapshot);
  const instructionSet = admitAcceptedRepositoryInstructionSet(
    record.instructionSet,
  );
  const syncStatus = enumValue(
    record.syncStatus,
    "GitHub issue synchronization status",
    githubIssueContextSyncStatuses,
  );
  const degradedReasonCode = record.degradedReasonCode === null
    ? null
    : exactPatternText(
      record.degradedReasonCode,
      "GitHub synchronization degraded reason",
      160,
      reasonCodePattern,
    );
  if (syncStatus === "degraded" && degradedReasonCode === null) {
    throw new RangeError(
      "Degraded GitHub issue synchronization requires a reason code",
    );
  }
  if (syncStatus === "synchronized" && degradedReasonCode !== null) {
    throw new RangeError(
      "Synchronized GitHub issue context cannot carry a degraded reason",
    );
  }
  return deepFreeze({
    snapshot,
    instructionSet,
    syncStatus,
    syncCursor: record.syncCursor === null
      ? null
      : exactCredentialSafeIdentifier(
        record.syncCursor,
        "GitHub synchronization cursor",
        512,
      ),
    degradedReasonCode,
    observationRef: exactCredentialSafeIdentifier(
      record.observationRef,
      "GitHub observation reference",
      240,
    ),
    observedAt: exactTimestamp(
      record.observedAt,
      "GitHub observation time",
    ),
    acceptedBy: exactCredentialSafeIdentifier(
      record.acceptedBy,
      "GitHub context accepting actor",
      240,
    ),
  });
}

export function classifyGitHubIssueContextAcceptance(
  current: GitHubIssueContextCurrentEvidence | null,
  candidate: {
    snapshot: GitHubIssueContext;
    instructionSetId: string;
    observedAt: string;
  },
): GitHubIssueContextClassification {
  const snapshot = admitGitHubIssueContextSnapshot(candidate.snapshot);
  const instructionSetId = exactCredentialSafeIdentifier(
    candidate.instructionSetId,
    "Repository instruction set ID",
    240,
  );
  const observedAt = exactTimestamp(
    candidate.observedAt,
    "GitHub observation time",
  );
  if (current === null) {
    return Object.freeze({ outcome: "initial", isCurrent: true });
  }
  const admittedCurrent = admitCurrentEvidence(current);

  // Observation chronology is authoritative for acceptance ordering. An older
  // observation remains history even when its instruction binding differs.
  if (Date.parse(observedAt) < Date.parse(admittedCurrent.observedAt)) {
    return Object.freeze({ outcome: "stale", isCurrent: false });
  }
  if (admittedCurrent.sourceRevision === snapshot.sourceRevision) {
    if (admittedCurrent.contentSha256 !== snapshot.contentSha256) {
      throw new RangeError(
        `GitHub issue source revision ${snapshot.sourceRevision} was reused with altered content`,
      );
    }
    if (admittedCurrent.instructionSetId !== instructionSetId) {
      return Object.freeze({
        outcome: "instruction_rebound",
        isCurrent: true,
      });
    }
    return Object.freeze({
      outcome: "synchronization_updated",
      isCurrent: true,
    });
  }
  if (
    Date.parse(snapshot.updatedAt)
      < Date.parse(admittedCurrent.providerUpdatedAt)
  ) {
    return Object.freeze({ outcome: "stale", isCurrent: false });
  }
  return Object.freeze({ outcome: "updated", isCurrent: true });
}

export function canonicalGitHubIssueContextJson(
  value: unknown,
): string {
  return canonicalJsonString(admitGitHubIssueContextSnapshot(value));
}

export function canonicalRepositoryInstructionSetJson(
  value: unknown,
): string {
  return canonicalJsonString(admitAcceptedRepositoryInstructionSet(value));
}

function admitCurrentEvidence(
  value: GitHubIssueContextCurrentEvidence,
): GitHubIssueContextCurrentEvidence {
  const record = exactRecord(
    snapshotBoundedJson(value, "Current GitHub issue context evidence"),
    "Current GitHub issue context evidence",
    [
      "contentSha256",
      "instructionSetId",
      "observedAt",
      "providerUpdatedAt",
      "sourceRevision",
    ] as const,
  );
  return Object.freeze({
    sourceRevision: exactCredentialSafePatternText(
      record.sourceRevision,
      "Current GitHub issue source revision",
      512,
      sourceRevisionPattern,
    ),
    contentSha256: exactHash(
      record.contentSha256,
      "Current GitHub issue content fingerprint",
    ),
    providerUpdatedAt: exactTimestamp(
      record.providerUpdatedAt,
      "Current GitHub provider update time",
    ),
    instructionSetId: exactCredentialSafeIdentifier(
      record.instructionSetId,
      "Current repository instruction set ID",
      240,
    ),
    observedAt: exactTimestamp(
      record.observedAt,
      "Current GitHub observation time",
    ),
  });
}

function admitReference(value: unknown, label: string) {
  const record = exactRecord(value, label, referenceKeys);
  if (record.provider !== "github" || record.host !== "github.com") {
    throw new RangeError(`${label} metadata is invalid`);
  }
  const owner = exactPatternText(
    record.owner,
    "GitHub owner",
    39,
    ownerPattern,
  );
  const repository = exactPatternText(
    record.repository,
    "GitHub repository",
    100,
    repositoryPattern,
  );
  if (repository === "." || repository === ".." || repository.includes("..")) {
    throw new RangeError("GitHub repository is invalid");
  }
  const number = boundedInteger(
    record.number,
    "GitHub issue number",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const repositoryFullName = `${owner}/${repository}`;
  const externalId = `github:${repositoryFullName}#${number}`;
  const canonicalUrl =
    `https://github.com/${repositoryFullName}/issues/${number}`;
  if (
    record.repositoryFullName !== repositoryFullName
    || record.externalId !== externalId
    || record.canonicalUrl !== canonicalUrl
  ) {
    throw new RangeError(`${label} identity is not canonical`);
  }
  return deepFreeze({
    provider: "github" as const,
    host: "github.com" as const,
    owner,
    repository,
    repositoryFullName,
    number,
    externalId,
    canonicalUrl,
  });
}

function admitMilestone(value: unknown) {
  const record = exactRecord(
    value,
    "GitHub issue milestone",
    milestoneKeys,
  );
  return deepFreeze({
    number: boundedInteger(
      record.number,
      "GitHub milestone number",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    title: canonicalDisplayText(
      record.title,
      "GitHub milestone title",
      256,
    ),
  });
}

function admitRelationships(value: unknown, sourceExternalId: string) {
  const entries = exactArray(
    value,
    "GitHub issue relationships",
    0,
    100,
  );
  const seen = new Set<string>();
  const result = entries.map((entry) => {
    const record = exactRecord(
      entry,
      "GitHub issue relationship",
      relationshipKeys,
    );
    const kind = enumValue(
      record.kind,
      "GitHub issue relationship kind",
      relationshipKinds,
    );
    const target = admitReference(
      record.target,
      "GitHub issue relationship target",
    );
    if (target.externalId === sourceExternalId) {
      throw new RangeError(
        "GitHub issue relationship must not target the source issue",
      );
    }
    const identity = `${kind}:${target.externalId}`;
    if (seen.has(identity)) {
      throw new RangeError("GitHub issue relationships must be unique");
    }
    seen.add(identity);
    return deepFreeze({ kind, target });
  });
  const sorted = [...result].sort((left, right) =>
    codeUnitCompare(
      `${left.kind}:${left.target.externalId}`,
      `${right.kind}:${right.target.externalId}`,
    )
  );
  if (canonicalJsonString(result) !== canonicalJsonString(sorted)) {
    throw new RangeError(
      "GitHub issue relationships must use canonical order",
    );
  }
  return deepFreeze(sorted);
}

function canonicalDisplayList(
  value: unknown,
  label: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  const entries = exactArray(value, label, 0, maximumEntries);
  const result = entries.map((entry) =>
    canonicalDisplayText(entry, label, maximumLength)
  );
  requireCanonicalUniqueStrings(result, label);
  return deepFreeze([...result]);
}

function canonicalOwnerList(value: unknown): string[] {
  const entries = exactArray(value, "GitHub issue assignees", 0, 100);
  const result = entries.map((entry) =>
    exactPatternText(entry, "GitHub issue assignee", 39, ownerPattern)
  );
  requireCanonicalUniqueStrings(result, "GitHub issue assignees");
  return deepFreeze([...result]);
}

function requireCanonicalUniqueStrings(
  values: readonly string[],
  label: string,
): void {
  if (new Set(values).size !== values.length) {
    throw new RangeError(`${label} must be unique`);
  }
  const sorted = [...values].sort(codeUnitCompare);
  if (values.some((value, index) => value !== sorted[index])) {
    throw new RangeError(`${label} must use canonical order`);
  }
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  label: string,
  keys: K,
): Record<K[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain data record`);
  }
  const actual = Object.keys(value as Record<string, unknown>)
    .sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new RangeError(`${label} has noncanonical fields`);
  }
  return value as Record<K[number], unknown>;
}

function exactArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new RangeError(
      `${label} must contain between ${minimum} and ${maximum} entries`,
    );
  }
  return value;
}

function exactSourcePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new RangeError("Repository instruction source path is invalid");
  }
  if (
    value.length < 1
    || value.length > 240
    || value !== value.replace(/\\/gu, "/")
    || value.startsWith("/")
    || value.endsWith("/")
    || unsafeTextPattern.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new RangeError("Repository instruction source path is invalid");
  }
  return value;
}

function canonicalDisplayText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || unsafeTextPattern.test(value)
    || value !== value.normalize("NFKC").trim()
    || [...value].length > maximum
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactPatternText(
  value: unknown,
  label: string,
  maximum: number,
  pattern: RegExp,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || unsafeTextPattern.test(value)
    || !pattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function exactCredentialSafePatternText(
  value: unknown,
  label: string,
  maximum: number,
  pattern: RegExp,
): string {
  const text = exactPatternText(value, label, maximum, pattern);
  if (credentialPattern.test(text)) {
    throw new RangeError(`${label} cannot be credential-shaped`);
  }
  return text;
}

function exactCredentialSafeIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  return exactCredentialSafePatternText(
    value,
    label,
    maximum,
    identifierPattern,
  );
}

function exactHash(value: unknown, label: string): string {
  return exactPatternText(value, label, 71, hashPattern);
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new RangeError(`${label} must be an exact UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    throw new RangeError(`${label} must be an exact UTC timestamp`);
  }
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < minimum
    || value > maximum
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new RangeError(`${label} is invalid`);
  }
  return value as T[number];
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
