import { describe, expect, test } from "bun:test";
import {
  ConvexGitHubRepositoryObservationService,
} from "../src/github-repository-observation-convex.ts";
import { mapGitHubRepositoryWebhook } from "../src/github-repository-observation.ts";

function issueObservation() {
  const observation = mapGitHubRepositoryWebhook({
    eventType: "issues",
    deliveryId: "delivery-backend-ownkeys",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    signatureVerified: true,
    receivedAt: "2026-08-08T00:00:01.000Z",
    expectedRepository: "teamleaderleo/stensibly",
    payload: {
      action: "edited",
      repository: { full_name: "teamleaderleo/stensibly" },
      sender: { login: "teamleaderleo" },
      issue: {
        number: 777,
        title: "Bound repository observation backend admission",
        body: "private body",
        state: "open",
        state_reason: null,
        locked: false,
        created_at: "2026-08-07T23:59:00.000Z",
        updated_at: "2026-08-08T00:00:00.000Z",
        labels: [],
        assignees: [],
        milestone: null,
      },
    },
  });
  if (!observation) throw new Error("Expected issue observation");
  return observation;
}

function observationInput(observation: ReturnType<typeof issueObservation>) {
  return {
    deliveryId: observation.deliveryId,
    eventType: observation.eventType,
    payloadDigest: observation.payloadDigest,
    receivedAt: observation.receivedAt,
    observation,
  };
}

function storedRecord(observation: ReturnType<typeof issueObservation>) {
  return {
    id: "observation-row-ownkeys",
    observationId: observation.observationId,
    deliveryId: observation.deliveryId,
    payloadDigest: observation.payloadDigest,
    semanticFingerprint: observation.semanticFingerprint,
    eventType: observation.eventType,
    action: observation.action,
    repository: observation.repository,
    actor: observation.actor,
    subjectKind: observation.subject.kind,
    subjectExternalId: observation.subject.externalId,
    sourceTime: Date.parse(observation.sourceTime),
    sourceTimeSource: observation.sourceTimeSource,
    receivedAt: Date.parse(observation.receivedAt),
    observationJson: JSON.stringify(canonical(observation)),
    createdAt: Date.parse("2026-08-08T00:00:02.000Z"),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

describe("repository observation Convex closed backend admission", () => {
  test("does not enumerate mutation-result record keys", async () => {
    const observation = issueObservation();
    let ownKeysCalls = 0;
    const result = new Proxy({
      duplicate: false,
      record: storedRecord(observation),
    }, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("backend result keys must remain unreachable");
      },
    });
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() { return result; },
        async query() { throw new Error("not used"); },
      },
      serviceSecret: "service-secret",
    });

    expect(await service.ingestRepositoryObservation(observationInput(observation)))
      .toEqual({ duplicate: false });
    expect(ownKeysCalls).toBe(0);
  });

  test("bounds query rows from own length and dense descriptors without ownKeys", async () => {
    const observation = issueObservation();
    let ownKeysCalls = 0;
    const rows = new Proxy([storedRecord(observation)], {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("backend row keys must remain unreachable");
      },
    });
    const service = new ConvexGitHubRepositoryObservationService({
      client: {
        async mutation() { throw new Error("not used"); },
        async query() { return rows; },
      },
      serviceSecret: "service-secret",
    });

    const records = await service.listRecentRepositoryObservations(
      "teamleaderleo/stensibly",
      10,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.observation.observationId).toBe(observation.observationId);
    expect(ownKeysCalls).toBe(0);
  });
});
