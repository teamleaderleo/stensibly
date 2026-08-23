import type {
  GitHubRepositoryContentRevision,
  GitHubRepositoryObservation,
  GitHubRepositoryObservationRelationships,
} from "./github-repository-observation.js";
import {
  canonicalBody,
  canonicalTimestamp,
  normalizeGitHubRepository,
  positiveInteger,
  sha256,
  stableJson,
} from "./github-provider-validation.js";
import { snapshotBoundedJson } from "./github-repository-observation-admission.js";

export type PublicGitHubRepositoryObservation = Omit<
  GitHubRepositoryObservation,
  "sourceSchema" | "observationId"
> & {
  readonly sourceSchema: "github-public-events";
  readonly observationId: string;
};

export interface MappedPublicGitHubRepositoryEvent {
  readonly observation: PublicGitHubRepositoryObservation;
  readonly currentHeadRevision: string;
}

const providerIdPattern = /^[1-9][0-9]{0,39}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[bot\])?$/u;
const maximumContentBytes = 256 * 1_024;

/**
 * Map one bounded object from GitHub's public repository Events API into the
 * same semantic observation family used by mail attention, while retaining an
 * explicit non-webhook source schema. Unsupported event/action families stay
 * quiet by returning null.
 */
export function mapPublicGitHubRepositoryEvent(
  value: unknown,
  expectedRepository: string,
  receivedAtValue: string,
): MappedPublicGitHubRepositoryEvent | null {
  const detached = snapshotBoundedJson(value, "GitHub public repository event");
  const event = record(detached, "GitHub public repository event");
  const id = providerId(event.id, "GitHub public event ID");
  const type = stringValue(event.type, "GitHub public event type");
  const repository = normalizeGitHubRepository(
    stringValue(record(event.repo, "GitHub public event repository").name, "GitHub public event repository name"),
  );
  const expected = normalizeGitHubRepository(expectedRepository);
  if (repository !== expected) {
    throw new RangeError(`GitHub public event repository ${repository} does not match ${expected}`);
  }
  if (event.public !== true) {
    throw new RangeError("GitHub public repository observer accepts only public events");
  }
  const actor = actorLogin(event.actor);
  const eventCreatedAt = canonicalTimestamp(
    stringValue(event.created_at, "GitHub public event created time"),
    "GitHub public event created time",
  );
  const receivedAt = canonicalTimestamp(receivedAtValue, "GitHub public event receipt time");
  const payload = record(event.payload, "GitHub public event payload");
  const payloadDigest = `sha256:${sha256(stableJson(detached))}`;
  const deliveryId = `public-event:${id}`;

  if (type === "PullRequestEvent") {
    const actionValue = stringValue(payload.action, "GitHub public pull request action");
    if (!["opened", "reopened", "closed", "merged"].includes(actionValue)) return null;
    const pullRequest = record(payload.pull_request, "GitHub public pull request");
    const number = positiveInteger(
      payload.number ?? pullRequest.number,
      "GitHub public pull request number",
    );
    const revision = revisionValue(
      record(pullRequest.head, "GitHub public pull request head").sha,
      "GitHub public pull request head revision",
    );
    const baseRevision = revisionValue(
      record(pullRequest.base, "GitHub public pull request base").sha,
      "GitHub public pull request base revision",
    );
    const mergeRevision = optionalRevision(
      pullRequest.merge_commit_sha,
      "GitHub public pull request merge revision",
    );
    const action = actionValue === "merged" ? "closed" : actionValue;
    const merged = actionValue === "merged"
      ? true
      : booleanValue(pullRequest.merged, false, "GitHub public pull request merged flag");
    const state = action === "closed"
      ? "closed"
      : exactState(pullRequest.state, "GitHub public pull request state");
    const sourceTime = pullRequest.updated_at === undefined || pullRequest.updated_at === null
      ? eventCreatedAt
      : canonicalTimestamp(
          stringValue(pullRequest.updated_at, "GitHub public pull request updated time"),
          "GitHub public pull request updated time",
        );
    const semantics = {
      eventType: "pull_request" as const,
      action,
      repository,
      actor,
      subject: {
        kind: "pull_request" as const,
        externalId: `github:${repository}#pull/${number}`,
      },
      relationships: relationships(repository, {
        revision,
        baseRevision,
        mergeRevision,
        pullRequestNumber: number,
        issueNumber: number,
      }),
      facts: {
        draft: booleanValue(pullRequest.draft, false, "GitHub public pull request draft flag"),
        locked: booleanValue(pullRequest.locked, false, "GitHub public pull request locked flag"),
        merged,
        state,
      },
      contentRevisions: canonicalContentRevisions([
        contentRevision("title", pullRequest.title),
        contentRevision("body", pullRequest.body),
      ]),
      sourceTime,
      sourceTimeSource: "provider" as const,
    };
    return Object.freeze({
      observation: finalizePublicObservation({
        deliveryId,
        payloadDigest,
        receivedAt,
        ...semantics,
      }),
      currentHeadRevision: revision,
    });
  }

  if (type === "PullRequestReviewEvent") {
    const actionValue = stringValue(payload.action, "GitHub public review action");
    const action = actionValue === "created"
      ? "submitted"
      : actionValue === "updated"
      ? "edited"
      : actionValue === "dismissed"
      ? "dismissed"
      : null;
    if (action === null) return null;
    const pullRequest = record(payload.pull_request, "GitHub public review pull request");
    const review = record(payload.review, "GitHub public review");
    const number = positiveInteger(
      pullRequest.number,
      "GitHub public review pull request number",
    );
    const currentHeadRevision = revisionValue(
      record(pullRequest.head, "GitHub public review pull request head").sha,
      "GitHub public review current head revision",
    );
    const reviewRevision = revisionValue(
      review.commit_id,
      "GitHub public review revision",
    );
    const reviewId = providerId(review.id, "GitHub public review ID");
    const state = reviewState(review.state);
    const sourceTime = review.submitted_at === undefined || review.submitted_at === null
      ? eventCreatedAt
      : canonicalTimestamp(
          stringValue(review.submitted_at, "GitHub public review submitted time"),
          "GitHub public review submitted time",
        );
    const semantics = {
      eventType: "pull_request_review" as const,
      action,
      repository,
      actor,
      subject: {
        kind: "pull_request_review" as const,
        externalId: `github:${repository}#pull/${number}/review/${reviewId}`,
      },
      relationships: relationships(repository, {
        revision: reviewRevision,
        pullRequestNumber: number,
        issueNumber: number,
      }),
      facts: { state, reviewId },
      contentRevisions: canonicalContentRevisions([
        contentRevision("review_body", review.body),
      ]),
      sourceTime,
      sourceTimeSource: "provider" as const,
    };
    return Object.freeze({
      observation: finalizePublicObservation({
        deliveryId,
        payloadDigest,
        receivedAt,
        ...semantics,
      }),
      currentHeadRevision,
    });
  }

  return null;
}

export function crossSourceGitHubObservationFingerprint(
  observation: Pick<
    PublicGitHubRepositoryObservation,
    | "eventType"
    | "action"
    | "repository"
    | "actor"
    | "subject"
    | "relationships"
    | "facts"
    | "contentRevisions"
    | "sourceTime"
    | "sourceTimeSource"
    | "containsRawContent"
  >,
): string {
  return `sha256:${sha256(stableJson({
    eventType: observation.eventType,
    action: observation.action,
    repository: observation.repository,
    actor: observation.actor,
    subject: observation.subject,
    relationships: observation.relationships,
    facts: observation.facts,
    contentRevisions: observation.contentRevisions,
    sourceTime: observation.sourceTime,
    sourceTimeSource: observation.sourceTimeSource,
    containsRawContent: observation.containsRawContent,
  }))}`;
}

function finalizePublicObservation(input: {
  deliveryId: string;
  payloadDigest: string;
  receivedAt: string;
  eventType: "pull_request" | "pull_request_review";
  action: string;
  repository: string;
  actor: string | null;
  subject: PublicGitHubRepositoryObservation["subject"];
  relationships: GitHubRepositoryObservationRelationships;
  facts: Readonly<Record<string, string | number | boolean | null>>;
  contentRevisions: readonly GitHubRepositoryContentRevision[];
  sourceTime: string;
  sourceTimeSource: "provider";
}): PublicGitHubRepositoryObservation {
  const canonicalSemantics = {
    version: 1 as const,
    provider: "github" as const,
    sourceSchema: "github-public-events" as const,
    sourceSchemaVersion: "2022-11-28" as const,
    eventType: input.eventType,
    action: input.action,
    repository: input.repository,
    actor: input.actor,
    subject: input.subject,
    relationships: input.relationships,
    facts: input.facts,
    contentRevisions: input.contentRevisions,
    sourceTime: input.sourceTime,
    sourceTimeSource: input.sourceTimeSource,
    containsRawContent: false as const,
  };
  return deepFreeze({
    ...canonicalSemantics,
    observationId: `github-public:${input.eventType}:${input.deliveryId}`,
    deliveryId: input.deliveryId,
    payloadDigest: input.payloadDigest,
    semanticFingerprint: `sha256:${sha256(stableJson(canonicalSemantics))}`,
    receivedAt: input.receivedAt,
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

function contentRevision(
  name: GitHubRepositoryContentRevision["name"],
  value: unknown,
): GitHubRepositoryContentRevision {
  if (value === null || value === undefined) {
    return {
      name,
      present: false,
      byteLength: 0,
      sha256: `sha256:${sha256(stableJson({ present: false }))}`,
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
    throw new RangeError(`GitHub ${name} content exceeds ${maximumContentBytes} UTF-8 bytes`);
  }
  return {
    name,
    present: true,
    byteLength,
    sha256: `sha256:${sha256(stableJson({ present: true, content: canonical }))}`,
  };
}

function canonicalContentRevisions(
  values: GitHubRepositoryContentRevision[],
): GitHubRepositoryContentRevision[] {
  return values.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function actorLogin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const actor = record(value, "GitHub public event actor");
  if (actor.login === null || actor.login === undefined) return null;
  const login = stringValue(actor.login, "GitHub public event actor login");
  if (!actorPattern.test(login)) {
    throw new RangeError("GitHub public event actor login is invalid");
  }
  return login.toLowerCase();
}

function providerId(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${label} must be a positive provider identity`);
    }
    return String(value);
  }
  if (typeof value === "string" && providerIdPattern.test(value)) return value;
  throw new RangeError(`${label} must be a positive provider identity`);
}

function revisionValue(value: unknown, label: string): string {
  const revision = stringValue(value, label).toLowerCase();
  if (!revisionPattern.test(revision)) throw new RangeError(`${label} must be a full Git revision`);
  return revision;
}

function optionalRevision(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return revisionValue(value, label);
}

function exactState(value: unknown, label: string): "open" | "closed" {
  if (value === "open" || value === "closed") return value;
  throw new RangeError(`${label} must be open or closed`);
}

function reviewState(value: unknown): "approved" | "changes_requested" | "commented" | "dismissed" | "pending" {
  if (typeof value !== "string") throw new RangeError("GitHub public review state is invalid");
  const normalized = value.toLowerCase();
  if (
    normalized === "approved"
    || normalized === "changes_requested"
    || normalized === "commented"
    || normalized === "dismissed"
    || normalized === "pending"
  ) return normalized;
  throw new RangeError("GitHub public review state is invalid");
}

function booleanValue(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new RangeError(`${label} must be boolean`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) throw new RangeError(`${label} is invalid`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${label} must be a record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
