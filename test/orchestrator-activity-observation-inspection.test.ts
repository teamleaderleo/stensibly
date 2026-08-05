import { describe, expect, test } from "bun:test";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation.ts";

const fingerprint = `sha256:${"b".repeat(64)}`;

function input(): OrchestratorActivityObservationInput {
  return {
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cedar",
    sourceClass: "ledger_event",
    sourceId: "event_1149",
    sourceFingerprint: fingerprint,
    observedAt: "2026-08-05T16:00:00.000Z",
    activityClass: "progress_evidence",
    activityState: "observed",
  };
}

describe("orchestrator activity observation inspection", () => {
  test("rejects a revoked input proxy with one fixed inspection failure", () => {
    const { proxy, revoke } = Proxy.revocable(input(), {});
    revoke();

    expect(() => compileOrchestratorActivityObservation(proxy))
      .toThrow("could not be inspected");
  });

  test("rejects hostile evidence-array metadata without invoking element getters", () => {
    let getterCalls = 0;
    const target = ["receipt_1"];
    Object.defineProperty(target, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "receipt_substituted";
      },
    });
    const relatedEvidenceIds = new Proxy(target, {
      getOwnPropertyDescriptor(value, key) {
        return Reflect.getOwnPropertyDescriptor(value, key);
      },
    });

    expect(() => compileOrchestratorActivityObservation({
      ...input(),
      relatedEvidenceIds,
    })).toThrow("entries must be enumerable data properties");
    expect(getterCalls).toBe(0);
  });

  test("rejects revoked evidence arrays through the fixed list diagnostic", () => {
    const { proxy, revoke } = Proxy.revocable(["receipt_1"], {});
    revoke();

    expect(() => compileOrchestratorActivityObservation({
      ...input(),
      relatedEvidenceIds: proxy,
    })).toThrow("list could not be inspected");
  });

  test("requires provider lifecycle evidence for provider sources and effects", () => {
    for (const candidate of [
      {
        ...input(),
        sourceClass: "provider_receipt" as const,
      },
      {
        ...input(),
        sourceClass: "provider_observation" as const,
      },
      {
        ...input(),
        activityClass: "provider_effect" as const,
        activityState: "succeeded" as const,
      },
    ]) {
      expect(() => compileOrchestratorActivityObservation(candidate))
        .toThrow("requires provider lifecycle evidence");
    }
  });

  test("admits non-provider activity without provider fields", () => {
    const observation = compileOrchestratorActivityObservation(input());
    expect(observation.provider).toBeNull();
    expect(observation.providerLifecycle).toBeNull();
  });

  test("bounds related evidence before entry admission", () => {
    expect(() => compileOrchestratorActivityObservation({
      ...input(),
      relatedEvidenceIds: Array.from(
        { length: 33 },
        (_, index) => `receipt_${index}`,
      ),
    })).toThrow("list is invalid");
  });
});
