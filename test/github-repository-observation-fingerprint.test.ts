import { expect, test } from "bun:test";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";

test("keeps the original push observation fingerprint stable", () => {
  const payload = {
    repository: { full_name: "teamleaderleo/stensibly" },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: "2".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    size: 2,
    head_commit: { timestamp: "2026-07-30T17:59:00.000Z" },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const observation = mapGitHubRepositoryWebhook({
    eventType: "push",
    deliveryId: "delivery-push",
    payloadDigest: digestGitHubWebhookPayload(body),
    payload,
    signatureVerified: true,
    receivedAt: "2026-07-30T18:00:00.000Z",
    expectedRepository: "teamleaderleo/stensibly",
  })!;

  expect(observation.semanticFingerprint).toBe(
    "sha256:cd9cc50b186a137108fda4786d6b70df490a044306f94769a1aa03b8b728227e",
  );
});
