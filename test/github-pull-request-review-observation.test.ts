import { describe, expect, test } from "bun:test";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const revision = "a".repeat(40);
const receivedAt = "2026-07-31T03:30:05.000Z";

function map(
  payload: Record<string, unknown>,
  deliveryId = "delivery-review",
) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return mapGitHubRepositoryWebhook({
    eventType: "pull_request_review",
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
    action: "submitted",
    repository: { full_name: repository },
    sender: { login: "Reviewer" },
    pull_request: {
      number: 634,
      updated_at: "2026-07-31T03:29:00.000Z",
    },
    review: {
      id: "9007199254740993",
      commit_id: revision,
      state: "approved",
      body: "Private review prose\r\nwith detail",
      submitted_at: "2026-07-31T03:30:00.000Z",
    },
    ...overrides,
  };
}

describe("GitHub pull request review observations", () => {
  test("maps review identity and revision without retaining prose", () => {
    const observation = map(payload());

    expect(observation).toMatchObject({
      eventType: "pull_request_review",
      action: "submitted",
      repository,
      actor: "reviewer",
      subject: {
        kind: "pull_request_review",
        externalId:
          `github:${repository}#pull/634/review/9007199254740993`,
      },
      relationships: {
        revision,
        pullRequestNumber: 634,
        issueNumber: 634,
      },
      facts: {
        state: "approved",
        reviewId: "9007199254740993",
      },
      sourceTime: "2026-07-31T03:30:00.000Z",
      sourceTimeSource: "provider",
      containsRawContent: false,
    });
    expect(observation.contentRevisions).toHaveLength(1);
    expect(observation.contentRevisions[0]).toMatchObject({
      name: "review_body",
      present: true,
      byteLength: Buffer.byteLength(
        "Private review prose\nwith detail",
        "utf8",
      ),
    });
    expect(JSON.stringify(observation)).not.toContain("Private review prose");
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.relationships)).toBe(true);
    expect(Object.isFrozen(observation.contentRevisions)).toBe(true);
  });

  test("maps edited and dismissed reviews with bounded time fallbacks", () => {
    const edited = map(payload({
      action: "edited",
      review: {
        id: 42,
        commit_id: revision,
        state: "commented",
        body: null,
      },
    }), "delivery-edited");
    expect(edited).toMatchObject({
      action: "edited",
      facts: { state: "commented", reviewId: "42" },
      sourceTime: "2026-07-31T03:29:00.000Z",
      sourceTimeSource: "provider",
    });
    expect(edited.contentRevisions[0]).toMatchObject({
      name: "review_body",
      present: false,
      byteLength: 0,
    });

    const dismissed = map(payload({
      action: "dismissed",
      pull_request: { number: 634 },
      review: {
        id: 43,
        commit_id: revision,
        state: "dismissed",
        body: null,
      },
    }), "delivery-dismissed");
    expect(dismissed).toMatchObject({
      action: "dismissed",
      facts: { state: "dismissed", reviewId: "43" },
      sourceTime: receivedAt,
      sourceTimeSource: "received",
    });
  });

  test("keeps provider delivery identity separate from review semantics", () => {
    const first = map(payload(), "delivery-one");
    const second = map(payload(), "delivery-two");

    expect(first.observationId).not.toBe(second.observationId);
    expect(first.deliveryId).not.toBe(second.deliveryId);
    expect(first.semanticFingerprint).toBe(second.semanticFingerprint);
    expect(first.payloadDigest).toBe(second.payloadDigest);
  });

  test("rejects unknown actions, states, identities, and revisions", () => {
    expect(() => map(payload({ action: "created" })))
      .toThrow("review action is invalid");
    expect(() => map(payload({
      review: {
        id: 42,
        commit_id: revision,
        state: "unknown",
      },
    }))).toThrow("review state is invalid");
    expect(() => map(payload({
      review: {
        id: 0,
        commit_id: revision,
        state: "approved",
      },
    }))).toThrow("positive safe integer");
    expect(() => map(payload({
      review: {
        id: 42,
        commit_id: "abc",
        state: "approved",
      },
    }))).toThrow("full Git revision");
  });
});
