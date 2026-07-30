import { describe, expect, test } from "bun:test";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const revision = "a".repeat(40);
const originalRevision = "b".repeat(40);
const receivedAt = "2026-07-31T04:10:05.000Z";

function map(
  payload: Record<string, unknown>,
  deliveryId = "delivery-review-comment",
) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return mapGitHubRepositoryWebhook({
    eventType: "pull_request_review_comment",
    deliveryId,
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  })!;
}

function payload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "created",
    repository: { full_name: repository },
    sender: { login: "Reviewer" },
    pull_request: { number: 638 },
    comment: {
      id: "9007199254740994",
      pull_request_review_id: "9007199254740993",
      in_reply_to_id: 77,
      commit_id: revision,
      original_commit_id: originalRevision,
      body: "Private diff comment\r\nwith detail",
      path: "src/private-path.ts",
      diff_hunk: "@@ private diff context @@",
      created_at: "2026-07-31T04:09:00.000Z",
      updated_at: "2026-07-31T04:10:00.000Z",
    },
    ...overrides,
  };
}

describe("GitHub pull request review comment observations", () => {
  test("maps comment and review identity without retaining path, diff, or prose", () => {
    const observation = map(payload());

    expect(observation).toMatchObject({
      eventType: "pull_request_review_comment",
      action: "created",
      repository,
      actor: "reviewer",
      subject: {
        kind: "pull_request_review_comment",
        externalId:
          `github:${repository}#pull/638/review-comment/9007199254740994`,
      },
      relationships: {
        revision,
        pullRequestNumber: 638,
        issueNumber: 638,
        commentId: "9007199254740994",
      },
      facts: {
        reviewId: "9007199254740993",
        inReplyToId: "77",
      },
      sourceTime: "2026-07-31T04:10:00.000Z",
      sourceTimeSource: "provider",
      containsRawContent: false,
    });
    expect(observation.contentRevisions).toHaveLength(1);
    expect(observation.contentRevisions[0]).toMatchObject({
      name: "comment_body",
      present: true,
      byteLength: Buffer.byteLength(
        "Private diff comment\nwith detail",
        "utf8",
      ),
    });
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toContain("Private diff comment");
    expect(serialized).not.toContain("src/private-path.ts");
    expect(serialized).not.toContain("private diff context");
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.relationships)).toBe(true);
    expect(Object.isFrozen(observation.facts)).toBe(true);
  });

  test("maps edited and deleted comments with optional identities and time fallback", () => {
    const edited = map(payload({
      action: "edited",
      comment: {
        id: 45,
        commit_id: revision,
        body: null,
        updated_at: "2026-07-31T04:11:00.000Z",
      },
    }), "delivery-edited-comment");
    expect(edited).toMatchObject({
      action: "edited",
      facts: { reviewId: null, inReplyToId: null },
      sourceTime: "2026-07-31T04:11:00.000Z",
      sourceTimeSource: "provider",
    });
    expect(edited.contentRevisions[0]).toMatchObject({
      name: "comment_body",
      present: false,
      byteLength: 0,
    });

    const deleted = map(payload({
      action: "deleted",
      comment: {
        id: 46,
        original_commit_id: originalRevision,
        body: null,
      },
    }), "delivery-deleted-comment");
    expect(deleted).toMatchObject({
      action: "deleted",
      relationships: { revision: originalRevision },
      sourceTime: receivedAt,
      sourceTimeSource: "received",
    });
  });

  test("keeps provider delivery identity separate from comment semantics", () => {
    const first = map(payload(), "delivery-one");
    const second = map(payload(), "delivery-two");

    expect(first.observationId).not.toBe(second.observationId);
    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
    expect(first.payloadDigest).toBe(second.payloadDigest);
  });

  test("rejects unknown actions, identities, parent identities, and revisions", () => {
    expect(() => map(payload({ action: "submitted" })))
      .toThrow("review comment action is invalid");
    expect(() => map(payload({
      comment: { id: 0, commit_id: revision },
    }))).toThrow("positive safe integer");
    expect(() => map(payload({
      comment: {
        id: 42,
        commit_id: revision,
        in_reply_to_id: 0,
      },
    }))).toThrow("positive safe integer");
    expect(() => map(payload({
      comment: { id: 42, commit_id: "abc" },
    }))).toThrow("full Git revision");
  });
});
