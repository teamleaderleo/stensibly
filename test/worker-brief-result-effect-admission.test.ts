import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adjudicateCodexCloudPlacementV1,
  codexCloudCanonicalReadEvidenceV1,
  type CodexCloudCanonicalPlacementFactsV1,
  type CodexCloudDispatchReceiptV1,
  type CodexCloudInspectionEvidenceV1,
  type CodexCloudPlacementPreflightInputV1,
} from "../src/codex-root-cloud-placement.js";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.js";
import {
  CODEX_CLOUD_WORKTREE_PROFILE_V1,
  adjudicateWorkerResultApplicationV1,
  adjudicateWorkerResultV1,
  compileWorkerCanonicalDeltaEvidenceV1,
  compileWorkerEffectEvidenceV1,
  compileWorkerProviderDispatchReceiptV1,
  compileWorkerResultContractV1,
  compileWorkerResultRequirementsV1,
  type WorkerResultEffectExpectationInputV1,
  type WorkerResultObservationWithEffectsV1,
  type WorkerResultRequirementsWithEffectsV1,
} from "../src/worker-brief-result-admission.js";
import { compileWorkerBriefV1, type CompileWorkerBriefInputV1 } from "../src/worker-brief.js";
import { compileProjectContract } from "../src/project-contract.js";
import type { ExecutionEnvelope } from "../src/execution-envelope.js";
import type { RunnerAdapterCommandReservationRecord } from "../src/runner-adapter-command-contracts.js";

const repository = "teamleaderleo/stensibly";
const dispatchHead = "a".repeat(40);
const dispatchTree = "b".repeat(40);
const canonicalMain = "c".repeat(40);
const profileVersion = "codex-cloud/2026-08-26";
const sourceRef = "refs/heads/metternich/1616-result-effect-admission";
const mainRef = "refs/heads/main";
const providerTaskId = "task-e-cloud-1616-effects";

const quarryExpectations: readonly WorkerResultEffectExpectationInputV1[] = [
  {
    id: "quarry-800-pull-request-workflow",
    provider: "github",
    disposition: "forbidden",
    statement: "No pull_request workflow run may execute for this bounded result",
    sourceRef: "issue:1616#result-effect-contract",
  },
  {
    id: "quarry-800-live-yahoo-step",
    provider: "github",
    disposition: "forbidden",
    statement: "No live Yahoo provider step may execute for this bounded result",
    sourceRef: "issue:1616#result-effect-contract",
  },
  {
    id: "quarry-800-workflow-artifact",
    provider: "github",
    disposition: "forbidden",
    statement: "No workflow artifact may be produced for this bounded result",
    sourceRef: "issue:1616#result-effect-contract",
  },
];

const envelope: ExecutionEnvelope = {
  schemaVersion: 1,
  objective: "Implement one bounded Cloud checkout task.",
  scopeClass: "atomic",
  estimate: { lowMinutes: 20, likelyMinutes: 45, highMinutes: 90, confidence: 0.8 },
  budget: { expectedMessages: 20, expectedToolCalls: 60, expectedReviewMinutes: 15 },
  boundaries: { softCheckpointMinutes: 30, forcedHandoffMinutes: 60, hardRecoveryMinutes: 120 },
  completion: {
    requiredOutputs: ["exact diff", "focused test receipt"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["provider effect reconciliation passed"],
  },
  durableState: {
    accessClass: "project",
    retentionClass: "standard",
    redactionRequired: false,
    deleteAfter: null,
  },
};

function briefInput(): CompileWorkerBriefInputV1 {
  const markdown = readFileSync(join(import.meta.dir, "..", "STENSIBLY.md"), "utf8");
  return {
    observedAt: "2026-08-26T16:00:00.000Z",
    workspaceId: "default",
    projectId: "stensibly",
    policySnapshot: compileProjectContract(markdown),
    item: {
      id: "issue-1616",
      title: "Compile project-native worker briefs",
      summary: "Reconcile worker result claims with provider-observed effects.",
      nextAction: "Admit only a reconciled result candidate",
      status: "active",
    },
    control: {
      authorityState: "live",
      claimGeneration: 4,
      holderActorId: "worker-cloud-01",
      expiresAt: "2026-08-26T18:00:00.000Z",
    },
    dispatch: {
      runId: "run-cloud-1616-effects-01",
      runGeneration: 1,
      leaseGeneration: 1,
      runnerProfile: "codex-cloud",
      capabilityClass: "standard",
    },
    objectiveOutcome: "Produce one exact bounded candidate and evidence.",
    objectiveNonGoals: [
      "Do not execute live or CI provider effects",
      "Do not infer provider effects from worker prose",
    ],
    startingPoints: ["issue:1616", "quarry#800:run-32878198599"],
    situation: {
      repositoryBaseline: {
        repository,
        baseRevision: dispatchHead,
        candidateRevision: null,
        changeIdentity: null,
      },
      blockers: [],
      overlaps: [],
      providerAvailability: "available",
      supersessionState: "current",
      outstandingDecisions: [],
    },
    contextPlan: {
      canonicalSummary: "Worker claims and provider observations are separate evidence channels.",
      expansionRefs: ["issue:1616"],
      maxEvidenceCharacters: 4_000,
      sourceFreshness: "exact_revision_required",
      contextPack: null,
    },
    executionEnvelope: envelope,
    recipe: null,
    continuation: null,
    wakeRetryCondition: null,
  };
}

function reservation(): RunnerAdapterCommandReservationRecord {
  return {
    project: "stensibly",
    itemId: "issue-1616",
    runId: "run-cloud-1616-effects-01",
    runGeneration: 1,
    leaseGeneration: 1,
    actor: { id: "worker-cloud-01", name: "Cloud worker", kind: "agent" },
    adapterId: "codex-cloud-adapter",
    profileId: "codex-cloud",
    profileVersion,
    requestFingerprint: `sha256:${"1".repeat(64)}`,
    commandId: "command-cloud-1616-effects-01",
    commandFingerprint: `sha256:${"2".repeat(64)}`,
    idempotencyKey: "command-cloud-1616-effects-01",
    reservedAt: "2026-08-26T16:01:00.000Z",
  };
}

function facts(kind: "source" | "main", head?: string): CodexCloudCanonicalPlacementFactsV1 {
  return {
    ownerRef: kind === "source" ? "github:stensibly#1616" : "github:stensibly:main",
    ownerGeneration: 7,
    remoteRef: kind === "source" ? sourceRef : mainRef,
    head: head ?? (kind === "source" ? dispatchHead : canonicalMain),
    settlement: "open",
    experimentFreeze: "open",
  };
}

function inspection(receiptId: string, observedAt: string): CodexCloudInspectionEvidenceV1 {
  const body = {
    version: 1 as const,
    receiptId,
    observedAt,
    isolatedTemporaryCwd: true as const,
    commandExitCode: 0,
    acceptedExitCodes: [0],
    commandExitAccepted: true,
    repositoryDiagnosticPaths: [],
    temporaryDiagnosticPaths: [],
  };
  return { ...body, fingerprint: fingerprintCanonicalRequest(body) };
}

function placement(
  kind: "source" | "main",
  phase: "pre_dispatch" | "pre_result_application" = "pre_dispatch",
  priorDispatch: CodexCloudDispatchReceiptV1 | null = null,
  currentHead?: string,
  resultObservedAt = "2026-08-26T17:02:00.000Z",
): CodexCloudPlacementPreflightInputV1 {
  const suffix = phase === "pre_dispatch" ? "dispatch" : "result";
  const expected = facts(kind);
  return {
    version: 1,
    phase,
    repository,
    missionRef: kind === "source" ? "github:stensibly#1616" : "github:stensibly:main",
    expected,
    canonicalRead: codexCloudCanonicalReadEvidenceV1({
      receiptId: `${kind}-read-${suffix}`,
      observedAt: phase === "pre_dispatch" ? "2026-08-26T16:02:00.000Z" : resultObservedAt,
      facts: facts(kind, currentHead),
    }),
    inspection: inspection(
      `${kind}-inspection-${suffix}`,
      phase === "pre_dispatch"
        ? "2026-08-26T16:02:01.000Z"
        : new Date(Date.parse(resultObservedAt) + 1_000).toISOString(),
    ),
    priorDispatch,
  };
}

function requirements(
  effectExpectations: readonly WorkerResultEffectExpectationInputV1[] = quarryExpectations,
): WorkerResultRequirementsWithEffectsV1 {
  const runnerReservation = reservation();
  const sourcePlacement = placement("source");
  const mainPlacement = placement("main");
  const sourceDispatch = adjudicateCodexCloudPlacementV1(sourcePlacement).dispatchReceipt;
  const mainDispatch = adjudicateCodexCloudPlacementV1(mainPlacement).dispatchReceipt;
  if (sourceDispatch === null || mainDispatch === null) throw new Error("test dispatch receipt missing");
  const brief = compileWorkerBriefV1(briefInput());
  const provenanceObligations = [{
    id: "result-provider-effect-provenance",
    statement: "Provider effect observations come from the owning provider",
    sourceRef: "issue:1616#result-effect-contract",
  }];
  const resultContract = compileWorkerResultContractV1({
    version: 1,
    brief,
    checkoutProfile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree,
    deltaRequirement: "required_nonempty",
    provenanceObligations,
    effectExpectations,
  });
  return compileWorkerResultRequirementsV1({
    version: 1,
    brief,
    runnerReservation,
    placements: { source: sourcePlacement, canonicalMain: mainPlacement },
    checkout: {
      profile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
      dispatchTree,
      providerDispatch: compileWorkerProviderDispatchReceiptV1({
        version: 1,
        providerTaskId,
        dispatchedAt: "2026-08-26T16:03:00.000Z",
        runnerReservationFingerprint: fingerprintCanonicalRequest(runnerReservation),
        sourcePlacementDispatchFingerprint: sourceDispatch.fingerprint,
        canonicalMainPlacementDispatchFingerprint: mainDispatch.fingerprint,
        resultContractFingerprint: resultContract.fingerprint,
      }),
    },
    deltaRequirement: "required_nonempty",
    provenanceObligations,
    effectExpectations,
  }) as WorkerResultRequirementsWithEffectsV1;
}

function observation(
  compiled: WorkerResultRequirementsWithEffectsV1,
  claimedEffectIds: readonly string[] = [],
): WorkerResultObservationWithEffectsV1 {
  return {
    requirementsFingerprint: compiled.fingerprint,
    checkout: {
      head: dispatchHead,
      tree: dispatchTree,
      localBranch: "work",
      originMainHead: null,
      originUrl: null,
    },
    obligations: compiled.obligations.map((obligation) => ({
      id: obligation.id,
      disposition: "satisfied",
      evidenceRefs: [`worker:${obligation.id}`],
    })),
    delta: {
      narrativeDeltaClaimed: true,
      evidenceRefs: ["worker:claimed-bounded-implementation"],
    },
    effects: {
      claimedEffectIds,
      evidenceRefs: [claimedEffectIds.length === 0
        ? "worker:claimed-no-live-ci-effect"
        : "worker:claimed-declared-provider-effect"],
    },
  };
}

function canonicalDelta(compiled: WorkerResultRequirementsWithEffectsV1) {
  return compileWorkerCanonicalDeltaEvidenceV1({
    version: 1,
    requirementsFingerprint: compiled.fingerprint,
    observedAt: "2026-08-26T16:59:00.000Z",
    providerTaskId,
    providerStatus: "READY",
    evidenceAvailability: "exposed",
    changedFileCount: 3,
    changedLineCount: 220,
    diffAvailable: true,
    evidenceRefs: ["provider:task-status-list-diff"],
  });
}

function effectEvidence(
  compiled: WorkerResultRequirementsWithEffectsV1,
  input: {
    observedAt?: string;
    coverage?: "complete" | "incomplete";
    observedEffects?: readonly {
      effectId: string;
      provider: string;
      instanceId: string;
      evidenceRefs: readonly string[];
    }[];
  } = {},
) {
  return compileWorkerEffectEvidenceV1({
    version: 1,
    requirementsFingerprint: compiled.fingerprint,
    observedAt: input.observedAt ?? "2026-08-26T17:01:00.000Z",
    providerTaskId,
    coverage: [{
      provider: "github",
      disposition: input.coverage ?? "complete",
      evidenceRefs: ["github:effect-query:complete"],
    }],
    observedEffects: input.observedEffects ?? [],
  });
}

function applicationPlacements(
  compiled: WorkerResultRequirementsWithEffectsV1,
  observedAt: string,
) {
  return {
    source: placement(
      "source",
      "pre_result_application",
      compiled.coordinatorFacts.sourcePlacementDispatch,
      undefined,
      observedAt,
    ),
    main: placement(
      "main",
      "pre_result_application",
      compiled.coordinatorFacts.canonicalMainPlacementDispatch,
      undefined,
      observedAt,
    ),
  };
}

describe("worker result provider-effect admission", () => {
  test("rejects the exact Quarry #800 claimed-no-effects contradiction", () => {
    const compiled = requirements();
    const effects = effectEvidence(compiled, {
      observedEffects: [
        {
          effectId: "quarry-800-pull-request-workflow",
          provider: "github",
          instanceId: "actions-run:32878198599",
          evidenceRefs: ["github:actions-run:32878198599:event=pull_request"],
        },
        {
          effectId: "quarry-800-live-yahoo-step",
          provider: "github",
          instanceId: "actions-run:32878198599:step:live-yahoo",
          evidenceRefs: ["github:actions-run:32878198599:step=live-yahoo"],
        },
        {
          effectId: "quarry-800-workflow-artifact",
          provider: "github",
          instanceId: "actions-artifact:9574737198",
          evidenceRefs: ["github:actions-artifact:9574737198"],
        },
      ],
    });
    const admitted = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      effects,
    );

    expect(admitted.resultDisposition).toBe("rejected");
    expect("effects" in admitted).toBeTrue();
    if (!("effects" in admitted)) throw new Error("effect admission missing");
    expect(admitted.effects).toMatchObject({
      narrativeClaimedNoEffects: true,
      providerObservedEffectCount: 3,
      disposition: "violated",
      forbiddenObservedEffectIds: [
        "quarry-800-live-yahoo-step",
        "quarry-800-pull-request-workflow",
        "quarry-800-workflow-artifact",
      ],
      unexpectedObservedInstanceIds: [],
      providerEvidenceFingerprint: effects.fingerprint,
    });
    expect(admitted.authorizesAcceptance).toBeFalse();
    expect(admitted.authorizesResultApplication).toBeFalse();
  });

  test("admits claimed-no-effects only after complete clean provider coverage", () => {
    const compiled = requirements();
    const admitted = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      effectEvidence(compiled),
    );
    expect(admitted.resultDisposition).toBe("acceptance_candidate");
    if (!("effects" in admitted)) throw new Error("effect admission missing");
    expect(admitted.effects).toMatchObject({
      narrativeClaimedNoEffects: true,
      providerObservedEffectCount: 0,
      disposition: "satisfied",
      mismatchEffectIds: [],
      forbiddenObservedEffectIds: [],
      unexpectedObservedInstanceIds: [],
    });
  });

  test("cannot weaken frozen effect expectations after provider dispatch", () => {
    const frozen = requirements();
    const weakened = quarryExpectations.map((expectation) => ({
      ...expectation,
      disposition: "allowed" as const,
    }));
    const runnerReservation = reservation();
    const sourcePlacement = placement("source");
    const mainPlacement = placement("main");
    expect(() => compileWorkerResultRequirementsV1({
      version: 1,
      brief: compileWorkerBriefV1(briefInput()),
      runnerReservation,
      placements: { source: sourcePlacement, canonicalMain: mainPlacement },
      checkout: {
        profile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
        dispatchTree,
        providerDispatch: frozen.coordinatorFacts.providerDispatch,
      },
      deltaRequirement: "required_nonempty",
      provenanceObligations: [{
        id: "result-provider-effect-provenance",
        statement: "Provider effect observations come from the owning provider",
        sourceRef: "issue:1616#result-effect-contract",
      }],
      effectExpectations: weakened,
    })).toThrow("does not match the effect-sensitive result contract");
  });

  test("keeps incomplete provider coverage review-required", () => {
    const compiled = requirements();
    const admitted = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      effectEvidence(compiled, { coverage: "incomplete" }),
    );
    expect(admitted.resultDisposition).toBe("review_required");
    if (!("effects" in admitted)) throw new Error("effect admission missing");
    expect(admitted.effects.disposition).toBe("unknown");
  });

  test("separates an allowed provider effect from the worker narrative claim", () => {
    const allowed: readonly WorkerResultEffectExpectationInputV1[] = [{
      id: "declared-ci-receipt",
      provider: "github",
      disposition: "allowed",
      statement: "One declared GitHub CI receipt may exist",
      sourceRef: "issue:1616#allowed-effect-fixture",
    }];
    const compiled = requirements(allowed);
    const evidence = effectEvidence(compiled, {
      observedEffects: [{
        effectId: "declared-ci-receipt",
        provider: "github",
        instanceId: "actions-run:42424242",
        evidenceRefs: ["github:actions-run:42424242"],
      }],
    });

    const contradicted = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      evidence,
    );
    expect(contradicted.resultDisposition).toBe("review_required");
    if (!("effects" in contradicted)) throw new Error("effect admission missing");
    expect(contradicted.effects).toMatchObject({
      disposition: "unknown",
      mismatchEffectIds: ["declared-ci-receipt"],
      forbiddenObservedEffectIds: [],
    });

    const reconciled = adjudicateWorkerResultV1(
      compiled,
      observation(compiled, ["declared-ci-receipt"]),
      canonicalDelta(compiled),
      evidence,
    );
    expect(reconciled.resultDisposition).toBe("acceptance_candidate");
    if (!("effects" in reconciled)) throw new Error("effect admission missing");
    expect(reconciled.effects.disposition).toBe("satisfied");
  });

  test("rejects provider-observed undeclared effects", () => {
    const allowed: readonly WorkerResultEffectExpectationInputV1[] = [{
      id: "declared-ci-receipt",
      provider: "github",
      disposition: "allowed",
      statement: "One declared GitHub CI receipt may exist",
      sourceRef: "issue:1616#unexpected-effect-fixture",
    }];
    const compiled = requirements(allowed);
    const admitted = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      effectEvidence(compiled, {
        observedEffects: [{
          effectId: "undeclared-live-step",
          provider: "github",
          instanceId: "actions-run:43434343:step:live",
          evidenceRefs: ["github:actions-run:43434343:step=live"],
        }],
      }),
    );
    expect(admitted.resultDisposition).toBe("rejected");
    if (!("effects" in admitted)) throw new Error("effect admission missing");
    expect(admitted.effects).toMatchObject({
      disposition: "violated",
      unexpectedObservedInstanceIds: ["github:actions-run:43434343:step:live"],
    });
  });

  test("requires final placement reads to postdate provider-effect observation", () => {
    const compiled = requirements();
    const effects = effectEvidence(compiled, { observedAt: "2026-08-26T17:01:00.000Z" });
    const stale = applicationPlacements(compiled, "2026-08-26T17:00:00.000Z");
    const staleAdmission = adjudicateWorkerResultApplicationV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      stale.source,
      stale.main,
      effects,
    );
    expect(staleAdmission).toMatchObject({
      disposition: "stale_release",
      denials: ["source_placement_stale", "canonical_main_placement_stale"],
      authorizesResultApplication: false,
    });

    const fresh = applicationPlacements(compiled, "2026-08-26T17:02:00.000Z");
    const freshAdmission = adjudicateWorkerResultApplicationV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      fresh.source,
      fresh.main,
      effects,
    );
    expect(freshAdmission).toMatchObject({
      disposition: "admit",
      denials: [],
      authorizesResultApplication: false,
    });
  });
});
