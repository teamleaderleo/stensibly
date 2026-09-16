import { describe, expect, test } from "bun:test";
import {
  compileOrchestratorAttentionProjection,
} from "../src/orchestrator-attention-thread.ts";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
  type OrchestratorActivityObservationInput,
} from "../src/orchestrator-activity-observation.ts";

const fingerprintA = `sha256:${"a".repeat(64)}`;
const fingerprintB = `sha256:${"b".repeat(64)}`;
const fingerprintC = `sha256:${"c".repeat(64)}`;
const fingerprintD = `sha256:${"d".repeat(64)}`;

function ambiguousReceipt(
  overrides: Partial<OrchestratorActivityObservationInput> = {},
): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_lumen",
    sourceClass: "provider_receipt",
    sourceId: "provider_receipt_1171_semantic_red",
    sourceFingerprint: fingerprintA,
    observedAt: "2026-08-07T00:00:00.000Z",
    activityClass: "reconciliation_required",
    activityState: "ambiguous",
    workItemId: "issue:1153",
    attemptId: "attempt_semantic_red",
    runId: "run_semantic_red",
    responsibilityGeneration: 1,
    provider: "github",
    providerLifecycle: "pending_reconciliation",
    attentionLevel: "review",
    attentionReasonCode: "provider_outcome_ambiguous",
    nextAction: "reconcile_exact_operation",
    ...overrides,
  });
}

function ambiguousObservation(): OrchestratorActivityObservation {
  return ambiguousReceipt({
    sourceClass: "provider_observation",
    sourceId: "provider_observation_1171_semantic_red",
    sourceFingerprint: fingerprintB,
    observedAt: "2026-08-07T00:00:01.000Z",
  });
}

function verifiedEvidence(
  predecessor: string | null,
  overrides: Partial<OrchestratorActivityObservationInput> = {},
): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_lumen",
    sourceClass: "provider_observation",
    sourceId: "provider_observation_1171_verified",
    sourceFingerprint: fingerprintC,
    observedAt: "2026-08-07T00:00:03.000Z",
    activityClass: "verification",
    activityState: "succeeded",
    workItemId: "issue:1153",
    attemptId: "attempt_semantic_red",
    runId: "run_semantic_red",
    responsibilityGeneration: 1,
    ...(predecessor === null ? {} : { causalPredecessorId: predecessor }),
    provider: "github",
    providerLifecycle: "verified",
    ...overrides,
  });
}

describe("orchestrator causal-attention semantic red controls", () => {
  test("does not accept a provider receipt as the exact reconciliation observation", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const receiptImpersonator = verifiedEvidence(observed.observationId, {
      sourceClass: "provider_receipt",
      sourceId: "provider_receipt_1171_fake_resolver",
      sourceFingerprint: fingerprintD,
      observedAt: "2026-08-07T00:00:02.000Z",
    });

    const projection = compileOrchestratorAttentionProjection([
      receipt,
      observed,
      receiptImpersonator,
    ]);
    const thread = projection.threads[0]!;

    expect(thread.state).not.toBe("resolved");
    expect(thread.resolvedAt).toBeNull();
  });

  test("lets a later exact provider observation settle an older contradiction", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const contradictorySuccess = verifiedEvidence(null, {
      sourceId: "provider_observation_1171_contradiction",
      sourceFingerprint: fingerprintD,
      observedAt: "2026-08-07T00:00:02.000Z",
    });
    const reconciled = verifiedEvidence(observed.observationId, {
      sourceId: "provider_observation_1171_exact_reconciliation",
      sourceFingerprint: `sha256:${"e".repeat(64)}`,
      observedAt: "2026-08-07T00:00:04.000Z",
    });

    const projection = compileOrchestratorAttentionProjection([
      receipt,
      observed,
      contradictorySuccess,
      reconciled,
    ]);
    const thread = projection.threads[0]!;

    expect(thread.state).toBe("resolved");
    expect(thread.resolvedAt).toBe(reconciled.observedAt);
    expect(thread.contradictionCount).toBeGreaterThanOrEqual(1);
    expect(thread.contradictingObservationIds).toContain(
      contradictorySuccess.observationId,
    );
  });
});
