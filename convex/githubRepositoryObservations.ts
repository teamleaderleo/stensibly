import { v } from "convex/values";
import {
  canonicalJsonString,
  fingerprintCanonicalRequest,
} from "../src/idempotency-request-fingerprint";
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
type EventType = typeof eventTypes[number];

const subjectKinds = [
  "revision",
  "ref",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue",
  "issue_comment",
] as const;
type SubjectKind = typeof subjectKinds[number];

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
const reviewStates = [
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
] as const;

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
    if (!workspace) {
      throw new Error("GITHUB_REPOSITORY_OBSERVATION_WORKSPACE_NOT_FOUND");
    }
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
    if (!inserted) {
      throw new Error("GITHUB_REPOSITORY_OBSERVATION_MISSING");
    }
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
    const repository = exactText(
      args.repository,
      "GitHub repository",
      200,
      repositoryPattern,
    );
    const limit = boundedInteger(
      args.limit,
      "GitHub repository observation limit",
      1,
      maximumRecent,
    );
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
  eventType: EventType;
  payloadDigest: string;
  receivedAt: number;
  observationId: string;
  semanticFingerprint: string;
  action: string;
  repository: string;
  actor: string | null;
  subjectKind: SubjectKind;
  subjectExternalId: string;
  sourceTime: number;
  sourceTimeSource: "provider" | "received";
  observationJson: string;
}

interface ValidatedRelationships {
  repository: string;
  revision: string | null;
  previousRevision: string | null;
  baseRevision: string | null;
  mergeRevision: string | null;
  ref: string | null;
  refType: "branch" | "tag" | "other" | null;
  pullRequestNumber: number | null;
  issueNumber: number | null;
  commentId: string | null;
}

type FactValue = string | number | boolean | null;
type ValidatedFacts = Record<string, FactValue>;

function parseInput(args: {
  deliveryId: string;
  eventType: string;
  payloadDigest: string;
  receivedAt: number;
  observationJson: string;
}): ParsedInput {
  const observationJson = exactUtf8Text(
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

  const deliveryId = exactText(
    args.deliveryId,
    "GitHub delivery ID",
    128,
    deliveryPattern,
  );
  const eventType = enumValue(args.eventType, "GitHub event type", eventTypes);
  const payloadDigest = exactText(
    args.payloadDigest,
    "GitHub payload digest",
    71,
    digestPattern,
  );
  const receivedAt = boundedTimestamp(args.receivedAt, "GitHub receipt time");
  const observationId = exactText(
    decoded.observationId,
    "GitHub observation ID",
    256,
  );
  const semanticFingerprint = exactText(
    decoded.semanticFingerprint,
    "GitHub semantic fingerprint",
    71,
    digestPattern,
  );
  const repository = exactText(
    decoded.repository,
    "GitHub repository",
    200,
    repositoryPattern,
  );
  const action = exactText(decoded.action, "GitHub action", 64, actionPattern);
  validateAction(eventType, action);
  const actor = decoded.actor === null
    ? null
    : exactText(decoded.actor, "GitHub actor", 120, actorPattern);
  const sourceTime = canonicalTimestamp(decoded.sourceTime, "GitHub source time");
  const observationReceivedAt = canonicalTimestamp(
    decoded.receivedAt,
    "GitHub observation receipt time",
  );
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
    throw new Error(
      "GitHub repository observation source time is too far in the future",
    );
  }

  const subject = exactRecord(
    decoded.subject,
    "GitHub repository observation subject",
    subjectKeys,
  );
  const subjectKind = enumValue(
    subject.kind,
    "GitHub subject kind",
    subjectKinds,
  );
  const subjectExternalId = safeText(
    subject.externalId,
    "GitHub subject identity",
    1_024,
  );
  const relationships = validateRelationships(decoded.relationships, repository);
  const facts = validateFacts(decoded.facts, eventType);
  validateSubjectAndRelationships(
    eventType,
    repository,
    subjectKind,
    subjectExternalId,
    relationships,
    facts,
  );
  const contentRevisionNamesSeen = validateContentRevisions(
    decoded.contentRevisions,
  );
  validateContentRevisionNames(eventType, contentRevisionNamesSeen);

  const {
    observationId: _observationId,
    deliveryId: _deliveryId,
    payloadDigest: _payloadDigest,
    semanticFingerprint: _semanticFingerprint,
    receivedAt: _receivedAt,
    ...canonicalSemantics
  } = decoded;
  if (fingerprintCanonicalRequest(canonicalSemantics) !== semanticFingerprint) {
    throw new Error(
      "GitHub repository observation semantic fingerprint is invalid",
    );
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

function validateAction(eventType: EventType, action: string): void {
  if (
    (eventType === "push" && action !== "pushed")
    || (eventType === "create" && action !== "created")
    || (eventType === "delete" && action !== "deleted")
    || (
      eventType === "pull_request_review"
      && action !== "submitted"
      && action !== "edited"
      && action !== "dismissed"
    )
    || (
      eventType === "pull_request_review_comment"
      && action !== "created"
      && action !== "edited"
      && action !== "deleted"
    )
  ) {
    throw new Error("GitHub repository observation action is inconsistent");
  }
}

function validateRelationships(
  value: unknown,
  repository: string,
): ValidatedRelationships {
  const relationships = exactRecord(
    value,
    "GitHub repository observation relationships",
    relationshipKeys,
  );
  if (relationships.repository !== repository) {
    throw new Error(
      "GitHub repository observation relationship repository is inconsistent",
    );
  }
  return {
    repository,
    revision: optionalRevision(relationships.revision, "revision"),
    previousRevision: optionalRevision(
      relationships.previousRevision,
      "previousRevision",
    ),
    baseRevision: optionalRevision(
      relationships.baseRevision,
      "baseRevision",
    ),
    mergeRevision: optionalRevision(
      relationships.mergeRevision,
      "mergeRevision",
    ),
    ref: relationships.ref === null
      ? null
      : safeText(
        relationships.ref,
        "GitHub repository observation ref",
        512,
      ),
    refType: optionalEnumValue(
      relationships.refType,
      "GitHub repository observation ref type",
      ["branch", "tag", "other"] as const,
    ),
    pullRequestNumber: optionalPositiveInteger(
      relationships.pullRequestNumber,
      "GitHub pull request number",
    ),
    issueNumber: optionalPositiveInteger(
      relationships.issueNumber,
      "GitHub issue number",
    ),
    commentId: optionalProviderId(
      relationships.commentId,
      "GitHub comment identity",
    ),
  };
}

function validateFacts(value: unknown, eventType: EventType): ValidatedFacts {
  switch (eventType) {
    case "push": {
      const facts = exactRecord(
        value,
        "GitHub push facts",
        ["commitCount", "created", "deleted", "forced"] as const,
      );
      return {
        commitCount: boundedInteger(
          facts.commitCount,
          "GitHub push commit count",
          0,
          Number.MAX_SAFE_INTEGER,
        ),
        created: exactBoolean(facts.created, "GitHub push created flag"),
        deleted: exactBoolean(facts.deleted, "GitHub push deleted flag"),
        forced: exactBoolean(facts.forced, "GitHub push forced flag"),
      };
    }
    case "create":
    case "delete":
      exactRecord(value, "GitHub ref lifecycle facts", [] as const);
      return {};
    case "pull_request": {
      const facts = exactRecord(
        value,
        "GitHub pull request facts",
        ["draft", "locked", "merged", "state"] as const,
      );
      return {
        draft: exactBoolean(facts.draft, "GitHub pull request draft flag"),
        locked: exactBoolean(facts.locked, "GitHub pull request locked flag"),
        merged: exactBoolean(facts.merged, "GitHub pull request merged flag"),
        state: enumValue(
          facts.state,
          "GitHub pull request state",
          ["open", "closed"] as const,
        ),
      };
    }
    case "pull_request_review": {
      const facts = exactRecord(
        value,
        "GitHub pull request review facts",
        ["reviewId", "state"] as const,
      );
      return {
        reviewId: providerId(facts.reviewId, "GitHub review identity"),
        state: enumValue(
          facts.state,
          "GitHub review state",
          reviewStates,
        ),
      };
    }
    case "pull_request_review_comment": {
      const facts = exactRecord(
        value,
        "GitHub pull request review comment facts",
        ["inReplyToId", "reviewId"] as const,
      );
      return {
        inReplyToId: optionalProviderId(
          facts.inReplyToId,
          "GitHub parent review comment identity",
        ),
        reviewId: optionalProviderId(
          facts.reviewId,
          "GitHub review identity",
        ),
      };
    }
    case "issues": {
      const facts = exactRecord(
        value,
        "GitHub issue facts",
        ["locked", "state", "stateReason"] as const,
      );
      return {
        locked: exactBoolean(facts.locked, "GitHub issue locked flag"),
        state: enumValue(
          facts.state,
          "GitHub issue state",
          ["open", "closed"] as const,
        ),
        stateReason: facts.stateReason === null
          ? null
          : safeText(facts.stateReason, "GitHub issue state reason", 64),
      };
    }
    case "issue_comment": {
      const facts = exactRecord(
        value,
        "GitHub issue comment facts",
        ["onPullRequest"] as const,
      );
      return {
        onPullRequest: exactBoolean(
          facts.onPullRequest,
          "GitHub issue comment pull request flag",
        ),
      };
    }
  }
}

function validateSubjectAndRelationships(
  eventType: EventType,
  repository: string,
  subjectKind: SubjectKind,
  subjectExternalId: string,
  relationships: ValidatedRelationships,
  facts: ValidatedFacts,
): void {
  let expectedKind: SubjectKind;
  let expectedIdentity: string;

  switch (eventType) {
    case "push": {
      requireNull(relationships.baseRevision, "push base revision");
      requireNull(relationships.mergeRevision, "push merge revision");
      requireNull(relationships.pullRequestNumber, "push pull request");
      requireNull(relationships.issueNumber, "push issue");
      requireNull(relationships.commentId, "push comment");
      const ref = requiredValue(relationships.ref, "GitHub push ref");
      requiredValue(relationships.refType, "GitHub push ref type");
      if (relationships.revision) {
        expectedKind = "revision";
        expectedIdentity = `github:${repository}@${relationships.revision}`;
      } else {
        expectedKind = "ref";
        expectedIdentity = `github:${repository}@${ref}`;
      }
      break;
    }
    case "create":
    case "delete": {
      requireNull(relationships.revision, "ref lifecycle revision");
      requireNull(relationships.previousRevision, "ref lifecycle previous revision");
      requireNull(relationships.baseRevision, "ref lifecycle base revision");
      requireNull(relationships.mergeRevision, "ref lifecycle merge revision");
      requireNull(relationships.pullRequestNumber, "ref lifecycle pull request");
      requireNull(relationships.issueNumber, "ref lifecycle issue");
      requireNull(relationships.commentId, "ref lifecycle comment");
      const ref = requiredValue(
        relationships.ref,
        "GitHub ref lifecycle ref",
      );
      requiredValue(
        relationships.refType,
        "GitHub ref lifecycle ref type",
      );
      expectedKind = "ref";
      expectedIdentity = `github:${repository}@${ref}`;
      break;
    }
    case "pull_request": {
      requireNull(relationships.previousRevision, "pull request previous revision");
      requireNull(relationships.ref, "pull request ref");
      requireNull(relationships.refType, "pull request ref type");
      requireNull(relationships.commentId, "pull request comment");
      requiredValue(relationships.revision, "GitHub pull request revision");
      requiredValue(relationships.baseRevision, "GitHub pull request base revision");
      const number = matchingIssueAndPullRequest(relationships);
      expectedKind = "pull_request";
      expectedIdentity = `github:${repository}#pull/${number}`;
      break;
    }
    case "pull_request_review": {
      requireNull(relationships.previousRevision, "review previous revision");
      requireNull(relationships.baseRevision, "review base revision");
      requireNull(relationships.mergeRevision, "review merge revision");
      requireNull(relationships.ref, "review ref");
      requireNull(relationships.refType, "review ref type");
      requireNull(relationships.commentId, "review comment");
      requiredValue(relationships.revision, "GitHub review revision");
      const number = matchingIssueAndPullRequest(relationships);
      const reviewId = providerId(facts.reviewId, "GitHub review identity");
      expectedKind = "pull_request_review";
      expectedIdentity =
        `github:${repository}#pull/${number}/review/${reviewId}`;
      break;
    }
    case "pull_request_review_comment": {
      requireNull(
        relationships.previousRevision,
        "review comment previous revision",
      );
      requireNull(relationships.baseRevision, "review comment base revision");
      requireNull(relationships.mergeRevision, "review comment merge revision");
      requireNull(relationships.ref, "review comment ref");
      requireNull(relationships.refType, "review comment ref type");
      requiredValue(
        relationships.revision,
        "GitHub review comment revision",
      );
      const number = matchingIssueAndPullRequest(relationships);
      const commentId = requiredValue(
        relationships.commentId,
        "GitHub review comment identity",
      );
      expectedKind = "pull_request_review_comment";
      expectedIdentity =
        `github:${repository}#pull/${number}/review-comment/${commentId}`;
      break;
    }
    case "issues": {
      requireNull(relationships.revision, "issue revision");
      requireNull(relationships.previousRevision, "issue previous revision");
      requireNull(relationships.baseRevision, "issue base revision");
      requireNull(relationships.mergeRevision, "issue merge revision");
      requireNull(relationships.ref, "issue ref");
      requireNull(relationships.refType, "issue ref type");
      requireNull(relationships.pullRequestNumber, "issue pull request");
      requireNull(relationships.commentId, "issue comment");
      const number = requiredValue(
        relationships.issueNumber,
        "GitHub issue number",
      );
      expectedKind = "issue";
      expectedIdentity = `github:${repository}#issue/${number}`;
      break;
    }
    case "issue_comment": {
      requireNull(relationships.revision, "issue comment revision");
      requireNull(
        relationships.previousRevision,
        "issue comment previous revision",
      );
      requireNull(relationships.baseRevision, "issue comment base revision");
      requireNull(relationships.mergeRevision, "issue comment merge revision");
      requireNull(relationships.ref, "issue comment ref");
      requireNull(relationships.refType, "issue comment ref type");
      const issueNumber = requiredValue(
        relationships.issueNumber,
        "GitHub issue comment issue number",
      );
      const commentId = requiredValue(
        relationships.commentId,
        "GitHub issue comment identity",
      );
      const onPullRequest = facts.onPullRequest;
      if (typeof onPullRequest !== "boolean") {
        throw new Error("GitHub issue comment facts are inconsistent");
      }
      if (onPullRequest) {
        if (relationships.pullRequestNumber !== issueNumber) {
          throw new Error(
            "GitHub issue comment pull request identity is inconsistent",
          );
        }
      } else {
        requireNull(
          relationships.pullRequestNumber,
          "issue comment pull request",
        );
      }
      expectedKind = "issue_comment";
      expectedIdentity =
        `github:${repository}#issue/${issueNumber}/comment/${commentId}`;
      break;
    }
  }

  if (subjectKind !== expectedKind || subjectExternalId !== expectedIdentity) {
    throw new Error("GitHub repository observation subject is inconsistent");
  }
}

function validateContentRevisions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > contentRevisionNames.length) {
    throw new Error("GitHub repository content revisions are invalid");
  }
  const names: string[] = [];
  for (const entry of value) {
    const revision = exactRecord(
      entry,
      "GitHub repository content revision",
      contentRevisionKeys,
    );
    const name = enumValue(
      revision.name,
      "GitHub repository content revision name",
      contentRevisionNames,
    );
    if (names.includes(name)) {
      throw new Error(
        "GitHub repository content revision names must be unique",
      );
    }
    names.push(name);
    if (typeof revision.present !== "boolean") {
      throw new Error(
        "GitHub repository content revision presence is invalid",
      );
    }
    const byteLength = boundedInteger(
      revision.byteLength,
      "GitHub repository content revision byte length",
      0,
      256 * 1_024,
    );
    exactText(
      revision.sha256,
      "GitHub repository content revision fingerprint",
      71,
      digestPattern,
    );
    if (!revision.present && byteLength !== 0) {
      throw new Error(
        "Absent GitHub repository content revision must have zero bytes",
      );
    }
  }
  if (!isCanonicalOrder(names)) {
    throw new Error("GitHub repository content revisions must be canonical");
  }
  return names;
}

function validateContentRevisionNames(
  eventType: EventType,
  names: readonly string[],
): void {
  const expected = eventType === "pull_request" || eventType === "issues"
    ? ["body", "title"]
    : eventType === "pull_request_review"
    ? ["review_body"]
    : eventType === "pull_request_review_comment"
      || eventType === "issue_comment"
    ? ["comment_body"]
    : [];
  if (
    names.length !== expected.length
    || names.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      "GitHub repository observation content revisions are inconsistent",
    );
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
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
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

function optionalEnumValue<const T extends readonly string[]>(
  value: unknown,
  label: string,
  values: T,
): T[number] | null {
  return value === null ? null : enumValue(value, label, values);
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid`);
  return value;
}

function exactText(
  value: unknown,
  label: string,
  maximum: number,
  pattern?: RegExp,
): string {
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

function exactUtf8Text(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || unsafeTextPattern.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function providerId(value: unknown, label: string): string {
  if (typeof value !== "string" || !providerIdPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalProviderId(value: unknown, label: string): string | null {
  return value === null ? null : providerId(value, label);
}

function optionalRevision(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error(`GitHub repository observation ${label} is invalid`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  return value === null
    ? null
    : boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
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
    || value < minimum
    || value > maximum
  ) {
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
  if (
    !Number.isSafeInteger(milliseconds)
    || new Date(milliseconds).toISOString() !== text
  ) {
    throw new Error(`${label} must be an exact UTC timestamp`);
  }
  return milliseconds;
}

function matchingIssueAndPullRequest(
  relationships: ValidatedRelationships,
): number {
  const pullRequestNumber = requiredValue(
    relationships.pullRequestNumber,
    "GitHub pull request number",
  );
  if (relationships.issueNumber !== pullRequestNumber) {
    throw new Error("GitHub issue and pull request identities are inconsistent");
  }
  return pullRequestNumber;
}

function requireNull(value: unknown, label: string): void {
  if (value !== null) {
    throw new Error(`GitHub repository observation ${label} must be null`);
  }
}

function requiredValue<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} is required`);
  return value;
}

function isCanonicalOrder(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || codeUnitCompare(values[index - 1]!, value) < 0,
  );
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
