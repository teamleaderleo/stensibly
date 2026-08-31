import { describe, expect, test } from "bun:test";
import {
  compileGitHubCoordinationWakeV1,
  githubCoordinationSourceIdentity,
} from "../src/github-coordination-wake.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "../src/github-repository-observation.ts";

const receivedAt = "2026-08-31T13:00:00.000Z";
const project = "stensibly";

describe("GitHub repository coordination wakes", () => {
  test("maps an issue comment to one stable explicit issue relation", () => {
    const observation = issueCommentObservation();
    const sourceIdentity = "github:teamleaderleo/stensibly#issue/1762";
    const result = compileGitHubCoordinationWakeV1({
      project,
      observation,
      subscription: subscription(sourceIdentity, "github.issue_comment.created"),
      routingLevel: "attention",
    });

    expect(result.sourceIdentity).toBe(sourceIdentity);
    expect(result.event).toMatchObject({
      eventId: observation.observationId,
      sourceItemId: sourceIdentity,
      correlationId: sourceIdentity,
      eventType: "github.issue_comment.created",
      routingLevel: "attention",
      sourceRunId: null,
    });
    expect(result.event.sourceRefs).toEqual([
      `github-observation:${observation.observationId}`,
      `github-semantic:${observation.semanticFingerprint}`,
    ]);
    expect(result.decision).toMatchObject({
      matched: true,
      reason: "matched",
      targetItemId: "item_owned_workstation",
      targetGeneration: 7,
      wakeIntent: {
        grantsAuthority: false,
        authorizesDispatch: false,
      },
    });
  });

  test("keeps pull requests and moving refs stable without scanning work", () => {
    const pullRequest = mapped("pull_request", {
      action: "synchronize",
      repository: repository(),
      sender: actor(),
      pull_request: {
        number: 1800,
        id: 1800,
        state: "open",
        updated_at: receivedAt,
        head: { sha: "a".repeat(40) },
        base: { sha: "b".repeat(40) },
        merge_commit_sha: null,
        draft: false,
        merged: false,
      },
      number: 1800,
    });
    const push = mapped("push", {
      repository: repository(),
      sender: actor(),
      ref: "refs/heads/main",
      before: "b".repeat(40),
      after: "a".repeat(40),
      created: false,
      deleted: false,
      forced: false,
      size: 1,
      head_commit: { timestamp: receivedAt },
    });

    expect(githubCoordinationSourceIdentity(pullRequest))
      .toBe("github:teamleaderleo/stensibly#pull/1800");
    expect(githubCoordinationSourceIdentity(push))
      .toBe("github:teamleaderleo/stensibly#ref/refs/heads/main");
  });

  test("mismatched explicit relations remain a deterministic no-op", () => {
    const observation = issueCommentObservation();
    const result = compileGitHubCoordinationWakeV1({
      project,
      observation,
      subscription: subscription(
        "github:teamleaderleo/stensibly#issue/9999",
        "github.issue_comment.created",
      ),
      routingLevel: "attention",
    });
    expect(result.decision).toMatchObject({
      matched: false,
      reason: "source_item_mismatch",
      wakeIntent: null,
    });
  });
});

function subscription(sourceIdentity: string, eventType: string) {
  return {
    version: 1 as const,
    id: "subscription:github:owned-workstation",
    generation: 3,
    project,
    sourceItemId: sourceIdentity,
    sourceCorrelationId: sourceIdentity,
    eventTypes: [eventType],
    targetItemId: "item_owned_workstation",
    targetGeneration: 7,
    minimumRoutingLevel: "attention" as const,
    createdAt: "2026-08-31T12:00:00.000Z",
    expiresAt: "2026-09-01T12:00:00.000Z",
  };
}

function issueCommentObservation(): GitHubRepositoryObservation {
  return mapped("issue_comment", {
    action: "created",
    repository: repository(),
    sender: actor(),
    issue: {
      number: 1762,
      id: 1762,
      updated_at: receivedAt,
      user: actor(),
    },
    comment: {
      id: 4242,
      body: "bounded request",
      created_at: receivedAt,
      updated_at: receivedAt,
      user: actor(),
    },
  });
}

function mapped(eventType: string, payload: unknown): GitHubRepositoryObservation {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const result = mapGitHubRepositoryWebhook({
    eventType,
    deliveryId: `delivery-${eventType}`,
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
  });
  if (!result) throw new Error("fixture did not map");
  return result;
}

function repository() {
  return { full_name: "teamleaderleo/stensibly" };
}

function actor() {
  return { login: "teamleaderleo" };
}
