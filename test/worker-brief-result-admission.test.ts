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
  compileWorkerProviderDispatchReceiptV1,
  compileWorkerResultContractV1,
  compileWorkerResultRequirementsV1,
  type WorkerResultObservationV1,
  type WorkerResultRequirementsV1,
} from "../src/worker-brief-result-admission.js";
import {
  compileWorkerBriefV1,
  type CompileWorkerBriefInputV1,
} from "../src/worker-brief.js";
import { compileProjectContract } from "../src/project-contract.js";
import type { ExecutionEnvelope } from "../src/execution-envelope.js";
import type { RunnerAdapterCommandReservationRecord } from "../src/runner-adapter-command-contracts.js";

const repository = "teamleaderleo/smolrunner";
const dispatchHead = "a".repeat(40);
const dispatchTree = "b".repeat(40);
const canonicalMain = "c".repeat(40);
const profileVersion = "codex-cloud/2026-08-26";
const sourceRef = "refs/heads/ox/parallax/issue-696-live-inventory";
const mainRef = "refs/heads/main";

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
    acceptanceChecks: ["project-native discriminator passed"],
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
      summary: "Adapt checkout verification to native Cloud facts.",
      nextAction: "Implement the bounded repository-contained change",
      status: "active",
    },
    control: {
      authorityState: "live",
      claimGeneration: 4,
      holderActorId: "worker-cloud-01",
      expiresAt: "2026-08-26T18:00:00.000Z",
    },
    dispatch: {
      runId: "run-cloud-1616-01",
      runGeneration: 1,
      leaseGeneration: 1,
      runnerProfile: "codex-cloud",
      capabilityClass: "standard",
    },
    objectiveOutcome: "Produce one exact bounded candidate and evidence.",
    objectiveNonGoals: [
      "Do not expose a generic program injection surface",
      "Do not infer the logical source ref from the local checkout branch",
    ],
    startingPoints: ["issue:1616", "comment:5413508841"],
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
      canonicalSummary: "Coordinator owns provider refs; executor owns exact checkout inspection.",
      expansionRefs: ["comment:5413508841"],
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

function reservation(overrides: Partial<RunnerAdapterCommandReservationRecord> = {}): RunnerAdapterCommandReservationRecord {
  return {
    project: "stensibly",
    itemId: "issue-1616",
    runId: "run-cloud-1616-01",
    runGeneration: 1,
    leaseGeneration: 1,
    actor: { id: "worker-cloud-01", name: "Cloud worker", kind: "agent" },
    adapterId: "codex-cloud-adapter",
    profileId: "codex-cloud",
    profileVersion,
    requestFingerprint: `sha256:${"1".repeat(64)}`,
    commandId: "command-cloud-1616-01",
    commandFingerprint: `sha256:${"2".repeat(64)}`,
    idempotencyKey: "command-cloud-1616-01",
    reservedAt: "2026-08-26T16:01:00.000Z",
    ...overrides,
  };
}

function facts(kind: "source" | "main", head?: string): CodexCloudCanonicalPlacementFactsV1 {
  return {
    ownerRef: kind === "source" ? "github:smolrunner#696" : "github:smolrunner:main",
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
  resultObservedAt = "2026-08-26T17:00:00.000Z",
): CodexCloudPlacementPreflightInputV1 {
  const suffix = phase === "pre_dispatch" ? "dispatch" : "result";
  const expected = facts(kind);
  return {
    version: 1,
    phase,
    repository,
    missionRef: kind === "source" ? "github:smolrunner#696" : "github:smolrunner:main",
    expected,
    canonicalRead: codexCloudCanonicalReadEvidenceV1({
      receiptId: `${kind}-read-${suffix}`,
      observedAt: phase === "pre_dispatch"
        ? "2026-08-26T16:02:00.000Z"
        : resultObservedAt,
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
  deltaRequirement: "required_nonempty" | "allowed_empty" = "required_nonempty",
  overrides: {
    brief?: CompileWorkerBriefInputV1;
    runnerReservation?: RunnerAdapterCommandReservationRecord;
  } = {},
) {
  const runnerReservation = overrides.runnerReservation ?? reservation();
  const sourcePlacement = placement("source");
  const mainPlacement = placement("main");
  const sourceDispatch = adjudicateCodexCloudPlacementV1(sourcePlacement).dispatchReceipt;
  const mainDispatch = adjudicateCodexCloudPlacementV1(mainPlacement).dispatchReceipt;
  if (sourceDispatch === null || mainDispatch === null) throw new Error("test dispatch receipt missing");
  const brief = compileWorkerBriefV1(overrides.brief ?? briefInput());
  const provenanceObligations = [{
    id: "inventory-capture-production-provenance",
    statement: "Production inventory capture uses only the reviewed fixed provider path",
    sourceRef: "smolrunner#696:acceptance",
  }];
  const resultContract = compileWorkerResultContractV1({
    version: 1,
    brief,
    checkoutProfile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
    dispatchTree,
    deltaRequirement,
    provenanceObligations,
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
        providerTaskId: "task-e-cloud-1616",
        dispatchedAt: "2026-08-26T16:03:00.000Z",
        runnerReservationFingerprint: fingerprintCanonicalRequest(runnerReservation),
        sourcePlacementDispatchFingerprint: sourceDispatch.fingerprint,
        canonicalMainPlacementDispatchFingerprint: mainDispatch.fingerprint,
        resultContractFingerprint: resultContract.fingerprint,
      }),
    },
    deltaRequirement,
    provenanceObligations,
  });
}

function observation(
  compiled: WorkerResultRequirementsV1,
  overrides: Partial<WorkerResultObservationV1["checkout"]> = {},
  obligationCount = 3,
): WorkerResultObservationV1 {
  return {
    requirementsFingerprint: compiled.fingerprint,
    checkout: {
      head: dispatchHead,
      tree: dispatchTree,
      localBranch: "work",
      originMainHead: null,
      originUrl: null,
      ...overrides,
    },
    obligations: compiled.obligations.slice(0, obligationCount).map((obligation) => ({
      id: obligation.id,
      disposition: "satisfied",
      evidenceRefs: [`test:${obligation.id}`],
    })),
    delta: {
      narrativeDeltaClaimed: true,
      evidenceRefs: ["executor:claimed-seven-file-implementation"],
    },
  };
}

function canonicalDelta(
  compiled: WorkerResultRequirementsV1,
  overrides: Partial<Parameters<typeof compileWorkerCanonicalDeltaEvidenceV1>[0]> = {},
) {
  return compileWorkerCanonicalDeltaEvidenceV1({
    version: 1,
    requirementsFingerprint: compiled.fingerprint,
    observedAt: "2026-08-26T16:59:00.000Z",
    providerTaskId: "task-e-cloud-1616",
    providerStatus: "READY",
    evidenceAvailability: "exposed",
    changedFileCount: 7,
    changedLineCount: 314,
    diffAvailable: true,
    evidenceRefs: ["provider:task-status-list-diff"],
    ...overrides,
  });
}

function applicationPlacements(
  compiled: WorkerResultRequirementsV1,
  movedMain?: string,
  observedAt = "2026-08-26T17:00:00.000Z",
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
      movedMain,
      observedAt,
    ),
  };
}

describe("worker brief native Cloud result admission", () => {
  test("admits exact HEAD/tree on branch work with no remotes", () => {
    const compiled = requirements();
    const admitted = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
    );

    expect(compiled.runnerProfile).toMatchObject({ id: "codex-cloud", version: profileVersion });
    expect(compiled.coordinatorFacts.logicalSourceRef).toBe(sourceRef);
    expect(admitted.checkoutEligible).toBeTrue();
    expect(admitted.resultDisposition).toBe("acceptance_candidate");
    expect(admitted.authorizesAcceptance).toBeFalse();
    expect(admitted.authorizesResultApplication).toBeFalse();
    expect(admitted.checkoutFacts).toContainEqual({
      id: "local_branch",
      owner: "executor",
      disposition: "observed",
      expected: null,
      observed: "work",
    });
    for (const id of ["origin_main", "origin_url", "logical_source_ref", "canonical_main"]) {
      expect(admitted.checkoutFacts.find((fact) => fact.id === id)?.disposition)
        .toBe("not_exposed_by_profile");
    }
  });

  test("requires coordinator canonical evidence instead of trusting executor prose", () => {
    const compiled = requirements();
    const admitted = adjudicateWorkerResultV1(compiled, observation(compiled), null);
    expect(admitted.resultDisposition).toBe("review_required");
    expect(admitted.delta.canonicalDelta).toBe("unknown");
    expect(admitted.delta.mismatch).toBe("narrative_delta_without_canonical_evidence");
    expect(admitted.delta.canonicalEvidenceFingerprint).toBeNull();

    const contradictory = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled, {
        changedFileCount: 0,
        changedLineCount: 0,
        diffAvailable: true,
      }),
    );
    expect(contradictory.delta.canonicalDelta).toBe("unknown");
    expect(contradictory.resultDisposition).toBe("review_required");
  });

  test("keeps nonterminal provider output as status evidence", () => {
    const compiled = requirements();
    const pending = adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled, { providerStatus: "PENDING" }),
    );
    expect(pending.delta.canonicalDelta).toBe("unknown");
    expect(pending.resultDisposition).toBe("review_required");
    expect(pending.delta.mismatch).toBe("narrative_delta_without_canonical_evidence");
  });

  test("keeps missing obligations review-required and rejects violated exclusions", () => {
    const compiled = requirements();
    const missing = adjudicateWorkerResultV1(
      compiled,
      observation(compiled, {}, 2),
      canonicalDelta(compiled),
    );
    expect(missing.resultDisposition).toBe("review_required");
    expect(missing.obligations.at(-1)?.disposition).toBe("unknown");

    const initial = observation(compiled);
    const violated = adjudicateWorkerResultV1(compiled, {
      ...initial,
      obligations: initial.obligations.map((entry, index) => index === 0
        ? { ...entry, disposition: "violated" as const, evidenceRefs: ["diff:scope-breach"] }
        : entry),
    }, canonicalDelta(compiled));
    expect(violated.resultDisposition).toBe("rejected");
    expect(violated.obligations[0]).toMatchObject({
      kind: "exclusion",
      disposition: "violated",
      evidenceRefs: ["diff:scope-breach"],
    });
  });

  test("rejects Quarry #800 narrative implementation claims against canonical empty diff", () => {
    const compiled = requirements();
    const delta = canonicalDelta(compiled, {
      changedFileCount: 0,
      changedLineCount: 0,
      diffAvailable: false,
      evidenceRefs: ["quarry#800:comment-5414003863", "provider:READY-0-files-0-lines"],
    });
    const admitted = adjudicateWorkerResultV1(compiled, observation(compiled), delta);
    expect(admitted.resultDisposition).toBe("rejected");
    expect(admitted.delta).toMatchObject({
      narrativeDeltaClaimed: true,
      canonicalDelta: "empty",
      disposition: "violated",
      mismatch: "narrative_delta_contradicted_by_canonical_empty",
      executorEvidenceRefs: ["executor:claimed-seven-file-implementation"],
      coordinatorEvidenceRefs: [
        "quarry#800:comment-5414003863",
        "provider:READY-0-files-0-lines",
      ],
    });
    expect(admitted.delta.canonicalEvidenceFingerprint).toBe(delta.fingerprint);
  });

  test("allows an explicitly read-only contract to retain canonical empty diff", () => {
    const compiled = requirements("allowed_empty");
    const result = observation(compiled);
    const admitted = adjudicateWorkerResultV1(compiled, {
      ...result,
      delta: { narrativeDeltaClaimed: false, evidenceRefs: ["executor:read-only"] },
    }, canonicalDelta(compiled, {
      changedFileCount: 0,
      changedLineCount: 0,
      diffAvailable: false,
    }));
    expect(admitted.delta.disposition).toBe("satisfied");
    expect(admitted.delta.mismatch).toBeNull();
    expect(admitted.resultDisposition).toBe("acceptance_candidate");
    expect(admitted.authorizesAcceptance).toBeFalse();
  });

  test("cannot weaken the frozen result contract after provider dispatch", () => {
    const frozen = requirements("required_nonempty");
    const runnerReservation = reservation();
    expect(() => compileWorkerResultRequirementsV1({
      version: 1,
      brief: compileWorkerBriefV1(briefInput()),
      runnerReservation,
      placements: { source: placement("source"), canonicalMain: placement("main") },
      checkout: {
        profile: CODEX_CLOUD_WORKTREE_PROFILE_V1,
        dispatchTree,
        providerDispatch: frozen.coordinatorFacts.providerDispatch,
      },
      deltaRequirement: "allowed_empty",
      provenanceObligations: [],
    })).toThrow("does not match admitted dispatch prerequisites");

    const { fingerprint: _originalFingerprint, ...serialized } = frozen;
    const weakenedBody = {
      ...serialized,
      deltaRequirement: "allowed_empty" as const,
      obligations: [],
    };
    const weakened = {
      ...weakenedBody,
      fingerprint: fingerprintCanonicalRequest(weakenedBody),
    };
    expect(() => adjudicateWorkerResultV1(
      weakened,
      observation(weakened),
      canonicalDelta(weakened),
    )).toThrow("result contract fingerprint does not match requirements");

    const movedTreeBody = {
      ...serialized,
      coordinatorFacts: {
        ...serialized.coordinatorFacts,
        dispatchTree: "f".repeat(40),
      },
    };
    const movedTree = {
      ...movedTreeBody,
      fingerprint: fingerprintCanonicalRequest(movedTreeBody),
    };
    expect(() => adjudicateWorkerResultV1(
      movedTree,
      observation(movedTree),
      canonicalDelta(movedTree),
    )).toThrow("result contract fingerprint does not match requirements");
  });

  test("fails closed on missing or mismatched exact checkout facts", () => {
    const compiled = requirements();
    const unknown = adjudicateWorkerResultV1(
      compiled,
      observation(compiled, { head: null }),
      canonicalDelta(compiled),
    );
    expect(unknown.resultDisposition).toBe("review_required");

    const wrong = adjudicateWorkerResultV1(
      compiled,
      observation(compiled, { tree: "e".repeat(40) }),
      canonicalDelta(compiled),
    );
    expect(wrong.resultDisposition).toBe("rejected");
  });

  test("consumes #1695 pre-result placement and stale-releases moved canonical main", () => {
    const compiled = requirements();
    const placements = applicationPlacements(compiled, "9".repeat(40));
    const application = adjudicateWorkerResultApplicationV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      placements.source,
      placements.main,
    );
    expect(application.disposition).toBe("stale_release");
    expect(application.denials).toEqual(["canonical_main_placement_stale"]);
    expect(application.authorizesResultApplication).toBeFalse();
  });

  test("admits application evidence only after both fresh #1695 reads", () => {
    const compiled = requirements();
    const placements = applicationPlacements(compiled);
    const application = adjudicateWorkerResultApplicationV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      placements.source,
      placements.main,
    );
    expect(application.disposition).toBe("admit");
    expect(application.denials).toEqual([]);
    expect(application.authorizesResultApplication).toBeFalse();
  });

  test("stale-releases #1695 reads taken before terminal result evidence", () => {
    const compiled = requirements();
    const placements = applicationPlacements(
      compiled,
      undefined,
      "2026-08-26T16:58:00.000Z",
    );
    const application = adjudicateWorkerResultApplicationV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled),
      placements.source,
      placements.main,
    );
    expect(application.disposition).toBe("stale_release");
    expect(application.denials).toEqual([
      "source_placement_stale",
      "canonical_main_placement_stale",
    ]);
  });

  test("consumes exact #1702 reservation provenance and reconciles the brief baseline", () => {
    expect(() => requirements("required_nonempty", {
      runnerReservation: reservation({ profileVersion: null }),
    })).toThrow("exact durable runner profile version");
    const rotated = requirements("required_nonempty", {
      runnerReservation: reservation({ profileVersion: "codex-cloud/2026-08-27" }),
    });
    expect(rotated.runnerProfile.version).toBe("codex-cloud/2026-08-27");
    expect(() => requirements("required_nonempty", {
      runnerReservation: reservation({ profileId: "different-profile" }),
    })).toThrow("does not match the worker brief identity");
    expect(() => requirements("required_nonempty", {
      runnerReservation: reservation({ reservedAt: "2026-08-26T16:04:00.000Z" }),
    })).toThrow("predates admitted dispatch prerequisites");

    const changed = briefInput();
    changed.situation.repositoryBaseline = {
      repository: "teamleaderleo/other",
      baseRevision: dispatchHead,
      candidateRevision: null,
      changeIdentity: null,
    };
    expect(() => requirements("required_nonempty", { brief: changed }))
      .toThrow("does not match the worker brief repository baseline");
  });

  test("rejects tampered coordinator delta receipts and hostile result arrays", () => {
    const compiled = requirements();
    const delta = canonicalDelta(compiled);
    expect(() => adjudicateWorkerResultV1(compiled, observation(compiled), {
      ...delta,
      canonicalDelta: "empty",
    })).toThrow("does not match its content");
    expect(() => adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled, { providerTaskId: "task-e-other" }),
    )).toThrow("different provider task");
    expect(() => adjudicateWorkerResultV1(
      compiled,
      observation(compiled),
      canonicalDelta(compiled, { observedAt: "2026-08-26T16:01:00.000Z" }),
    )).toThrow("predates the admitted provider dispatch");

    const hostile = observation(compiled);
    let invoked = false;
    Object.defineProperty(hostile.obligations, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return null;
      },
    });
    expect(() => adjudicateWorkerResultV1(compiled, hostile, delta))
      .toThrow("entries must be enumerable data properties");
    expect(invoked).toBeFalse();
  });

  test("binds provider dispatch provenance and snapshots nested hostile records", () => {
    const compiled = requirements();
    expect(() => adjudicateWorkerResultV1({
      ...compiled,
      coordinatorFacts: {
        ...compiled.coordinatorFacts,
        providerDispatch: {
          ...compiled.coordinatorFacts.providerDispatch,
          dispatchedAt: "2026-08-26T16:04:00.000Z",
        },
      },
    }, observation(compiled), canonicalDelta(compiled))).toThrow("does not match its content");

    let invoked = false;
    const hostileRunner = { ...compiled.runnerProfile };
    Object.defineProperty(hostileRunner, "version", {
      enumerable: true,
      get() {
        invoked = true;
        return profileVersion;
      },
    });
    expect(() => adjudicateWorkerResultV1({
      ...compiled,
      runnerProfile: hostileRunner,
    }, observation(compiled), canonicalDelta(compiled)))
      .toThrow("must be an enumerable data property");
    expect(invoked).toBeFalse();

    const decoratedDispatch = {
      ...compiled.coordinatorFacts.sourcePlacementDispatch,
      [Symbol("forged")]: true,
    };
    expect(() => adjudicateWorkerResultV1({
      ...compiled,
      coordinatorFacts: {
        ...compiled.coordinatorFacts,
        sourcePlacementDispatch: decoratedDispatch,
      },
    }, observation(compiled), canonicalDelta(compiled))).toThrow("cannot be decorated");
  });
});
