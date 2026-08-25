import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEnvelope } from "../src/execution-envelope.js";
import { compileProjectContract } from "../src/project-contract.js";
import {
  assertRunBoundWorkerBriefCurrentV1,
  compileRunBoundWorkerBriefV1,
  RUN_BOUND_WORKER_BRIEF_COMPILER_VERSION,
  runBoundWorkerBriefIsCurrentV1,
  runBoundWorkerBriefJsonV1,
  workerBriefRunnerProfileProvenanceV1,
  type CompileRunBoundWorkerBriefInputV1,
  type RunBoundWorkerBriefFreshnessFactsV1,
  type WorkerBriefRunBindingV1,
} from "../src/worker-brief-run-profile.js";
import {
  compileWorkerBriefV1,
  parseWorkerBriefV1,
} from "../src/worker-brief.js";

const observedAt = "2026-08-26T00:00:00.000Z";

let cachedSnapshot: ReturnType<typeof compileProjectContract> | null = null;

function contractSnapshot() {
  if (cachedSnapshot === null) {
    const markdown = readFileSync(join(import.meta.dir, "..", "STENSIBLY.md"), "utf8");
    cachedSnapshot = compileProjectContract(markdown);
  }
  return cachedSnapshot;
}

const envelope: ExecutionEnvelope = {
  schemaVersion: 1,
  objective: "Project exact durable runner provenance into worker guidance.",
  scopeClass: "atomic",
  estimate: { lowMinutes: 10, likelyMinutes: 20, highMinutes: 40, confidence: 0.8 },
  budget: { expectedMessages: 10, expectedToolCalls: 30, expectedReviewMinutes: 10 },
  boundaries: { softCheckpointMinutes: 15, forcedHandoffMinutes: 30, hardRecoveryMinutes: 60 },
  completion: {
    requiredOutputs: ["profile-bound worker brief"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["profile drift invalidates freshness"],
  },
  durableState: {
    accessClass: "project",
    retentionClass: "standard",
    redactionRequired: false,
    deleteAfter: null,
  },
};

function briefInput(): CompileRunBoundWorkerBriefInputV1 {
  return {
    observedAt,
    workspaceId: "default",
    projectId: "stensibly",
    policySnapshot: contractSnapshot(),
    item: {
      id: "issue-1616",
      title: "Compile project-native worker briefs",
      summary: "Bind the brief to exact durable runner profile provenance.",
      nextAction: "Compile runner profile version into brief identity",
      status: "active",
    },
    control: {
      authorityState: "live",
      claimGeneration: 4,
      holderActorId: "worker-sol-01",
      expiresAt: "2026-08-26T02:00:00.000Z",
    },
    objectiveOutcome: "Keep worker guidance replayable across runner profile rollover.",
    objectiveNonGoals: ["Do not change adapter authority"],
    startingPoints: ["issue:1616", "issue:305"],
    situation: {
      repositoryBaseline: {
        repository: "teamleaderleo/stensibly",
        baseRevision: "58bbc4943421",
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
      canonicalSummary: "The durable run owns exact-or-null runner profile version provenance.",
      expansionRefs: ["issue:1616", "issue:305"],
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

function run(profileVersion: string | null): WorkerBriefRunBindingV1 {
  return {
    id: "run-worker-brief-profile-01",
    generation: 3,
    leaseGeneration: 7,
    runnerProfile: "codex-default",
    runnerProfileVersion: profileVersion,
  };
}

function freshness(
  input: CompileRunBoundWorkerBriefInputV1,
  semanticDigest: string,
): RunBoundWorkerBriefFreshnessFactsV1 {
  return {
    expectedSemanticDigest: semanticDigest,
    itemId: input.item.id,
    claimGeneration: input.control.claimGeneration,
    contractSnapshotSha256: input.policySnapshot.snapshotSha256,
    itemNextAction: input.item.nextAction,
  };
}

describe("run-bound worker brief profile provenance", () => {
  test("compiles exact durable profile version into brief identity and digest", () => {
    const input = briefInput();
    const currentRun = run("codex-default/2026-08-26");
    const brief = compileRunBoundWorkerBriefV1(input, currentRun, "standard");

    expect(brief.compilerVersion).toBe(RUN_BOUND_WORKER_BRIEF_COMPILER_VERSION);
    expect(brief.identity.dispatch).toMatchObject({
      runId: currentRun.id,
      runGeneration: currentRun.generation,
      leaseGeneration: currentRun.leaseGeneration,
      runnerProfile: currentRun.runnerProfile,
      runnerProfileVersion: currentRun.runnerProfileVersion,
      capabilityClass: "standard",
    });
    expect(workerBriefRunnerProfileProvenanceV1(brief)).toEqual({
      version: 1,
      profileId: "codex-default",
      profileVersion: "codex-default/2026-08-26",
    });
    expect(Object.isFrozen(brief)).toBe(true);
    expect(Object.isFrozen(brief.identity.dispatch)).toBe(true);

    const parsed = parseWorkerBriefV1(runBoundWorkerBriefJsonV1(brief));
    expect(workerBriefRunnerProfileProvenanceV1(parsed)).toEqual({
      version: 1,
      profileId: "codex-default",
      profileVersion: "codex-default/2026-08-26",
    });
  });

  test("rotates semantic identity when only the durable profile version changes", () => {
    const input = briefInput();
    const first = compileRunBoundWorkerBriefV1(
      input,
      run("codex-default/2026-08-26"),
      "standard",
    );
    const successor = compileRunBoundWorkerBriefV1(
      input,
      run("codex-default/2026-08-27"),
      "standard",
    );

    expect(successor.semanticDigest).not.toBe(first.semanticDigest);
    expect(successor.identity.dispatch.runnerProfileVersion)
      .toBe("codex-default/2026-08-27");
  });

  test("fails freshness on profile ID/version drift while exact provenance stays current", () => {
    const input = briefInput();
    const currentRun = run("codex-default/2026-08-26");
    const brief = compileRunBoundWorkerBriefV1(input, currentRun, "standard");
    const facts = freshness(input, brief.semanticDigest);

    expect(() => assertRunBoundWorkerBriefCurrentV1(brief, facts, currentRun))
      .not.toThrow();
    expect(runBoundWorkerBriefIsCurrentV1(brief, facts, currentRun)).toBe(true);

    const changedVersion = run("codex-default/2026-08-27");
    expect(() => assertRunBoundWorkerBriefCurrentV1(brief, facts, changedVersion))
      .toThrow("different_version");
    expect(runBoundWorkerBriefIsCurrentV1(brief, facts, changedVersion)).toBe(false);

    const changedProfile = {
      ...currentRun,
      runnerProfile: "codex-review",
    };
    expect(() => assertRunBoundWorkerBriefCurrentV1(brief, facts, changedProfile))
      .toThrow("different_profile");
  });

  test("preserves historical v1 briefs as explicit unknown and never upgrades them silently", () => {
    const input = briefInput();
    const legacyRun = run(null);
    const historical = compileWorkerBriefV1({
      ...input,
      dispatch: {
        runId: legacyRun.id,
        runGeneration: legacyRun.generation,
        leaseGeneration: legacyRun.leaseGeneration,
        runnerProfile: legacyRun.runnerProfile,
        capabilityClass: "standard",
      },
    });
    const facts = freshness(input, historical.semanticDigest);

    expect(workerBriefRunnerProfileProvenanceV1(historical)).toEqual({
      version: 1,
      profileId: "codex-default",
      profileVersion: null,
    });
    expect(() => assertRunBoundWorkerBriefCurrentV1(historical, facts, legacyRun))
      .not.toThrow();

    expect(() => assertRunBoundWorkerBriefCurrentV1(
      historical,
      facts,
      run("codex-default/2026-08-26"),
    )).toThrow("version_unknown");
  });

  test("requires new run-bound compilation to state exact version or explicit null", () => {
    const missingVersion = {
      id: "run-worker-brief-profile-01",
      generation: 3,
      leaseGeneration: 7,
      runnerProfile: "codex-default",
    } as WorkerBriefRunBindingV1;

    expect(() => compileRunBoundWorkerBriefV1(
      briefInput(),
      missingVersion,
      "standard",
    )).toThrow("explicit runner profile version or null");
  });
});
