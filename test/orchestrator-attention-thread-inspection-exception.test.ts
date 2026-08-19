import { expect, test } from "bun:test";
import { compileOrchestratorAttentionProjection } from "../src/orchestrator-attention-thread.ts";
import { compileOrchestratorActivityObservation } from "../src/orchestrator-activity-observation.ts";

function observation() {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_junco",
    sourceClass: "provider_receipt",
    sourceId: "provider_receipt_1171_hostile_exception",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-08-08T04:00:00.000Z",
    activityClass: "reconciliation_required",
    activityState: "ambiguous",
    workItemId: "issue:1153",
    attemptId: "attempt_hostile_exception",
    runId: "run_hostile_exception",
    responsibilityGeneration: 1,
    provider: "github",
    providerLifecycle: "pending_reconciliation",
    attentionLevel: "review",
    attentionReasonCode: "provider_outcome_ambiguous",
    nextAction: "reconcile_exact_operation",
  });
}

test("normalizes hostile descriptor exceptions without inspecting the thrown value", () => {
  let thrownPrototypeReads = 0;
  const hostileThrownValue = new Proxy(Object.create(null), {
    getPrototypeOf() {
      thrownPrototypeReads += 1;
      throw new Error("thrown value prototype must remain unreachable");
    },
  });
  const hostileObservation = new Proxy({ ...observation() }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "schemaVersion") throw hostileThrownValue;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  expect(() => compileOrchestratorAttentionProjection([hostileObservation]))
    .toThrow("Orchestrator attention observation could not be inspected");
  expect(thrownPrototypeReads).toBe(0);
});
