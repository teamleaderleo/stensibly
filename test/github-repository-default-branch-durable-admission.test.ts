import { expect, test } from "bun:test";
import {
  admitHostedGitHubRepositoryObservationInput,
} from "../src/github-repository-observation-admission.ts";
import {
  withObservedRepositoryDefaultBranch,
} from "../src/github-repository-default-branch.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const receivedAt = "2026-08-10T00:30:00.000Z";

function pushPayload(defaultBranch?: string) {
  return {
    repository: {
      full_name: repository,
      ...(defaultBranch === undefined ? {} : { default_branch: defaultBranch }),
    },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: "2".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    size: 1,
    head_commit: { timestamp: "2026-08-10T00:29:00.000Z" },
  };
}

function map(defaultBranch?: string) {
  const payload = pushPayload(defaultBranch);
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const observation = mapGitHubRepositoryWebhook({
    eventType: "push",
    deliveryId: defaultBranch === undefined
      ? "delivery-branchless-durable"
      : "delivery-default-branch-durable",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  });
  return {
    payload,
    observation: withObservedRepositoryDefaultBranch(observation, payload)!,
  };
}

function admit(defaultBranch?: string) {
  const { observation } = map(defaultBranch);
  return admitHostedGitHubRepositoryObservationInput({
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    observation,
    payloadDigest: observation.payloadDigest,
    receivedAt: observation.receivedAt,
  });
}

test("durable observation admission accepts the verified repository default branch", () => {
  const admitted = admit("main");
  expect(admitted.observation.facts).toMatchObject({
    commitCount: 1,
    created: false,
    defaultBranch: "main",
    deleted: false,
    forced: false,
  });
});

test("durable observation admission preserves branch-less compatibility", () => {
  const admitted = admit();
  expect(admitted.observation.facts).toEqual({
    commitCount: 1,
    created: false,
    deleted: false,
    forced: false,
  });
});
