import { describe, expect, test } from "bun:test";
import {
  InMemoryOrchestratorActivityIngestionStore,
} from "../src/orchestrator-activity-ingestion.ts";
import type {
  OrchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation.ts";

const deliveryFingerprint = `sha256:${"c".repeat(64)}`;
const sourceFingerprint = `sha256:${"d".repeat(64)}`;

function observation(
  overrides: Partial<OrchestratorActivityObservationInput> = {},
): OrchestratorActivityObservationInput {
  return {
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cedar",
    sourceClass: "provider_receipt",
    sourceId: "ghop_1149_1",
    sourceFingerprint,
    observedAt: "2026-08-05T16:20:00.000Z",
    activityClass: "provider_effect",
    activityState: "succeeded",
    workItemId: "issue:1149",
    attemptId: "attempt_1",
    provider: "github",
    providerLifecycle: "verified",
    ...overrides,
  };
}

function delivery(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    deliveryId: "delivery_1149_1",
    deliveryFingerprint,
    acceptedAt: "2026-08-05T16:20:01.000Z",
    observation: observation(),
    ...overrides,
  };
}

describe("orchestrator activity ingestion reference", () => {
  test("appends one observation and returns an immutable receipt", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const result = store.ingest(delivery());

    expect(result).toMatchObject({
      replayed: false,
      observationAppended: true,
      receipt: {
        schemaVersion: 1,
        deliveryId: "delivery_1149_1",
        deliveryFingerprint,
        observationId: result.observation.observationId,
        observationFingerprint: result.observation.observationFingerprint,
        sourceClass: "provider_receipt",
        sourceId: "ghop_1149_1",
        acceptedAt: "2026-08-05T16:20:01.000Z",
      },
    });
    expect(result.receipt.receiptId).toMatch(/^oair_[a-f0-9]{32}$/);
    expect(result.receipt.requestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(store.deliveryCount).toBe(1);
    expect(store.observationCount).toBe(1);
    expect(store.listObservations()).toEqual([result.observation]);
    expect(store.getReceipt("delivery_1149_1")).toBe(result.receipt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  test("replays the original result for the same delivery identity", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const first = store.ingest(delivery());
    const replay = store.ingest(delivery({
      acceptedAt: "2026-08-05T16:25:00.000Z",
    }));

    expect(replay.replayed).toBe(true);
    expect(replay.observationAppended).toBe(false);
    expect(replay.receipt).toBe(first.receipt);
    expect(replay.observation).toBe(first.observation);
    expect(replay.receipt.acceptedAt).toBe("2026-08-05T16:20:01.000Z");
    expect(store.deliveryCount).toBe(1);
    expect(store.observationCount).toBe(1);
  });

  test("rejects changed reuse of one delivery identity", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    store.ingest(delivery());

    expect(() => store.ingest(delivery({
      deliveryFingerprint: `sha256:${"e".repeat(64)}`,
    }))).toThrow("delivery identity conflict");
    expect(() => store.ingest(delivery({
      observation: observation({
        activityState: "failed",
        providerLifecycle: "rejected",
      }),
    }))).toThrow("delivery identity conflict");
    expect(store.deliveryCount).toBe(1);
    expect(store.observationCount).toBe(1);
  });

  test("rejects a changed observation under the same durable source identity", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    store.ingest(delivery());

    expect(() => store.ingest(delivery({
      deliveryId: "delivery_1149_2",
      observation: observation({
        activityClass: "reconciliation_required",
        activityState: "ambiguous",
        providerLifecycle: "pending_reconciliation",
        attentionLevel: "review",
        attentionReasonCode: "provider_outcome_ambiguous",
        nextAction: "reconcile_exact_operation",
      }),
    }))).toThrow("source identity conflict");
    expect(store.deliveryCount).toBe(1);
    expect(store.observationCount).toBe(1);
  });

  test("deduplicates the same observation delivered under a new delivery ID", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const first = store.ingest(delivery());
    const second = store.ingest(delivery({
      deliveryId: "delivery_1149_2",
      deliveryFingerprint: `sha256:${"f".repeat(64)}`,
      acceptedAt: "2026-08-05T16:21:00.000Z",
    }));

    expect(second.replayed).toBe(false);
    expect(second.observationAppended).toBe(false);
    expect(second.observation).toBe(first.observation);
    expect(second.receipt).not.toBe(first.receipt);
    expect(store.deliveryCount).toBe(2);
    expect(store.observationCount).toBe(1);
  });

  test("appends independent source observations", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    store.ingest(delivery());
    const second = store.ingest(delivery({
      deliveryId: "delivery_1149_2",
      deliveryFingerprint: `sha256:${"1".repeat(64)}`,
      observation: observation({
        sourceId: "ghop_1149_2",
        sourceFingerprint: `sha256:${"2".repeat(64)}`,
      }),
    }));

    expect(second.observationAppended).toBe(true);
    expect(store.deliveryCount).toBe(2);
    expect(store.observationCount).toBe(2);
  });

  test("requires accepted time at or after observed time", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    expect(() => store.ingest(delivery({
      acceptedAt: "2026-08-05T16:19:59.000Z",
    }))).toThrow("cannot precede observed time");
    expect(store.deliveryCount).toBe(0);
    expect(store.observationCount).toBe(0);
  });

  test("rejects hostile ingestion envelopes without invoking accessors", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    let getterCalls = 0;
    const input = delivery();
    Object.defineProperty(input, "deliveryId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "delivery_substituted";
      },
    });

    expect(() => store.ingest(input))
      .toThrow("field deliveryId must be an enumerable data property");
    expect(getterCalls).toBe(0);
    expect(store.deliveryCount).toBe(0);
  });

  test("snapshots the ingestion envelope through one own-key read", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    let ownKeysCalls = 0;
    const input = new Proxy(delivery(), {
      ownKeys(target) {
        ownKeysCalls += 1;
        if (ownKeysCalls > 1) {
          throw new Error("caller keys were enumerated twice");
        }
        return Reflect.ownKeys(target);
      },
    });

    const result = store.ingest(input);
    expect(result.receipt.deliveryId).toBe("delivery_1149_1");
    expect(ownKeysCalls).toBe(1);
  });

  test("uses the shared retained-credential policy for delivery identities", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    for (const deliveryId of [
      `delivery_stn.svc_${"a".repeat(12)}`,
      "delivery_secret://github/app-private-key",
      "delivery_env://GITHUB_TOKEN",
      `delivery_eyJ${"a".repeat(8)}.eyJ${"b".repeat(8)}.${"c".repeat(8)}`,
      "delivery_authorization:token",
    ]) {
      expect(() => store.ingest(delivery({ deliveryId })))
        .toThrow("delivery ID cannot contain credential material");
    }

    const benign = `delivery_sk-proj-${"a".repeat(12)}`;
    expect(store.ingest(delivery({ deliveryId: benign })).receipt.deliveryId)
      .toBe(benign);
    expect(() => store.ingest(delivery({
      deliveryId: "delivery_1149_2",
      deliveryFingerprint: `sha256:${"A".repeat(64)}`,
    }))).toThrow("exact SHA-256 fingerprint");
  });

  test("returns frozen snapshots that cannot mutate store state", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const first = store.ingest(delivery());
    const snapshot = store.listObservations();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as OrchestratorActivityObservationInput[]).push(
      observation({ sourceId: "other" }),
    )).toThrow();
    expect(store.listObservations()).toEqual([first.observation]);
  });
});
