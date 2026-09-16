import { describe, expect, test } from "bun:test";
import {
  compileOrchestratorAttentionProjection,
} from "../src/orchestrator-attention-thread.ts";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
} from "../src/orchestrator-activity-observation.ts";

function support(index: number, variant = "base"): OrchestratorActivityObservation {
  const suffix = String(index).padStart(2, "0");
  const fingerprintByte = variant === "base"
    ? (index % 10).toString(16)
    : "f";
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cinder",
    sourceClass: index === 0 ? "provider_receipt" : "provider_observation",
    sourceId: `provider_evidence_${suffix}_${variant}`,
    sourceFingerprint: `sha256:${fingerprintByte.repeat(64)}`,
    observedAt: `2026-08-07T00:10:${suffix}.000Z`,
    activityClass: "reconciliation_required",
    activityState: "ambiguous",
    workItemId: "issue:1153",
    attemptId: "attempt_dense_evidence",
    runId: "run_dense_evidence",
    responsibilityGeneration: 1,
    provider: "github",
    providerLifecycle: "pending_reconciliation",
    attentionLevel: "review",
    attentionReasonCode: "provider_outcome_ambiguous",
    nextAction: "reconcile_exact_operation",
  });
}

describe("orchestrator attention complete evidence fingerprinting", () => {
  test("middle evidence changes the thread fingerprint after retained IDs compact", () => {
    const firstHistory = Array.from({ length: 40 }, (_, index) => support(index));
    const secondHistory = [...firstHistory];
    secondHistory[20] = support(20, "changed");

    const first = compileOrchestratorAttentionProjection(firstHistory);
    const second = compileOrchestratorAttentionProjection(secondHistory);
    const firstThread = first.threads[0]!;
    const secondThread = second.threads[0]!;

    expect(firstThread.evidenceCount).toBe(40);
    expect(secondThread.evidenceCount).toBe(40);
    expect(firstThread.supportingObservationIds).toHaveLength(32);
    expect(secondThread.supportingObservationIds).toHaveLength(32);
    expect(firstThread.supportingObservationIds)
      .toEqual(secondThread.supportingObservationIds);

    // The retained first/last IDs and count are intentionally identical. The
    // complete evidence set still changed, so the canonical thread identity
    // must change as well.
    expect(firstThread.threadFingerprint)
      .not.toBe(secondThread.threadFingerprint);
    expect(firstThread.threadId).not.toBe(secondThread.threadId);
    expect(first.projectionFingerprint).not.toBe(second.projectionFingerprint);
  });
});
