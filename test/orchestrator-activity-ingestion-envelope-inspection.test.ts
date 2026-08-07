import { describe, expect, test } from "bun:test";
import {
  InMemoryOrchestratorActivityIngestionStore,
} from "../src/orchestrator-activity-ingestion.ts";
import type {
  OrchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation.ts";

const deliveryFingerprint = `sha256:${"c".repeat(64)}`;
const sourceFingerprint = `sha256:${"d".repeat(64)}`;

function observation(): OrchestratorActivityObservationInput {
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
  };
}

function delivery(): Record<string | symbol, unknown> {
  return {
    deliveryId: "delivery_1149_1",
    deliveryFingerprint,
    acceptedAt: "2026-08-05T16:20:01.000Z",
    observation: observation(),
  };
}

describe("orchestrator activity ingestion envelope inspection", () => {
  test("admits the closed envelope without invoking caller ownKeys", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    let ownKeysCalls = 0;
    const input = new Proxy(delivery(), {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("caller ownKeys must remain unreachable");
      },
    });

    const result = store.ingest(input);

    expect(result.receipt.deliveryId).toBe("delivery_1149_1");
    expect(ownKeysCalls).toBe(0);
    expect(store.deliveryCount).toBe(1);
    expect(store.observationCount).toBe(1);
  });

  test("discards unrelated string and symbol decorations", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const decorated = delivery();
    decorated.unrelated = "discarded";
    decorated[Symbol("private-decoration")] = "discarded";

    const result = store.ingest(decorated);

    expect(result.receipt.deliveryId).toBe("delivery_1149_1");
    expect(JSON.stringify(result)).not.toContain("discarded");
    expect(store.deliveryCount).toBe(1);
    expect(store.observationCount).toBe(1);
  });

  test("rejects admitted-field accessors without getter execution or mutation", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const input = delivery();
    let getterCalls = 0;
    Object.defineProperty(input, "deliveryId", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return "delivery_substituted";
      },
    });

    expect(() => store.ingest(input)).toThrow(
      "Orchestrator activity ingestion field deliveryId must be an enumerable data property",
    );
    expect(getterCalls).toBe(0);
    expect(store.deliveryCount).toBe(0);
    expect(store.observationCount).toBe(0);
  });

  test("normalizes hostile descriptor inspection failures", () => {
    const store = new InMemoryOrchestratorActivityIngestionStore();
    const input = new Proxy(delivery(), {
      getOwnPropertyDescriptor(_target, key) {
        if (key === "deliveryFingerprint") {
          throw new Error("provider-controlled inspection text");
        }
        return Reflect.getOwnPropertyDescriptor(delivery(), key);
      },
    });

    expect(() => store.ingest(input)).toThrow(
      "Orchestrator activity ingestion input could not be inspected",
    );
    expect(store.deliveryCount).toBe(0);
    expect(store.observationCount).toBe(0);
  });
});
