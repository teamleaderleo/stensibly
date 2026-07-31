import { v } from "convex/values";
import { canonicalJsonString, fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumObservationBytes = 64 * 1024;
const maximumRecent = 100;
const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const repositoryPattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;
const actionPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const actorPattern = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\[bot\])?$/u;
const factKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const providerIdPattern = /^[1-9][0-9]{0,39}$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const eventTypes = [
  "push",
  "create",
  "delete",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
] as const;
const subjectKinds = [
  "repository",
  "revision",
  "ref",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue",
  "issue_comment",
] as const;
const topLevelKeys = [
  "action",
  "actor",
  "containsRawContent",
  "contentRevisions",
  "deliveryId",
  "eventType",
  "facts",
  "observationId",
  "payloadDigest",
  "provider",
  "receivedAt",
  "relationships",
  "repository",
  "semanticFingerprint",
  "sourceSchema",
  "sourceSchemaVersion",
  "sourceTime",
  "sourceTimeSource",
  "subject",
  "version",
] as const;
const subjectKeys = ["externalId", "kind"] as const;
const relationshipKeys = [
  "baseRevision",
  "commentId",
  "issueNumber",
  "mergeRevision",
  "previousRevision",
  "pullRequestNumber",
  "ref",
  "refType",
  "repository",
  "revision",
] as const;
const contentRevisionKeys = ["byteLength", "name", "present", "sha256"] as const;
const contentRevisionNames = ["body", "comment_body", "review_body", "title"] as const;

export const ingest = mutation({
  args: {
    ...serviceArgs,
    deliveryId: v.string(),
    eventType: v.string(),
    payloadDigest: v.string(),
    receivedAt: v.number(),
    observationJson: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("GITHUB_REPOSITORY_OBSERVATION_WORKSPACE_NOT_FOUND");
    const input = parseInput(args);

    const existingDelivery = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_delivery", (q) =>
        q.eq("workspaceId", workspace._id).eq("deliveryId", input.deliveryId),
      )
      .unique();
    if (existingDelivery) {
      if (!isExactReplay(existingDelivery, input)) {
        throw new Error("GITHUB_REPOSITORY_DELIVERY_CONFLICT");
      }
      return { duplicate: true, record: publicRecord(existingDelivery) };
    }

    const existingObservation = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_observation", (q) =>
        q.eq("workspaceId", workspace._id).eq("observationId", input.observationId),
      )
      .unique();
    if (existingObservation) {
      throw new Error("GITHUB_REPOSITORY_OBSERVATION_CONFLICT");
    }

    const id = await ctx.db.insert("githubRepositoryObservations", {
      workspaceId: workspace._id,
      observationId: input.observationId,
      deliveryId: input.deliveryId,
      payloadDigest: input.payloadDigest,
      semanticFingerprint: input.semanticFingerprint,
      eventType: input.eventType,
      action: input.action,
      repository: input.repository,
      actor: input.actor,
      subjectKind: input.subjectKind,
      subjectExternalId: input.subjectExternalId,
      sourceTime: input.sourceTime,
      sourceTimeSource: input.sourceTimeSource,
      receivedAt: input.receivedAt,
      observationJson: input.observationJson,
      createdAt: Date.now(),
    });
    const inserted = await ctx.db.get("githubRepositoryObservations", id);
    if (!inserted) throw new Error("GITHUB_REPOSITORY_OBSERVATION_MISSING");
    return { duplicate: false, record: publicRecord(inserted) };
  },
});

export const listRecent = query({
  args: {
    ...serviceArgs,
    repository: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    const repository = exactText(args.repository, "GitHub repository", 200, repositoryPattern);
    const limit = boundedInteger(args.limit, "GitHub repository observation limit", 1, maximumRecent);
    const rows = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_repository_received", (q) =>
        q.eq("workspaceId", workspace._id).eq("repository", repository),
      )
      .order("desc")
      .take(limit);
    return rows.map(publicRecord);
  },
});

interface ParsedInput {
  deliveryId: string;
  eventType: typeof eventTypes[number];
  payloadDigest: string;
  receivedAt: number;
  observationId: string;
  semanticFingerprint: string;
  action: string;
  repository: string;
  actor: string | null;
  subjectKind: typeof subjectKinds[number];
  subjectExternalId: string;
  sourceTime: number;
  sourceTimeSource: "provider" | "received";
  observationJson: string;
}

function parseInput(args: {
  deliveryId: string;
  eventType: string;
  payloadDigest: string;
  receivedAt: number;
  observationJson: string;
}): ParsedInput {
  const observationJson = exactText(
    args.observationJson,
    "GitHub repository observation JSON",
    maximumObservationBytes,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(observationJson);
  } catch {
    throw new Error("GitHub repository observation must be valid JSON");
  }
  if (!isRecord(decoded) || !hasExactKeys(decoded, topLevelKeys)) {
    throw new Error("GitHub repository observation has noncanonical fields");
  }
  if (canonicalJsonString(decoded) !== observationJson) {
    throw new Error("GitHub repository observation JSON must be canonical");
  }

  const deliveryId = exactText(args.deliveryId, "GitHub delivery ID", 128, deliveryPattern);
  const eventType = enumValue(args.eventType, "GitHub event type", eventTypes);
  const payloadDigest = exactText(args.payloadDigest, "GitHub payload digest", 71, digestPattern);
  const receivedAt = boundedTimestamp(args.receivedAt, "GitHub receipt time");
  const observationId = exactText(decoded.observationId, "GitHub observation ID", 256);
  const semanticFingerprint = exactText(
    decoded.semanticFingerprint,
    "GitHub semantic fingerprint",
    71,
    digestPattern,
  );
  const repository = exactText(decoded.repository, "GitHub repository", 200, repositoryPattern);
  const action = exactText(decoded.action, "GitHub action", 64, actionPattern);
  const actor = decoded.actor === null
    ? null
    : exactText(decoded.actor, "GitHub actor", 120, actorPattern);
  const sourceTime = canonicalTimestamp(decoded.sourceTime, "GitHub source time");
  const observationReceivedAt = canonicalTimestamp(decoded.receivedAt, "GitHub observation receipt time");
  const sourceTimeSource = enumValue(
    decoded.sourceTimeSource,
    "GitHub source time basis",
    ["provider", "received"] as const,
  );

  if (
    decoded.version !== 1
    || decoded.provider !== "github"
    || decoded.sourceSchema !== "github-webhook"
    || decoded.sourceSchemaVersion !== "2022-11-28"
    || decoded.containsRawContent !== false
    || decoded.deliveryId !== deliveryId
    || decoded.eventType !== eventType
    || decoded.payloadDigest !== payloadDigest
    || observationReceivedAt !== receivedAt
    || observationId !== `github:${eventType}:${deliveryId}`
  ) {
    throw new Error("GitHub repository observation identity is inconsistent");
  }
  if (sourceTime > receivedAt + 5 * 60_000) {
    throw new Error("GitHub repository observation source time is too far in the future");
  }

  const subject = exactRecord(decoded.subject, "GitHub repository observation subject", subjectKeys);
  const subjectKind = enumValue(subject.kind, "GitHub subject kind", subjectKinds);
  const subjectExternalId = safeText(subject.externalId, "GitHub subject identity", 1_024);
  validateRelationships(decoded.relationships, repository);
  validateFacts(decoded.facts);
  validateContentRevisions(decoded.contentRevisions);

  const {
    observationId: _observationId,
    deliveryId: _deliveryId,
    payloadDigest: _payloadDigest,
    semanticFingerprint: _semanticFingerprint,
    receivedAt: _receivedAt,
    ...canonicalSemantics
  } = decoded;
  if (fingerprintCanonicalRequest(canonicalSemantics) !== semanticFingerprint) {
    throw new Error("GitHub repository observation semantic fingerprint is invalid");
  }

  return {
    deliveryId,
    eventType,
    payloadDigest,
    receivedAt,
    observationId,
    semanticFingerprint,
    action,
    repository,
    actor,
    subjectKind,
    subjectExternalId,
    sourceTime,
    sourceTimeSource,
    observationJson,
  };
}

function validateRelationships(value: unknown, repository: string): void {
  const relationships = exactRecord(
    value,
    "GitHub repository observation relationships",
    relationshipKeys,
  );
  if (relationships.repository !== repository) {
    throw new Error("GitHub repository observation relationship repository is inconsistent");
  }
  for (const key of ["revision", "previousRevision", "baseRevision", "mergeRevision"] as const) {
    const revision = relationships[key];
    if (revision !== null && (typeof revision !== "string" || !/^[a-f0-9]{40}$/u.test(revision))) {
      throw new Error(`GitHub repository observation ${key} is invalid`);
    }
  }
  const ref = relationships.ref;
  if (ref !== null) safeText(ref, "GitHub repository observation ref", 512);
  const refType = relationships.refType;
  if (refType !== null && refType !== "branch" && refType !== "tag" && refType !== "other") {
    throw new Error("GitHub repository observation ref type is invalid");
  }
  for (const key of ["pullRequestNumber", "issueNumber"] as const) {
    const number = relationships[key];
    if (number !== null) boundedInteger(number, `GitHub ${key}`, 1, Number.MAX_SAFE_INTEGER);
  }
  const commentId = relationships.commentId;
  if (commentId !== null && (typeof commentId !== "string" || !providerIdPattern.test(commentId))) {
    throw new Error("GitHub repository observation comment identity is invalid");
  }
}

function validateFacts(value: unknown): void {
  if (!isRecord(value)) throw new Error("GitHub repository observation facts must be a record");
  const keys = Object.keys(value);
  if (keys.length > 64 || !isCanonicalOrder(keys)) {
    throw new Error("GitHub repository observation facts are not canonical");
  }
  for (const key of keys) {
    if (!factKeyPattern.test(key)) throw new Error("GitHub repository observation fact key is invalid");
    const fact = value[key];
    if (
      fact !== null
      && typeof fact !== "string"
      && typeof fact !== "boolean"
      && typeof fact !== "number"
    ) {
      throw new Error("GitHub repository observation fact value is invalid");
    }
    if (typeof fact === "string") safeText(fact, `GitHub repository observation fact ${key}`, 1_024);
    if (typeof fact === "number" && !Number.isSafeInteger(fact)) {
      throw new Error("GitHub repository observation numeric fact is invalid");
    }
  }
}

function validateContentRevisions(value: unknown): void {
  if (!Array.isArray(value) || value.length > contentRevisionNames.length) {
    throw new Error("GitHub repository content revisions are invalid");
  }
  const names: string[] = [];
  for (const entry of value) {
    const revision = exactRecord(entry, "GitHub repository content revision", contentRevisionKeys);
    const name = enumValue(revision.name, "GitHub repository content revision name", contentRevisionNames);
    if (names.includes(name)) throw new Error("GitHub repository content revision names must be unique");
    names.push(name);
    if (typeof revision.present !== "boolean") {
      throw new Error("GitHub repository content revision presence is invalid");
    }
    const byteLength = boundedInteger(
      revision.byteLength,
      "GitHub repository content revision byte length",
      0,
      256 * 1_024,
    );
    exactText(revision.sha256, "GitHub repository content revision fingerprint", 71, digestPattern);
    if (!revision.present && byteLength !== 0) {
      throw new Error("Absent GitHub repository content revision must have zero bytes");
    }
  }
  if (!isCanonicalOrder(names)) {
    throw new Error("GitHub repository content revisions must be canonical");
  }
}

function isExactReplay(row: any, input: ParsedInput): boolean {
  return row.observationId === input.observationId
    && row.payloadDigest === input.payloadDigest
    && row.semanticFingerprint === input.semanticFingerprint
    && row.eventType === input.eventType
    && row.action === input.action
    && row.repository === input.repository
    && (row.actor ?? null) === input.actor
    && row.subjectKind === input.subjectKind
    && row.subjectExternalId === input.subjectExternalId
    && row.sourceTime === input.sourceTime
    && row.sourceTimeSource === input.sourceTimeSource
    && row.receivedAt === input.receivedAt
    && row.observationJson === input.observationJson;
}

function publicRecord(row: any) {
  return {
    id: String(row._id),
    observationId: row.observationId,
    deliveryId: row.deliveryId,
    payloadDigest: row.payloadDigest,
    semanticFingerprint: row.semanticFingerprint,
    eventType: row.eventType,
    action: row.action,
    repository: row.repository,
    actor: row.actor ?? null,
    subjectKind: row.subjectKind,
    subjectExternalId: row.subjectExternalId,
    sourceTime: row.sourceTime,
    sourceTimeSource: row.sourceTimeSource,
    receivedAt: row.receivedAt,
    observationJson: row.observationJson,
    createdAt: row.createdAt,
  };
}

function exactRecord<const K extends readonly string[]>(
  value: unknown,
  label: string,
  keys: K,
): Record<K[number], unknown> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error(`${label} has noncanonical fields`);
  }
  return value as Record<K[number], unknown>;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new Error(`${label} is invalid`);
  }
  return value as T[number];
}

function exactText(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || unsafeTextPattern.test(value)
    || (pattern && !pattern.test(value))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || unsafeTextPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function boundedTimestamp(value: unknown, label: string): number {
  return boundedInteger(value, label, 0, Number.MAX_SAFE_INTEGER);
}

function canonicalTimestamp(value: unknown, label: string): number {
  const text = exactText(value, label, 64);
  const milliseconds = Date.parse(text);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${label} must be an exact UTC timestamp`);
  }
  return milliseconds;
}

function isCanonicalOrder(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || codeUnitCompare(values[index - 1]!, value) < 0);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
