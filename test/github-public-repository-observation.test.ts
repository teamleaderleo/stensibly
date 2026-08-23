import { describe, expect, test } from "bun:test";
import {
  admitAnyHostedGitHubRepositoryObservationInput,
} from "../src/github-repository-observation-any-admission.ts";
import {
  admitHostedPublicGitHubRepositoryObservationInput,
} from "../src/github-public-repository-observation-admission.ts";
import {
  crossSourceGitHubObservationFingerprint,
  mapPublicGitHubRepositoryEvent,
} from "../src/github-public-repository-observation.ts";

const repository = "Coreys-Quarry/quarry";
const canonicalRepository = "coreys-quarry/quarry";
const head = "a".repeat(40);
const base = "b".repeat(40);
const merged = "c".repeat(40);
const receivedAt = "2026-08-23T03:30:00.000Z";

function pullRequestEvent(action = "opened") {
  return {
    id: "10001",
    type: "PullRequestEvent",
    actor: { login: "teamleaderleo" },
    repo: { name: repository },
    public: true,
    created_at: "2026-08-23T03:29:00Z",
    payload: {
      action,
      number: 780,
      pull_request: {
        number: 780,
        state: action === "closed" || action === "merged" ? "closed" : "open",
        draft: false,
        locked: false,
        merged: action === "merged",
        updated_at: "2026-08-23T03:29:00Z",
        title: "Shared source evidence",
        body: "Bounded body",
        head: { sha: head },
        base: { sha: base },
        merge_commit_sha: action === "merged" ? merged : null,
      },
    },
  };
}

function reviewEvent(action = "created", revision = head) {
  return {
    id: "10002",
    type: "PullRequestReviewEvent",
    actor: { login: "reviewer" },
    repo: { name: repository },
    public: true,
    created_at: "2026-08-23T03:29:30Z",
    payload: {
      action,
      pull_request: {
        number: 780,
        head: { sha: head },
      },
      review: {
        id: 9001,
        commit_id: revision,
        state: "approved",
        body: "Reviewed",
        submitted_at: "2026-08-23T03:29:30Z",
      },
    },
  };
}

describe("public GitHub repository observation", () => {
  test("maps PR lifecycle with explicit public provenance", () => {
    const mapped = mapPublicGitHubRepositoryEvent(
      pullRequestEvent("opened"),
      repository,
      receivedAt,
    );
    expect(mapped).not.toBeNull();
    expect(mapped?.currentHeadRevision).toBe(head);
    expect(mapped?.observation).toMatchObject({
      provider: "github",
      sourceSchema: "github-public-events",
      sourceSchemaVersion: "2022-11-28",
      eventType: "pull_request",
      action: "opened",
      repository: canonicalRepository,
      deliveryId: "public-event:10001",
      observationId: "github-public:pull_request:public-event:10001",
      relationships: {
        revision: head,
        baseRevision: base,
        pullRequestNumber: 780,
      },
      facts: {
        draft: false,
        locked: false,
        merged: false,
        state: "open",
      },
      containsRawContent: false,
    });
  });

  test("normalizes merged lifecycle and created review semantics", () => {
    const mergedEvent = mapPublicGitHubRepositoryEvent(
      pullRequestEvent("merged"),
      repository,
      receivedAt,
    );
    expect(mergedEvent?.observation).toMatchObject({
      action: "closed",
      facts: { merged: true, state: "closed" },
      relationships: { mergeRevision: merged },
    });

    const review = mapPublicGitHubRepositoryEvent(reviewEvent(), repository, receivedAt);
    expect(review?.observation).toMatchObject({
      eventType: "pull_request_review",
      action: "submitted",
      relationships: {
        revision: head,
        pullRequestNumber: 780,
      },
      facts: { state: "approved", reviewId: "9001" },
    });
    expect(review?.currentHeadRevision).toBe(head);
  });

  test("keeps unsupported activity quiet and rejects source mismatch", () => {
    expect(mapPublicGitHubRepositoryEvent({
      ...pullRequestEvent(),
      type: "PushEvent",
    }, repository, receivedAt)).toBeNull();
    expect(() => mapPublicGitHubRepositoryEvent({
      ...pullRequestEvent(),
      repo: { name: "teamleaderleo/stensibly" },
    }, repository, receivedAt)).toThrow("does not match");
    expect(() => mapPublicGitHubRepositoryEvent({
      ...pullRequestEvent(),
      public: false,
    }, repository, receivedAt)).toThrow("accepts only public events");
  });

  test("strict admission preserves public source identity", () => {
    const observation = mapPublicGitHubRepositoryEvent(
      pullRequestEvent(),
      repository,
      receivedAt,
    )!.observation;
    const input = {
      deliveryId: observation.deliveryId,
      eventType: observation.eventType,
      payloadDigest: observation.payloadDigest,
      receivedAt: observation.receivedAt,
      observation,
    };
    const admitted = admitHostedPublicGitHubRepositoryObservationInput(input);
    expect(admitted.observation.sourceSchema).toBe("github-public-events");
    expect(admitted.observationId).toBe(observation.observationId);
    expect(admitted.semanticFingerprint).toBe(observation.semanticFingerprint);
    expect(admitAnyHostedGitHubRepositoryObservationInput(input).observation.sourceSchema)
      .toBe("github-public-events");
  });

  test("rejects public source relabeling, forged IDs, and fingerprint drift", () => {
    const observation = mapPublicGitHubRepositoryEvent(
      pullRequestEvent(),
      repository,
      receivedAt,
    )!.observation;
    const baseInput = {
      deliveryId: observation.deliveryId,
      eventType: observation.eventType,
      payloadDigest: observation.payloadDigest,
      receivedAt: observation.receivedAt,
    };
    expect(() => admitHostedPublicGitHubRepositoryObservationInput({
      ...baseInput,
      observation: { ...observation, sourceSchema: "github-webhook" },
    })).toThrow();
    expect(() => admitHostedPublicGitHubRepositoryObservationInput({
      ...baseInput,
      observation: { ...observation, observationId: "github-public:pull_request:public-event:99999" },
    })).toThrow("ID is inconsistent");
    expect(() => admitHostedPublicGitHubRepositoryObservationInput({
      ...baseInput,
      observation: { ...observation, semanticFingerprint: `sha256:${"0".repeat(64)}` },
    })).toThrow("semantic fingerprint is invalid");
  });

  test("cross-source fingerprint intentionally ignores delivery source metadata", () => {
    const observation = mapPublicGitHubRepositoryEvent(
      pullRequestEvent(),
      repository,
      receivedAt,
    )!.observation;
    const webhookLike = {
      ...observation,
      sourceSchema: "github-webhook" as const,
      observationId: "github:pull_request:webhook-delivery",
      deliveryId: "webhook-delivery",
      payloadDigest: `sha256:${"1".repeat(64)}`,
      semanticFingerprint: `sha256:${"2".repeat(64)}`,
      receivedAt: "2026-08-23T03:31:00.000Z",
    };
    expect(crossSourceGitHubObservationFingerprint(observation))
      .toBe(crossSourceGitHubObservationFingerprint(webhookLike));
  });
});
