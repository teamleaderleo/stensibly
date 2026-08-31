import { describe, expect, test } from "bun:test";
import { classifyGitHubPrMaterialityV1 } from "../src/github-pr-materiality.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
  type GitHubRepositoryObservation,
} from "../src/github-repository-observation.ts";

const receivedAt = "2026-08-31T19:00:00.000Z";
const head = "a".repeat(40);
const base = "b".repeat(40);

describe("GitHub PR materiality", () => {
  test("makes non-draft open/reopen and ready-for-review candidates review-eligible", () => {
    for (const action of ["opened", "reopened", "ready_for_review"]) {
      const result = classifyGitHubPrMaterialityV1(pullRequest(action, { draft: false }));
      expect(result).toMatchObject({
        actionClass: "review_eligible",
        routingLevel: "attention",
        makesReviewEligible: true,
        grantsAuthority: false,
        authorizesDispatch: false,
      });
    }
    expect(classifyGitHubPrMaterialityV1(pullRequest("opened", { draft: true })))
      .toMatchObject({ actionClass: "routine", routingLevel: "record" });
  });

  test("treats head movement and draft conversion as attention without judging the candidate", () => {
    const moved = classifyGitHubPrMaterialityV1(pullRequest("synchronize"));
    expect(moved).toMatchObject({
      actionClass: "exact_head_changed",
      routingLevel: "attention",
      invalidatesExactHeadEvidence: true,
      invalidatesReviewEvidence: true,
      settlesCandidate: false,
    });
    expect(classifyGitHubPrMaterialityV1(pullRequest("converted_to_draft")))
      .toMatchObject({
        actionClass: "review_suspended",
        routingLevel: "attention",
        invalidatesExactHeadEvidence: false,
        invalidatesReviewEvidence: false,
      });
  });

  test("distinguishes a merged close from an ordinary closed candidate", () => {
    expect(classifyGitHubPrMaterialityV1(pullRequest("closed", { merged: false })))
      .toMatchObject({
        actionClass: "candidate_closed",
        routingLevel: "attention",
        settlesCandidate: true,
        merged: false,
      });
    expect(classifyGitHubPrMaterialityV1(pullRequest("closed", { merged: true })))
      .toMatchObject({
        actionClass: "candidate_merged",
        routingLevel: "attention",
        settlesCandidate: true,
        merged: true,
      });
  });

  test("routes review verdicts to repair or integration and keeps comments routine", () => {
    expect(classifyGitHubPrMaterialityV1(review("submitted", "changes_requested")))
      .toMatchObject({
        actionClass: "repair_requested",
        routingLevel: "attention",
        makesRepairEligible: true,
      });
    expect(classifyGitHubPrMaterialityV1(review("submitted", "approved")))
      .toMatchObject({
        actionClass: "integration_eligible",
        routingLevel: "attention",
        makesIntegrationEligible: true,
      });
    expect(classifyGitHubPrMaterialityV1(review("submitted", "commented")))
      .toMatchObject({ actionClass: "routine", routingLevel: "record" });
  });

  test("invalidates dismissed review evidence without pretending the head changed", () => {
    expect(classifyGitHubPrMaterialityV1(review("dismissed", "dismissed")))
      .toMatchObject({
        actionClass: "review_invalidated",
        routingLevel: "attention",
        invalidatesExactHeadEvidence: false,
        invalidatesReviewEvidence: true,
      });
  });

  test("ignores non-PR repository events and fingerprints exact replay deterministically", () => {
    const push = mapped("push", {
      repository: repository(),
      sender: actor(),
      ref: "refs/heads/main",
      before: base,
      after: head,
      created: false,
      deleted: false,
      forced: false,
      size: 1,
      head_commit: { timestamp: receivedAt },
    });
    expect(classifyGitHubPrMaterialityV1(push)).toBeNull();

    const observation = pullRequest("synchronize");
    const first = classifyGitHubPrMaterialityV1(observation);
    const second = classifyGitHubPrMaterialityV1(observation);
    expect(first).toEqual(second);
    expect(first?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

function pullRequest(
  action: string,
  overrides: { draft?: boolean; merged?: boolean } = {},
): GitHubRepositoryObservation {
  return mapped("pull_request", {
    action,
    repository: repository(),
    sender: actor(),
    number: 42,
    pull_request: {
      number: 42,
      id: 4200,
      state: action === "closed" ? "closed" : "open",
      updated_at: receivedAt,
      head: { sha: head },
      base: { sha: base },
      merge_commit_sha: overrides.merged ? "c".repeat(40) : null,
      draft: overrides.draft ?? false,
      locked: false,
      merged: overrides.merged ?? false,
    },
  });
}

function review(action: string, state: string): GitHubRepositoryObservation {
  return mapped("pull_request_review", {
    action,
    repository: repository(),
    sender: actor(),
    pull_request: {
      number: 42,
      id: 4200,
      state: "open",
      updated_at: receivedAt,
      head: { sha: head },
      base: { sha: base },
    },
    review: {
      id: 9001,
      commit_id: head,
      state,
      submitted_at: receivedAt,
      body: null,
    },
  });
}

function mapped(eventType: string, payload: unknown): GitHubRepositoryObservation {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const result = mapGitHubRepositoryWebhook({
    eventType,
    deliveryId: `materiality-${eventType}-${crypto.randomUUID()}`,
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
