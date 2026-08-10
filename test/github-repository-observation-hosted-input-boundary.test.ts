import { describe, expect, test } from "bun:test";
import {
  admitHostedGitHubRepositoryObservationInput,
} from "../src/github-repository-observation-admission.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";

const repository = "teamleaderleo/stensibly";
const receivedAt = "2026-08-08T00:00:00.000Z";

function hostedInput() {
  const payload = {
    repository: { full_name: repository },
    sender: { login: "github-actions[bot]" },
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: "2".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    size: 1,
    head_commit: { timestamp: receivedAt },
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const payloadDigest = digestGitHubWebhookPayload(body);
  const observation = mapGitHubRepositoryWebhook({
    eventType: "push",
    deliveryId: "delivery-hosted-input-boundary",
    payloadDigest,
    payload,
    signatureVerified: true,
    receivedAt,
    expectedRepository: repository,
  });
  if (!observation) throw new Error("fixture did not produce an observation");
  return {
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    payloadDigest: observation.payloadDigest,
    receivedAt: observation.receivedAt,
    observation,
  };
}

describe("hosted repository observation closed-input admission", () => {
  test("reads only declared data descriptors and ignores caller decorations", () => {
    const value = Object.assign(hostedInput(), {
      ignoredDecoration: "must never be retained",
    });
    let getCalls = 0;
    let ownKeysCalls = 0;
    const hostile = new Proxy(value, {
      get() {
        getCalls += 1;
        throw new Error("caller get must remain unreachable");
      },
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    const admitted = admitHostedGitHubRepositoryObservationInput(hostile);
    expect(admitted.deliveryId).toBe("delivery-hosted-input-boundary");
    expect(admitted.repository).toBe(repository);
    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  test("normalizes a revoked hosted input before generic JSON traversal", () => {
    const revoked = Proxy.revocable(hostedInput(), {});
    revoked.revoke();
    expect(() => admitHostedGitHubRepositoryObservationInput(revoked.proxy))
      .toThrow("GitHub repository observation input could not be inspected");
  });
});
