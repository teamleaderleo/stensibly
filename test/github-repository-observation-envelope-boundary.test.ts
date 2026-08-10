import { describe, expect, test } from "bun:test";
import {
  admitGitHubRepositoryObservationEnvelope,
} from "../src/github-repository-observation-admission.ts";
import {
  digestGitHubWebhookPayload,
  mapGitHubRepositoryWebhook,
} from "../src/github-repository-observation.ts";
import { canonicalJsonString } from "../src/idempotency-request-fingerprint.ts";

const repository = "teamleaderleo/stensibly";
const receivedAt = "2026-08-08T00:00:00.000Z";

function envelope() {
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
    deliveryId: "delivery-envelope-boundary",
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
    observationJson: canonicalJsonString(observation),
    payloadDigest: observation.payloadDigest,
    receivedAt: Date.parse(observation.receivedAt),
  };
}

describe("repository observation closed-envelope admission", () => {
  test("reads only declared data descriptors and ignores caller decorations", () => {
    const value = Object.assign(envelope(), {
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

    const admitted = admitGitHubRepositoryObservationEnvelope(hostile);
    expect(admitted.deliveryId).toBe("delivery-envelope-boundary");
    expect(admitted.repository).toBe(repository);
    expect(JSON.stringify(admitted)).not.toContain("ignoredDecoration");
    expect(getCalls).toBe(0);
    expect(ownKeysCalls).toBe(0);
  });

  test("normalizes a revoked envelope to one fixed inspection failure", () => {
    const revoked = Proxy.revocable(envelope(), {});
    revoked.revoke();
    expect(() => admitGitHubRepositoryObservationEnvelope(revoked.proxy))
      .toThrow("GitHub repository observation envelope could not be inspected");
  });
});
