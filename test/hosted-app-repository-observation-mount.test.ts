import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ConvexWorkLedger } from "../src/convex-ledger.ts";
import {
  createHostedApp,
  hostedProviderCapacityFromEnv,
} from "../src/hosted-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import type { ApiTokenAuthenticator } from "../src/token-provider.ts";

const webhookSecret = "hosted-observation-mount-secret";
const before = "1".repeat(40);
const after = "2".repeat(40);

class AnonymousAuthenticator implements ApiTokenAuthenticator {
  async authenticate() {
    return null;
  }
}

describe("hosted repository observation sink mount", () => {
  test("stays absent without the shared GitHub webhook secret", () => {
    const ledger = fakeConvexLedger([]);
    expect(hostedProviderCapacityFromEnv(ledger, {})).toBeUndefined();
  });

  test("routes one signed repository event into the mounted Convex sink", async () => {
    const mutationArgs: Record<string, unknown>[] = [];
    const options = hostedProviderCapacityFromEnv(
      fakeConvexLedger(mutationArgs),
      { STENSIBLY_GITHUB_WEBHOOK_SECRET: webhookSecret },
    );
    if (!options) throw new Error("Expected hosted provider options");

    const store = new StensiblyStore(":memory:");
    const app = createHostedApp({
      ledger: new SqliteWorkLedger(store),
      authenticator: new AnonymousAuthenticator(),
      providerCapacity: {
        ...options,
        now: () => Date.parse("2026-07-31T16:55:01.000Z"),
      },
    });
    const body = JSON.stringify({
      repository: { full_name: "teamleaderleo/stensibly" },
      sender: { login: "github-actions[bot]" },
      ref: "refs/heads/main",
      before,
      after,
      size: 1,
      head_commit: {
        timestamp: "2026-07-31T16:55:00.000Z",
        message: "private release prose must stay outside the observation ledger",
      },
    });

    try {
      const response = await app.request("/webhooks/github", {
        method: "POST",
        headers: signedHeaders(body),
        body,
      });
      const responseBody = await response.json();

      expect(response.status).toBe(202);
      expect(responseBody).toEqual({
        accepted: true,
        duplicate: false,
        repositoryObservation: {
          accepted: true,
          duplicate: false,
        },
      });
      expect(mutationArgs).toHaveLength(1);
      expect(mutationArgs[0]).toMatchObject({
        serviceSecret: "private-service-secret",
        workspace: "chronicle-workspace",
        deliveryId: "delivery-hosted-mount",
        eventType: "push",
        receivedAt: Date.parse("2026-07-31T16:55:01.000Z"),
      });
      const observationJson = String(mutationArgs[0]?.observationJson ?? "");
      expect(observationJson).toContain("teamleaderleo/stensibly");
      expect(observationJson).toContain(after);
      expect(observationJson).not.toContain("private release prose");
      expect(JSON.stringify(responseBody)).not.toContain(body);
    } finally {
      store.close();
    }
  });
});

function fakeConvexLedger(
  mutationArgs: Record<string, unknown>[],
): ConvexWorkLedger {
  return {
    client: {
      async mutation(_reference, args) {
        mutationArgs.push(args);
        return {
          duplicate: false,
          record: storedRecord(String(args.observationJson)),
        };
      },
      async query() {
        throw new Error("query is outside this mount proof");
      },
    },
    serviceSecret: "private-service-secret",
    workspace: "chronicle-workspace",
  } as unknown as ConvexWorkLedger;
}

function storedRecord(observationJson: string) {
  const observation = JSON.parse(observationJson) as Record<string, any>;
  return {
    id: "observation-row-hosted-mount",
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
    observationJson,
    createdAt: Date.parse("2026-07-31T16:55:02.000Z"),
  };
}

function signedHeaders(body: string) {
  return {
    "content-type": "application/json",
    "x-github-delivery": "delivery-hosted-mount",
    "x-github-event": "push",
    "x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex")}`,
  };
}
