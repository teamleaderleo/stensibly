import { describe, expect, test } from "bun:test";
import {
  ConvexGitHubRepositoryObservationService,
  GitHubRepositoryObservationStorageError,
} from "../src/github-repository-observation-convex.ts";
import { mapGitHubRepositoryWebhook } from "../src/github-repository-observation.ts";

function observationInput() {
  const observation = mapGitHubRepositoryWebhook({
    eventType: "push",
    deliveryId: "delivery-backend-error-boundary",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    signatureVerified: true,
    receivedAt: "2026-08-08T00:00:00.000Z",
    expectedRepository: "teamleaderleo/stensibly",
    payload: {
      repository: { full_name: "teamleaderleo/stensibly" },
      sender: { login: "github-actions[bot]" },
      ref: "refs/heads/main",
      before: "1".repeat(40),
      after: "2".repeat(40),
      created: false,
      deleted: false,
      forced: false,
      size: 1,
      head_commit: { timestamp: "2026-08-08T00:00:00.000Z" },
    },
  });
  if (!observation) throw new Error("Expected push observation");
  return {
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    payloadDigest: observation.payloadDigest,
    receivedAt: observation.receivedAt,
    observation,
  };
}

async function expectFixedStorageError(error: unknown): Promise<void> {
  const service = new ConvexGitHubRepositoryObservationService({
    client: {
      async mutation() { throw error; },
      async query() { throw new Error("not used"); },
    },
    serviceSecret: "service-secret",
  });

  let caught: unknown;
  try {
    await service.ingestRepositoryObservation(observationInput());
  } catch (failure) {
    caught = failure;
  }

  expect(caught).toBeInstanceOf(GitHubRepositoryObservationStorageError);
  expect((caught as Error).message).toBe(
    "GitHub repository observation storage failed",
  );
  expect(JSON.stringify(caught)).not.toContain("backend hostile prose");
}

describe("repository observation Convex backend error admission", () => {
  test("normalizes hostile prototype inspection during error classification", async () => {
    const hostile = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        throw new Error("backend hostile prose from getPrototypeOf");
      },
    });
    await expectFixedStorageError(hostile);
  });

  test("normalizes hostile message-descriptor inspection", async () => {
    const hostile = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        return null;
      },
      getOwnPropertyDescriptor() {
        throw new Error("backend hostile prose from descriptor");
      },
    });
    await expectFixedStorageError(hostile);
  });
});
