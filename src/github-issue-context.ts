import { createHash } from "node:crypto";

export const githubIssueRelationshipKinds = [
  "parent",
  "sub_issue",
  "blocked_by",
  "blocks",
  "related",
] as const;

export type GitHubIssueRelationshipKind = typeof githubIssueRelationshipKinds[number];
export type GitHubIssueState = "open" | "closed";
export type GitHubIssueStateReason = "completed" | "not_planned" | "reopened" | null;

export interface GitHubIssueReferenceInput {
  owner: string;
  repository: string;
  number: number;
}

export interface GitHubIssueReference {
  provider: "github";
  host: "github.com";
  owner: string;
  repository: string;
  repositoryFullName: string;
  number: number;
  externalId: string;
  canonicalUrl: string;
}

export interface GitHubIssueRelationshipInput {
  kind: GitHubIssueRelationshipKind;
  target: GitHubIssueReferenceInput;
}

export interface GitHubIssueContextInput extends GitHubIssueReferenceInput {
  title: string;
  body?: string | null;
  state: GitHubIssueState;
  stateReason?: GitHubIssueStateReason;
  labels?: readonly string[];
  assignees?: readonly string[];
  milestone?: {
    number: number;
    title: string;
  } | null;
  relationships?: readonly GitHubIssueRelationshipInput[];
  createdAt: string;
  updatedAt: string;
  providerNodeId?: string | null;
  sourceRevision: string;
}

export interface GitHubIssueContext {
  version: 1;
  provider: "github";
  reference: GitHubIssueReference;
  title: string;
  bodyRevision: {
    present: boolean;
    byteLength: number;
    sha256: string;
  };
  state: GitHubIssueState;
  stateReason: GitHubIssueStateReason;
  labels: string[];
  assignees: string[];
  milestone: {
    number: number;
    title: string;
  } | null;
  relationships: Array<{
    kind: GitHubIssueRelationshipKind;
    target: GitHubIssueReference;
  }>;
  createdAt: string;
  updatedAt: string;
  providerNodeId: string | null;
  sourceRevision: string;
  contentSha256: string;
  snapshotSha256: string;
  containsIssueBody: false;
}

export type GitHubIssueContextComparison =
  | {
    outcome: "different_issue";
    externalId: string;
    previousExternalId: string;
  }
  | {
    outcome: "identical";
    externalId: string;
    sourceRevision: string;
  }
  | {
    outcome: "altered_revision_conflict";
    externalId: string;
    sourceRevision: string;
    changedFields: string[];
  }
  | {
    outcome: "stale" | "updated";
    externalId: string;
    previousSourceRevision: string;
    sourceRevision: string;
    changedFields: string[];
  };

const limits = {
  owner: 39,
  repository: 100,
  title: 256,
  bodyBytes: 128 * 1024,
  labels: 100,
  label: 100,
  assignees: 100,
  relationships: 100,
  milestoneTitle: 256,
  sourceRevision: 512,
  providerNodeId: 256,
} as const;

const githubOwnerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const githubRepositoryPattern = /^[A-Za-z0-9_.-]+$/;
const sourceRevisionPattern = /^[A-Za-z0-9._:/@#-]+$/;
const providerNodeIdPattern = /^[A-Za-z0-9_:-]+$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const unsafeDisplayTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** Builds one stable GitHub issue identity and canonical public URL. */
export function buildGitHubIssueReference(
  input: GitHubIssueReferenceInput,
): GitHubIssueReference {
  if (!isRecord(input)) throw new RangeError("GitHub issue reference must be an object");
  const owner = boundedGitHubOwner(input.owner);
  const repository = boundedGitHubRepository(input.repository);
  const number = positiveInteger(input.number, "GitHub issue number");
  const repositoryFullName = `${owner}/${repository}`;
  return deepFreeze({
    provider: "github",
    host: "github.com",
    owner,
    repository,
    repositoryFullName,
    number,
    externalId: `github:${repositoryFullName}#${number}`,
    canonicalUrl: `https://github.com/${repositoryFullName}/issues/${number}`,
  });
}

/** Parses only the canonical github:owner/repository#number identity form. */
export function parseGitHubIssueExternalId(value: string): GitHubIssueReference {
  if (typeof value !== "string") throw new RangeError("GitHub issue external ID must be a string");
  const match = /^github:([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(value.trim());
  if (!match) throw new RangeError("GitHub issue external ID is invalid");
  return buildGitHubIssueReference({
    owner: match[1]!,
    repository: match[2]!,
    number: Number(match[3]),
  });
}

/**
 * Builds a bounded deterministic observation of one GitHub issue.
 * The issue body is hashed and counted but is not copied into the snapshot.
 */
export function buildGitHubIssueContext(
  input: GitHubIssueContextInput,
): GitHubIssueContext {
  if (!isRecord(input)) throw new RangeError("GitHub issue context must be an object");
  const reference = buildGitHubIssueReference(input);
  const title = boundedDisplayText(input.title, "GitHub issue title", limits.title);
  const body = canonicalBody(input.body ?? null);
  const state = exactEnum(input.state, ["open", "closed"] as const, "GitHub issue state");
  const stateReason = input.stateReason === undefined || input.stateReason === null
    ? null
    : exactEnum(
      input.stateReason,
      ["completed", "not_planned", "reopened"] as const,
      "GitHub issue state reason",
    );
  const labels = canonicalDisplayList(input.labels ?? [], "GitHub issue labels", limits.labels, limits.label);
  const assignees = canonicalAssignees(input.assignees ?? []);
  const milestone = canonicalMilestone(input.milestone ?? null);
  const relationships = canonicalRelationships(
    input.relationships ?? [],
    reference.externalId,
  );
  const createdAt = canonicalTimestamp(input.createdAt, "GitHub issue created time");
  const updatedAt = canonicalTimestamp(input.updatedAt, "GitHub issue updated time");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RangeError("GitHub issue updated time must not precede creation time");
  }
  const providerNodeId = input.providerNodeId === undefined || input.providerNodeId === null
    ? null
    : boundedPattern(
      input.providerNodeId,
      "GitHub provider node ID",
      limits.providerNodeId,
      providerNodeIdPattern,
    );
  const sourceRevision = boundedPattern(
    input.sourceRevision,
    "GitHub issue source revision",
    limits.sourceRevision,
    sourceRevisionPattern,
  );

  const content = {
    version: 1 as const,
    provider: "github" as const,
    reference,
    title,
    bodyRevision: {
      present: body !== null,
      byteLength: body === null ? 0 : Buffer.byteLength(body, "utf8"),
      sha256: sha256(stableJson({ present: body !== null, body })),
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
  const contentSha256 = sha256(stableJson(content));
  const snapshot = {
    ...content,
    sourceRevision,
    contentSha256,
  };
  return deepFreeze({
    ...snapshot,
    snapshotSha256: sha256(stableJson(snapshot)),
  });
}

/**
 * Compares provider observations without treating timestamps or source revisions as authority.
 * Same-revision changed content is an explicit altered-reuse conflict.
 */
export function compareGitHubIssueContexts(
  previous: GitHubIssueContext,
  current: GitHubIssueContext,
): GitHubIssueContextComparison {
  validateContextFingerprint(previous, "Previous GitHub issue context");
  validateContextFingerprint(current, "Current GitHub issue context");
  if (previous.reference.externalId !== current.reference.externalId) {
    return {
      outcome: "different_issue",
      externalId: current.reference.externalId,
      previousExternalId: previous.reference.externalId,
    };
  }
  if (
    previous.sourceRevision === current.sourceRevision
    && previous.contentSha256 === current.contentSha256
  ) {
    return {
      outcome: "identical",
      externalId: current.reference.externalId,
      sourceRevision: current.sourceRevision,
    };
  }

  const changedFields = changedContextFields(previous, current);
  if (previous.sourceRevision === current.sourceRevision) {
    return {
      outcome: "altered_revision_conflict",
      externalId: current.reference.externalId,
      sourceRevision: current.sourceRevision,
      changedFields,
    };
  }
  return {
    outcome: Date.parse(current.updatedAt) < Date.parse(previous.updatedAt) ? "stale" : "updated",
    externalId: current.reference.externalId,
    previousSourceRevision: previous.sourceRevision,
    sourceRevision: current.sourceRevision,
    changedFields,
  };
}

function canonicalBody(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new RangeError("GitHub issue body must be a string or null");
  const normalized = value.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(normalized, "utf8") > limits.bodyBytes) {
    throw new RangeError(`GitHub issue body must be at most ${limits.bodyBytes} bytes`);
  }
  return normalized;
}

function canonicalAssignees(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > limits.assignees) {
    throw new RangeError(`GitHub issue assignees must contain at most ${limits.assignees} entries`);
  }
  const result = values.map((value) => boundedGitHubOwner(value));
  if (new Set(result).size !== result.length) {
    throw new RangeError("GitHub issue assignees must be unique");
  }
  return result.sort(codeUnitCompare);
}

function canonicalDisplayList(
  values: readonly string[],
  label: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(values) || values.length > maximumEntries) {
    throw new RangeError(`${label} must contain at most ${maximumEntries} entries`);
  }
  const result = values.map((value) => boundedDisplayText(value, label, maximumLength));
  if (new Set(result).size !== result.length) throw new RangeError(`${label} must be unique`);
  return result.sort(codeUnitCompare);
}

function canonicalMilestone(
  value: GitHubIssueContextInput["milestone"] | null,
): GitHubIssueContext["milestone"] {
  if (value === null) return null;
  if (!isRecord(value)) throw new RangeError("GitHub issue milestone must be an object or null");
  return {
    number: positiveInteger(value.number, "GitHub milestone number"),
    title: boundedDisplayText(value.title, "GitHub milestone title", limits.milestoneTitle),
  };
}

function canonicalRelationships(
  values: readonly GitHubIssueRelationshipInput[],
  sourceExternalId: string,
): GitHubIssueContext["relationships"] {
  if (!Array.isArray(values) || values.length > limits.relationships) {
    throw new RangeError(
      `GitHub issue relationships must contain at most ${limits.relationships} entries`,
    );
  }
  const seen = new Set<string>();
  const result = values.map((value) => {
    if (!isRecord(value)) throw new RangeError("GitHub issue relationship must be an object");
    const kind = exactEnum(
      value.kind,
      githubIssueRelationshipKinds,
      "GitHub issue relationship kind",
    );
    const target = buildGitHubIssueReference(value.target);
    if (target.externalId === sourceExternalId) {
      throw new RangeError("GitHub issue relationship must not target the source issue");
    }
    const key = `${kind}:${target.externalId}`;
    if (seen.has(key)) throw new RangeError("GitHub issue relationships must be unique");
    seen.add(key);
    return { kind, target };
  });
  return result.sort((left, right) =>
    codeUnitCompare(`${left.kind}:${left.target.externalId}`, `${right.kind}:${right.target.externalId}`)
  );
}

function changedContextFields(
  previous: GitHubIssueContext,
  current: GitHubIssueContext,
): string[] {
  const fields: Array<keyof GitHubIssueContext> = [
    "title",
    "bodyRevision",
    "state",
    "stateReason",
    "labels",
    "assignees",
    "milestone",
    "relationships",
    "createdAt",
    "updatedAt",
    "providerNodeId",
  ];
  return fields
    .filter((field) => stableJson(previous[field]) !== stableJson(current[field]))
    .map(String)
    .sort(codeUnitCompare);
}

function validateContextFingerprint(value: GitHubIssueContext, label: string): void {
  if (!isRecord(value)) throw new RangeError(`${label} must be an object`);
  const { snapshotSha256, ...snapshot } = value;
  if (typeof snapshotSha256 !== "string" || snapshotSha256 !== sha256(stableJson(snapshot))) {
    throw new RangeError(`${label} fingerprint is invalid`);
  }
}

function boundedGitHubOwner(value: string): string {
  const owner = boundedPattern(value, "GitHub owner", limits.owner, githubOwnerPattern);
  if (owner.includes("--")) throw new RangeError("GitHub owner is invalid");
  return owner.toLowerCase();
}

function boundedGitHubRepository(value: string): string {
  const repository = boundedPattern(
    value,
    "GitHub repository",
    limits.repository,
    githubRepositoryPattern,
  );
  if (repository === "." || repository === ".." || repository.includes("..")) {
    throw new RangeError("GitHub repository is invalid");
  }
  return repository.toLowerCase();
}

function boundedDisplayText(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  if (unsafeDisplayTextPattern.test(value)) throw new RangeError(`${label} contains unsafe characters`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > maximum) throw new RangeError(`${label} is invalid`);
  return normalized;
}

function boundedPattern(
  value: string,
  label: string,
  maximum: number,
  pattern: RegExp,
): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  if (unsafeDisplayTextPattern.test(value)) throw new RangeError(`${label} contains unsafe characters`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > maximum || !pattern.test(normalized)) {
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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
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

function sha256(value: string): string {
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
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
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
