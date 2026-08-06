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
    actorId: "actor_cinder",
    sourceClass: "provider_receipt",
    sourceId: "provider_receipt_1153_1",
    sourceFingerprint: fingerprintA,
    observedAt: "2026-08-07T00:00:00.000Z",
    activityClass: "reconciliation_required",
    activityState: "ambiguous",
    workItemId: "issue:1153",
    attemptId: "attempt_1",
    runId: "run_1",
    responsibilityGeneration: 1,
    provider: "github",
    providerLifecycle: "pending_reconciliation",
    attentionLevel: "review",
    attentionReasonCode: "provider_outcome_ambiguous",
    nextAction: "reconcile_exact_operation",
    ...overrides,
  });
}

function ambiguousObservation(
  overrides: Partial<OrchestratorActivityObservationInput> = {},
): OrchestratorActivityObservation {
  return ambiguousReceipt({
    sourceClass: "provider_observation",
    sourceId: "provider_observation_1153_1",
    sourceFingerprint: fingerprintB,
    observedAt: "2026-08-07T00:00:01.000Z",
    ...overrides,
  });
}

function resolver(
  predecessor: string,
  overrides: Partial<OrchestratorActivityObservationInput> = {},
): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cinder",
    sourceClass: "provider_observation",
    sourceId: "provider_observation_1153_resolved",
    sourceFingerprint: fingerprintC,
    observedAt: "2026-08-07T00:00:02.000Z",
    activityClass: "verification",
    activityState: "succeeded",
    workItemId: "issue:1153",
    attemptId: "attempt_1",
    runId: "run_1",
    responsibilityGeneration: 1,
    causalPredecessorId: predecessor,
    provider: "github",
    providerLifecycle: "verified",
    ...overrides,
  });
}

function genericSuccess(
  overrides: Partial<OrchestratorActivityObservationInput> = {},
): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cinder",
    sourceClass: "provider_observation",
    sourceId: "provider_observation_1153_generic_success",
    sourceFingerprint: fingerprintD,
    observedAt: "2026-08-07T00:00:03.000Z",
    activityClass: "verification",
    activityState: "succeeded",
    workItemId: "issue:1153",
    attemptId: "attempt_1",
    runId: "run_1",
    responsibilityGeneration: 1,
    provider: "github",
    providerLifecycle: "verified",
    ...overrides,
  });
}

function routineProgress(): OrchestratorActivityObservation {
  return compileOrchestratorActivityObservation({
    workspace: "default",
    project: "stensibly",
    actorId: "actor_cinder",
    sourceClass: "ledger_event",
    sourceId: "ledger_event_1153_progress",
    sourceFingerprint: `sha256:${"e".repeat(64)}`,
    observedAt: "2026-08-07T00:00:00.500Z",
    activityClass: "progress_evidence",
    activityState: "observed",
    workItemId: "issue:1153",
    attemptId: "attempt_1",
    runId: "run_1",
    responsibilityGeneration: 1,
  });
}

describe("orchestrator causal attention projection", () => {
  test("keeps routine progress out of the attention inbox", () => {
    const projection = compileOrchestratorAttentionProjection([
      routineProgress(),
    ]);

    expect(projection.observationCount).toBe(1);
    expect(projection.threadCount).toBe(0);
    expect(projection.threads).toEqual([]);
    expect(projection.grantsAuthority).toBe(false);
  });

  test("opens incomplete provider attention when required coverage is missing", () => {
    const receipt = ambiguousReceipt();
    const projection = compileOrchestratorAttentionProjection([receipt]);

    expect(projection.threadCount).toBe(1);
    expect(projection.threads[0]).toMatchObject({
      workspace: "default",
      project: "stensibly",
      workItemId: "issue:1153",
      attemptId: "attempt_1",
      runId: "run_1",
      responsibilityGeneration: 1,
      provider: "github",
      attentionClass: "review",
      state: "incomplete",
      reasonCode: "provider_outcome_ambiguous",
      nextAction: "reconcile_exact_operation",
      evidenceCount: 1,
      supportingObservationIds: [receipt.observationId],
      contradictionCount: 0,
      contradictingObservationIds: [],
      sourceClasses: ["provider_receipt"],
      coverage: {
        state: "partial",
        missingSourceClasses: ["provider_observation"],
      },
      resolutionCondition: "exact_provider_reconciliation",
      grantsAuthority: false,
    });
    expect(projection.threads[0]!.threadId).toMatch(/^oat_[a-f0-9]{32}$/u);
    expect(projection.threads[0]!.threadFingerprint)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  test("opens complete attention after independent provider observation arrives", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const projection = compileOrchestratorAttentionProjection([
      observed,
      routineProgress(),
      receipt,
    ]);

    expect(projection.threadCount).toBe(1);
    expect(projection.threads[0]).toMatchObject({
      state: "open",
      evidenceCount: 2,
      sourceClasses: ["provider_observation", "provider_receipt"],
      coverage: {
        state: "complete",
        missingSourceClasses: [],
      },
    });
    expect(projection.threads[0]!.supportingObservationIds).toEqual([
      receipt.observationId,
      observed.observationId,
    ]);
  });

  test("resolves only through a fresh exact causal reconciliation", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const reconciled = resolver(observed.observationId);
    const projection = compileOrchestratorAttentionProjection([
      receipt,
      reconciled,
      observed,
    ]);

    expect(projection.threads[0]).toMatchObject({
      state: "resolved",
      openedAt: receipt.observedAt,
      updatedAt: reconciled.observedAt,
      resolvedAt: reconciled.observedAt,
      contradictionCount: 0,
      coverage: { state: "complete" },
    });
  });

  test("an older ambiguity reconciliation cannot resolve a newer ambiguity", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const staleReconciliation = resolver(receipt.observationId, {
      sourceId: "provider_observation_1153_stale_reconciliation",
      sourceFingerprint: `sha256:${"1".repeat(64)}`,
      observedAt: "2026-08-07T00:00:04.000Z",
    });
    const projection = compileOrchestratorAttentionProjection([
      receipt,
      observed,
      staleReconciliation,
    ]);

    expect(projection.threads[0]).toMatchObject({
      state: "contradictory",
      resolvedAt: null,
      contradictionCount: 1,
      contradictingObservationIds: [staleReconciliation.observationId],
    });
  });

  test("does not let generic success overwrite contradictory evidence", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const reconciled = resolver(observed.observationId);
    const optimistic = genericSuccess();
    const projection = compileOrchestratorAttentionProjection([
      receipt,
      optimistic,
      observed,
      reconciled,
    ]);

    expect(projection.threads[0]).toMatchObject({
      state: "contradictory",
      resolvedAt: null,
      contradictionCount: 1,
      contradictingObservationIds: [optimistic.observationId],
    });
  });

  test("is invariant to input order and exact duplicate delivery", () => {
    const receipt = ambiguousReceipt();
    const observed = ambiguousObservation();
    const first = compileOrchestratorAttentionProjection([
      receipt,
      observed,
      receipt,
    ]);
    const second = compileOrchestratorAttentionProjection([
      observed,
      receipt,
    ]);

    expect(first).toEqual(second);
    expect(first.observationCount).toBe(2);
    expect(first.projectionFingerprint).toBe(second.projectionFingerprint);
  });

  test("rejects changed bytes retained under one observation identity", () => {
    const receipt = ambiguousReceipt();
    const substituted = {
      ...receipt,
      actorId: "actor_substituted",
    };

    expect(() => compileOrchestratorAttentionProjection([substituted]))
      .toThrow("observation identity changed");
  });

  test("keeps responsibility generations as distinct attention subjects", () => {
    const first = ambiguousReceipt();
    const second = ambiguousReceipt({
      sourceId: "provider_receipt_1153_generation_2",
      sourceFingerprint: `sha256:${"f".repeat(64)}`,
      observedAt: "2026-08-07T00:00:04.000Z",
      responsibilityGeneration: 2,
    });
    const projection = compileOrchestratorAttentionProjection([first, second]);

    expect(projection.threadCount).toBe(2);
    expect(
      projection.threads
        .map((thread) => thread.responsibilityGeneration)
        .sort((left, right) => (left ?? 0) - (right ?? 0)),
    ).toEqual([1, 2]);
  });

  test("rejects hostile observation accessors without invoking them", () => {
    let getterCalls = 0;
    const hostile = { ...ambiguousReceipt() } as Record<string, unknown>;
    Object.defineProperty(hostile, "actorId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "actor_substituted";
      },
    });

    expect(() => compileOrchestratorAttentionProjection([hostile]))
      .toThrow("fields must be enumerable data properties");
    expect(getterCalls).toBe(0);
  });

  test("rejects oversized input before caller key enumeration", () => {
    let ownKeysCalls = 0;
    const oversized = new Proxy(
      Array.from({ length: 257 }, () => routineProgress()),
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(() => compileOrchestratorAttentionProjection(oversized))
      .toThrow("accepts at most 256 observations");
    expect(ownKeysCalls).toBe(0);
  });

  test("rejects decorated arrays and custom observation prototypes", () => {
    const decorated = [ambiguousReceipt()] as OrchestratorActivityObservation[] & {
      note?: string;
    };
    decorated.note = "must not survive";
    expect(() => compileOrchestratorAttentionProjection(decorated))
      .toThrow("dense and undecorated");

    const custom = Object.assign(
      Object.create({ inherited: true }),
      ambiguousReceipt(),
    );
    expect(() => compileOrchestratorAttentionProjection([custom]))
      .toThrow("plain or null prototype");
  });

  test("deeply freezes projection, threads, coverage, and evidence arrays", () => {
    const projection = compileOrchestratorAttentionProjection([
      ambiguousReceipt(),
    ]);
    const thread = projection.threads[0]!;

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.threads)).toBe(true);
    expect(Object.isFrozen(thread)).toBe(true);
    expect(Object.isFrozen(thread.coverage)).toBe(true);
    expect(Object.isFrozen(thread.coverage.missingSourceClasses)).toBe(true);
    expect(Object.isFrozen(thread.supportingObservationIds)).toBe(true);
    expect(Object.isFrozen(thread.contradictingObservationIds)).toBe(true);
  });
});
