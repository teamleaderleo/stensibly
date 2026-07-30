import { createHash } from "node:crypto";
import {
  canonicalBody,
  canonicalTimestamp,
  normalizeGitHubRepository,
  positiveInteger,
  sha256,
  stableJson,
} from "./github-provider-validation.js";

export const githubRepositoryEventTypes = [
  "push",
  "create",
  "delete",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
] as const;

export type GitHubRepositoryEventType =
  typeof githubRepositoryEventTypes[number];

export type GitHubRepositorySubjectKind =
  | "repository"
  | "revision"
  | "ref"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "issue"
  | "issue_comment";

export type GitHubRepositoryRefType = "branch" | "tag" | "other";

export type GitHubRepositoryFactValue = string | number | boolean | null;

export interface GitHubRepositoryContentRevision {
  readonly name: "title" | "body" | "comment_body" | "review_body";
  readonly present: boolean;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface GitHubRepositoryObservationRelationships {
  readonly repository: string;
  readonly revision: string | null;
  readonly previousRevision: string | null;
  readonly baseRevision: string | null;
  readonly mergeRevision: string | null;
  readonly ref: string | null;
  readonly refType: GitHubRepositoryRefType | null;
  readonly pullRequestNumber: number | null;
  readonly issueNumber: number | null;
  readonly commentId: string | null;
}

export interface GitHubRepositoryObservation {
  readonly version: 1;
  readonly provider: "github";
  readonly sourceSchema: "github-webhook";
  readonly sourceSchemaVersion: "2022-11-28";
  readonly observationId: string;
  readonly deliveryId: string;
  readonly payloadDigest: string;
  readonly semanticFingerprint: string;
  readonly eventType: GitHubRepositoryEventType;
  readonly action: string;
  readonly repository: string;
  readonly actor: string | null;
  readonly subject: {
    readonly kind: GitHubRepositorySubjectKind;
    readonly externalId: string;
  };
  readonly relationships: GitHubRepositoryObservationRelationships;
  readonly facts: Readonly<Record<string, GitHubRepositoryFactValue>>;
  readonly contentRevisions: readonly GitHubRepositoryContentRevision[];
  readonly sourceTime: string;
  readonly sourceTimeSource: "provider" | "received";
  readonly receivedAt: string;
  readonly containsRawContent: false;
}

export interface MapGitHubRepositoryWebhookInput {
  eventType: string;
  deliveryId: string;
  payloadDigest: string;
  payload: unknown;
  signatureVerified: boolean;
  receivedAt: string;
  expectedRepository?: string;
}

interface CommonMapping {
  eventType: GitHubRepositoryEventType;
  deliveryId: string;
  payloadDigest: string;
  repository: string;
  actor: string | null;
  receivedAt: string;
}

interface MappedSemantics {
  action: string;
  subject: GitHubRepositoryObservation["subject"];
  relationships: GitHubRepositoryObservationRelationships;
  facts: Record<string, GitHubRepositoryFactValue>;
  contentRevisions: GitHubRepositoryContentRevision[];
  sourceTime: string;
  sourceTimeSource: GitHubRepositoryObservation["sourceTimeSource"];
}

const deliveryPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const actionPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const actorPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[bot\])?$/u;
const fullRevisionPattern = /^[a-f0-9]{40}$/u;
const zeroRevision = "0000000000000000000000000000000000000000";
const unsafeIdentityTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const maximumContentBytes = 256 * 1_024;

export function digestGitHubWebhookPayload(body: Uint8Array): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

/**
 * Maps one signature-verified GitHub webhook into an immutable, content-minimised
 * repository observation. Unsupported event families return null.
 */
export function mapGitHubRepositoryWebhook(
  input: MapGitHubRepositoryWebhookInput,
): GitHubRepositoryObservation | null {
  if (input.signatureVerified !== true) {
    throw new RangeError(
      "GitHub repository observations require a verified webhook signature",
    );
  }
  if (!(githubRepositoryEventTypes as readonly string[]).includes(input.eventType)) {
    return null;
  }
  const eventType = input.eventType as GitHubRepositoryEventType;
  const deliveryId = boundedPattern(
    input.deliveryId,
    "GitHub delivery ID",
    deliveryPattern,
  );
  const payloadDigest = boundedPattern(
    input.payloadDigest,
    "GitHub webhook payload digest",
    digestPattern,
  );
  const receivedAt = canonicalTimestamp(
    input.receivedAt,
    "GitHub webhook received time",
  );
  const payload = record(input.payload, "GitHub webhook payload");
  const repository = repositoryFullName(payload);
  if (
    input.expectedRepository !== undefined
    && repository !== normalizeGitHubRepository(input.expectedRepository)
  ) {
    throw new RangeError(
      `GitHub webhook repository ${repository} does not match ${normalizeGitHubRepository(input.expectedRepository)}`,
    );
  }
  const common: CommonMapping = {
    eventType,
    deliveryId,
    payloadDigest,
    repository,
    actor: actorLogin(payload.sender),
    receivedAt,
  };

  const semantics = eventType === "push"
    ? mapPush(payload, common)
    : eventType === "create"
    ? mapRefLifecycle(payload, common, "created")
    : eventType === "delete"
    ? mapRefLifecycle(payload, common, "deleted")
    : eventType === "pull_request"
    ? mapPullRequest(payload, common)
    : eventType === "pull_request_review"
    ? mapPullRequestReview(payload, common)
    : eventType === "pull_request_review_comment"
    ? mapPullRequestReviewComment(payload, common)
    : eventType === "issues"
    ? mapIssue(payload, common)
    : mapIssueComment(payload, common);

  return finalizeObservation(common, semantics);
}

function mapPush(
  payload: Record<string, unknown>,
  common: CommonMapping,
): MappedSemantics {
  const ref = canonicalRef(requiredString(payload.ref, "GitHub push ref"));
  const revision = canonicalRevision(
    requiredString(payload.after, "GitHub push after revision"),
    "GitHub push after revision",
    true,
  );
  const previousRevision = canonicalRevision(
    requiredString(payload.before, "GitHub push before revision"),
    "GitHub push before revision",
    true,
  );
  const headCommit = optionalRecord(payload.head_commit);
  const time = sourceTime(
    headCommit?.timestamp,
    "GitHub push head commit time",
    common.receivedAt,
  );
  const commitCount = payload.size === undefined
    ? Array.isArray(payload.commits)
      ? payload.commits.length
      : 0
    : nonNegativeInteger(payload.size, "GitHub push commit count");
  const subject = revision
    ? revisionSubject(common.repository, revision)
    : refSubject(common.repository, ref.full);
  return {
    action: "pushed",
    subject,
    relationships: relationships(common.repository, {
      revision,
      previousRevision,
      ref: ref.full,
      refType: ref.type,
    }),
    facts: {
      commitCount,
      created: booleanValue(payload.created, "GitHub push created flag", false),
      deleted: booleanValue(payload.deleted, "GitHub push deleted flag", false),
      forced: booleanValue(payload.forced, "GitHub push forced flag", false),
    },
    contentRevisions: [],
    ...time,
  };
}

function mapRefLifecycle(
  payload: Record<string, unknown>,
  common: CommonMapping,
  action: "created" | "deleted",
): MappedSemantics {
  const type = exactRefType(payload.ref_type);
  const name = identityText(
    requiredString(payload.ref, `GitHub ${common.eventType} ref`),
    `GitHub ${common.eventType} ref`,
    512,
  );
  const full = type === "branch" ? `refs/heads/${name}` : `refs/tags/${name}`;
  return {
    action,
    subject: refSubject(common.repository, full),
    relationships: relationships(common.repository, {
      ref: full,
      refType: type,
    }),
    facts: {},
    contentRevisions: [],
    sourceTime: common.receivedAt,
    sourceTimeSource: "received",
  };
}

function mapPullRequest(
  payload: Record<string, unknown>,
  common: CommonMapping,
): MappedSemantics {
  const action = canonicalAction(payload.action, "GitHub pull request action");
  const pullRequest = requiredRecord(
    payload.pull_request,
    "GitHub pull request payload",
  );
  const number = positiveInteger(
    payload.number ?? pullRequest.number,
    "GitHub pull request number",
  );
  const head = requiredRecord(pullRequest.head, "GitHub pull request head");
  const base = requiredRecord(pullRequest.base, "GitHub pull request base");
  const revision = canonicalRevision(
    requiredString(head.sha, "GitHub pull request head revision"),
    "GitHub pull request head revision",
  );
  const baseRevision = canonicalRevision(
    requiredString(base.sha, "GitHub pull request base revision"),
    "GitHub pull request base revision",
  );
  const mergeRevision = pullRequest.merge_commit_sha === null
    || pullRequest.merge_commit_sha === undefined
    ? null
    : canonicalRevision(
      requiredString(
        pullRequest.merge_commit_sha,
        "GitHub pull request merge revision",
      ),
      "GitHub pull request merge revision",
      true,
    );
  const state = exactState(pullRequest.state, "GitHub pull request state");
  const time = sourceTime(
    pullRequest.updated_at,
    "GitHub pull request updated time",
    common.receivedAt,
    true,
  );
  return {
    action,
    subject: {
      kind: "pull_request",
      externalId: `github:${common.repository}#pull/${number}`,
    },
    relationships: relationships(common.repository, {
      revision,
      baseRevision,
      mergeRevision,
      pullRequestNumber: number,
      issueNumber: number,
    }),
    facts: {
      draft: booleanValue(
        pullRequest.draft,
        "GitHub pull request draft flag",
        false,
      ),
      locked: booleanValue(
        pullRequest.locked,
        "GitHub pull request locked flag",
        false,
      ),
      merged: booleanValue(
        pullRequest.merged,
        "GitHub pull request merged flag",
        false,
      ),
      state,
    },
    contentRevisions: canonicalContentRevisions([
      contentRevision("title", pullRequest.title),
      contentRevision("body", pullRequest.body),
    ]),
    ...time,
  };
}

function mapPullRequestReview(
  payload: Record<string, unknown>,
  common: CommonMapping,
): MappedSemantics {
  const action = exactPullRequestReviewAction(payload.action);
  const pullRequest = requiredRecord(
    payload.pull_request,
    "GitHub pull request review pull request",
  );
  const review = requiredRecord(
    payload.review,
    "GitHub pull request review payload",
  );
  const number = positiveInteger(
    pullRequest.number,
    "GitHub pull request review pull request number",
  );
  const reviewId = providerId(review.id, "GitHub pull request review ID");
  const revision = canonicalRevision(
    requiredString(review.commit_id, "GitHub pull request review revision"),
    "GitHub pull request review revision",
  );
  const state = exactReviewState(review.state);
  const time = sourceTime(
    review.submitted_at ?? pullRequest.updated_at,
    "GitHub pull request review updated time",
    common.receivedAt,
  );
  return {
    action,
    subject: {
      kind: "pull_request_review",
      externalId:
        `github:${common.repository}#pull/${number}/review/${reviewId}`,
    },
    relationships: relationships(common.repository, {
      revision,
      pullRequestNumber: number,
      issueNumber: number,
    }),
    facts: { state, reviewId },
    contentRevisions: canonicalContentRevisions([
      contentRevision("review_body", review.body),
    ]),
    ...time,
  };
}

function mapPullRequestReviewComment(
  payload: Record<string, unknown>,
  common: CommonMapping,
): MappedSemantics {
  const action = exactPullRequestReviewCommentAction(payload.action);
  const pullRequest = requiredRecord(
    payload.pull_request,
    "GitHub pull request review comment pull request",
  );
  const comment = requiredRecord(
    payload.comment,
    "GitHub pull request review comment payload",
  );
  const number = positiveInteger(
    pullRequest.number,
    "GitHub pull request review comment pull request number",
  );
  const commentId = providerId(
    comment.id,
    "GitHub pull request review comment ID",
  );
  const revision = canonicalRevision(
    requiredString(
      comment.commit_id ?? comment.original_commit_id,
      "GitHub pull request review comment revision",
    ),
    "GitHub pull request review comment revision",
  );
  const reviewId = optionalProviderId(
    comment.pull_request_review_id,
    "GitHub pull request review comment review ID",
  );
  const inReplyToId = optionalProviderId(
    comment.in_reply_to_id,
    "GitHub pull request review comment parent ID",
  );
  const time = sourceTime(
    comment.updated_at ?? comment.created_at,
    "GitHub pull request review comment updated time",
    common.receivedAt,
  );
  return {
    action,
    subject: {
      kind: "pull_request_review_comment",
      externalId:
        `github:${common.repository}#pull/${number}/review-comment/${commentId}`,
    },
    relationships: relationships(common.repository, {
      revision,
      pullRequestNumber: number,
      issueNumber: number,
      commentId,
    }),
    facts: { reviewId, inReplyToId },
    contentRevisions: canonicalContentRevisions([
      contentRevision("comment_body", comment.body),
    ]),
    ...time,
  };
}

function mapIssue(
  payload: Record<string, unknown>,
  common: CommonMapping,
): MappedSemantics {
  const action = canonicalAction(payload.action, "GitHub issue action");
  const issue = requiredRecord(payload.issue, "GitHub issue payload");
  const number = positiveInteger(issue.number, "GitHub issue number");
  const state = exactState(issue.state, "GitHub issue state");
  const time = sourceTime(
    issue.updated_at,
    "GitHub issue updated time",
    common.receivedAt,
    true,
  );
  const stateReason = issue.state_reason === null || issue.state_reason === undefined
    ? null
    : identityText(
      requiredString(issue.state_reason, "GitHub issue state reason"),
      "GitHub issue state reason",
      64,
    );
  return {
    action,
    subject: {
      kind: "issue",
      externalId: `github:${common.repository}#issue/${number}`,
    },
    relationships: relationships(common.repository, { issueNumber: number }),
    facts: {
      locked: booleanValue(issue.locked, "GitHub issue locked flag", false),
      state,
      stateReason,
    },
    contentRevisions: canonicalContentRevisions([
      contentRevision("title", issue.title),
      contentRevision("body", issue.body),
    ]),
    ...time,
  };
}

function mapIssueComment(
  payload: Record<string, unknown>,
  common: CommonMapping,
): MappedSemantics {
  const action = canonicalAction(payload.action, "GitHub issue comment action");
  const issue = requiredRecord(payload.issue, "GitHub issue comment issue");
  const comment = requiredRecord(payload.comment, "GitHub issue comment payload");
  const issueNumber = positiveInteger(issue.number, "GitHub issue comment issue number");
  const commentId = providerId(comment.id, "GitHub issue comment ID");
  const time = sourceTime(
    comment.updated_at ?? comment.created_at,
    "GitHub issue comment updated time",
    common.receivedAt,
    true,
  );
  const onPullRequest = optionalRecord(issue.pull_request) !== null;
  return {
    action,
    subject: {
      kind: "issue_comment",
      externalId:
        `github:${common.repository}#issue/${issueNumber}/comment/${commentId}`,
    },
    relationships: relationships(common.repository, {
      issueNumber,
      pullRequestNumber: onPullRequest ? issueNumber : null,
      commentId,
    }),
    facts: { onPullRequest },
    contentRevisions: canonicalContentRevisions([
      contentRevision("comment_body", comment.body),
    ]),
    ...time,
  };
}

function finalizeObservation(
  common: CommonMapping,
  semantics: MappedSemantics,
): GitHubRepositoryObservation {
  const canonicalSemantics = {
    version: 1 as const,
    provider: "github" as const,
    sourceSchema: "github-webhook" as const,
    sourceSchemaVersion: "2022-11-28" as const,
    eventType: common.eventType,
    action: semantics.action,
    repository: common.repository,
    actor: common.actor,
    subject: semantics.subject,
    relationships: semantics.relationships,
    facts: semantics.facts,
    contentRevisions: semantics.contentRevisions,
    sourceTime: semantics.sourceTime,
    sourceTimeSource: semantics.sourceTimeSource,
    containsRawContent: false as const,
  };
  return deepFreeze({
    ...canonicalSemantics,
    observationId: `github:${common.eventType}:${common.deliveryId}`,
    deliveryId: common.deliveryId,
    payloadDigest: common.payloadDigest,
    semanticFingerprint: sha256(stableJson(canonicalSemantics)),
    receivedAt: common.receivedAt,
  });
}

function relationships(
  repository: string,
  overrides: Partial<Omit<GitHubRepositoryObservationRelationships, "repository">>,
): GitHubRepositoryObservationRelationships {
  return {
    repository,
    revision: null,
    previousRevision: null,
    baseRevision: null,
    mergeRevision: null,
    ref: null,
    refType: null,
    pullRequestNumber: null,
    issueNumber: null,
    commentId: null,
    ...overrides,
  };
}

function repositoryFullName(payload: Record<string, unknown>): string {
  const repository = requiredRecord(
    payload.repository,
    "GitHub webhook repository",
  );
  return normalizeGitHubRepository(
    requiredString(
      repository.full_name,
      "GitHub webhook repository full name",
    ),
  );
}

function actorLogin(value: unknown): string | null {
  const actor = optionalRecord(value);
  if (!actor || actor.login === null || actor.login === undefined) return null;
  return boundedPattern(
    requiredString(actor.login, "GitHub webhook actor login"),
    "GitHub webhook actor login",
    actorPattern,
  ).toLowerCase();
}

function canonicalAction(value: unknown, label: string): string {
  return boundedPattern(requiredString(value, label), label, actionPattern);
}

function exactState(value: unknown, label: string): "open" | "closed" {
  if (value === "open" || value === "closed") return value;
  throw new RangeError(`${label} must be open or closed`);
}

function exactPullRequestReviewAction(
  value: unknown,
): "submitted" | "edited" | "dismissed" {
  if (value === "submitted" || value === "edited" || value === "dismissed") {
    return value;
  }
  throw new RangeError("GitHub pull request review action is invalid");
}

function exactPullRequestReviewCommentAction(
  value: unknown,
): "created" | "edited" | "deleted" {
  if (value === "created" || value === "edited" || value === "deleted") {
    return value;
  }
  throw new RangeError("GitHub pull request review comment action is invalid");
}

function exactReviewState(
  value: unknown,
): "approved" | "changes_requested" | "commented" | "dismissed" | "pending" {
  if (
    value === "approved"
    || value === "changes_requested"
    || value === "commented"
    || value === "dismissed"
    || value === "pending"
  ) {
    return value;
  }
  throw new RangeError("GitHub pull request review state is invalid");
}

function exactRefType(value: unknown): "branch" | "tag" {
  if (value === "branch" || value === "tag") return value;
  throw new RangeError("GitHub ref type must be branch or tag");
}

function canonicalRef(value: string): {
  full: string;
  type: GitHubRepositoryRefType;
} {
  const full = identityText(value, "GitHub ref", 512);
  if (full.startsWith("refs/heads/") && full.length > "refs/heads/".length) {
    return { full, type: "branch" };
  }
  if (full.startsWith("refs/tags/") && full.length > "refs/tags/".length) {
    return { full, type: "tag" };
  }
  return { full, type: "other" };
}

function canonicalRevision(
  value: string,
  label: string,
  allowZero = false,
): string | null {
  const revision = value.toLowerCase();
  if (allowZero && revision === zeroRevision) return null;
  if (!fullRevisionPattern.test(revision)) {
    throw new RangeError(`${label} must be a full Git revision`);
  }
  return revision;
}

function sourceTime(
  value: unknown,
  label: string,
  receivedAt: string,
  required = false,
): Pick<MappedSemantics, "sourceTime" | "sourceTimeSource"> {
  if (value === null || value === undefined) {
    if (required) throw new RangeError(`${label} is required`);
    return { sourceTime: receivedAt, sourceTimeSource: "received" };
  }
  return {
    sourceTime: canonicalTimestamp(requiredString(value, label), label),
    sourceTimeSource: "provider",
  };
}

function revisionSubject(
  repository: string,
  revision: string,
): GitHubRepositoryObservation["subject"] {
  return {
    kind: "revision",
    externalId: `github:${repository}@${revision}`,
  };
}

function refSubject(
  repository: string,
  ref: string,
): GitHubRepositoryObservation["subject"] {
  return {
    kind: "ref",
    externalId: `github:${repository}@${ref}`,
  };
}

function contentRevision(
  name: GitHubRepositoryContentRevision["name"],
  value: unknown,
): GitHubRepositoryContentRevision {
  if (value === null || value === undefined) {
    return {
      name,
      present: false,
      byteLength: 0,
      sha256: sha256(stableJson({ present: false })),
    };
  }
  if (typeof value !== "string") {
    throw new RangeError(`GitHub ${name} content must be text or null`);
  }
  const canonical = canonicalBody(value);
  if (/\u0000/u.test(canonical)) {
    throw new RangeError(`GitHub ${name} content contains NUL bytes`);
  }
  const byteLength = Buffer.byteLength(canonical, "utf8");
  if (byteLength > maximumContentBytes) {
    throw new RangeError(
      `GitHub ${name} content exceeds ${maximumContentBytes} UTF-8 bytes`,
    );
  }
  return {
    name,
    present: true,
    byteLength,
    sha256: sha256(stableJson({ present: true, content: canonical })),
  };
}

function canonicalContentRevisions(
  values: GitHubRepositoryContentRevision[],
): GitHubRepositoryContentRevision[] {
  return values.sort((left, right) => codeUnitCompare(left.name, right.name));
}

function optionalProviderId(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return providerId(value, label);
}

function providerId(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${label} must be a positive safe integer`);
    }
    return String(value);
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,39}$/u.test(value)) {
    return value;
  }
  throw new RangeError(`${label} must be a positive provider identity`);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function booleanValue(
  value: unknown,
  label: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new RangeError(`${label} must be boolean`);
  }
  return value;
}

function identityText(value: string, label: string, maximum: number): string {
  if (
    !value
    || value !== value.trim()
    || [...value].length > maximum
    || unsafeIdentityTextPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function boundedPattern(
  value: string,
  label: string,
  pattern: RegExp,
): string {
  if (!pattern.test(value)) throw new RangeError(`${label} is invalid`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be text`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  return record(value, label);
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return record(value, "GitHub webhook nested value");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
