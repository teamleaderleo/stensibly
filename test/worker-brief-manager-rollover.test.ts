import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertWorkerBriefCurrentV1,
  compileWorkerBriefV1,
  workerBriefJson,
  type CompileWorkerBriefInputV1,
  type WorkerBriefFreshnessFactsV1,
  type WorkerBriefV1,
} from "../src/worker-brief.js";
import { compileProjectContract } from "../src/project-contract.js";
import type { ExecutionEnvelope } from "../src/execution-envelope.js";

const PROFILE = "codex-sol-manager";
const MAIN_REVISION = "215dbc5100bced14646b6259c74aac7843dd524d";

let cachedSnapshot: ReturnType<typeof compileProjectContract> | null = null;

function contractSnapshot() {
  if (cachedSnapshot === null) {
    const markdown = readFileSync(join(import.meta.dir, "..", "STENSIBLY.md"), "utf8");
    cachedSnapshot = compileProjectContract(markdown);
  }
  return cachedSnapshot;
}

const longRunningEnvelope: ExecutionEnvelope = {
  schemaVersion: 1,
  objective: "Supervise one coherent worker-brief campaign across bounded actions.",
  scopeClass: "long-running",
  estimate: {
    lowMinutes: 60,
    likelyMinutes: 180,
    highMinutes: 480,
    confidence: 0.6,
  },
  budget: {
    expectedMessages: 120,
    expectedToolCalls: 360,
    expectedReviewMinutes: 60,
  },
  boundaries: {
    softCheckpointMinutes: 60,
    forcedHandoffMinutes: 240,
    hardRecoveryMinutes: 480,
  },
  completion: {
    requiredOutputs: ["manager decision receipt", "typed handoff"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["refresh current state before consequential dispatch"],
  },
  durableState: {
    accessClass: "project",
    retentionClass: "standard",
    redactionRequired: false,
    deleteAfter: null,
  },
};

function managerInput(runId = "run-manager-a"): CompileWorkerBriefInputV1 {
  return {
    observedAt: "2026-08-25T08:00:00.000Z",
    workspaceId: "default",
    projectId: "stensibly",
    policySnapshot: contractSnapshot(),
    item: {
      id: "issue-1616",
      title: "Compile project-native worker briefs",
      summary: "Keep exact worker guidance useful across a long coherent campaign.",
      nextAction: "Review current child receipts and choose the next bounded action",
      status: "active",
    },
    control: {
      authorityState: "live",
      claimGeneration: 2,
      holderActorId: "manager-a",
      expiresAt: "2026-08-25T16:00:00.000Z",
    },
    dispatch: {
      runId,
      runGeneration: 1,
      leaseGeneration: 1,
      runnerProfile: PROFILE,
      capabilityClass: "frontier",
    },
    objectiveOutcome: "Keep the #1616 campaign moving through exact bounded actions and receipts.",
    objectiveNonGoals: [
      "Create a permanent manager identity",
      "Treat cached conversational context as project truth",
    ],
    startingPoints: ["issue:1616", "comment:5407784265"],
    situation: {
      repositoryBaseline: {
        repository: "teamleaderleo/stensibly",
        baseRevision: MAIN_REVISION,
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
      canonicalSummary: "Current #1616 responsibility, exact child receipts, and accepted project policy.",
      expansionRefs: ["issue:1616", "issue:1659", "issue:50"],
      maxEvidenceCharacters: 8_000,
      sourceFreshness: "fresh_read_required",
      contextPack: null,
    },
    executionEnvelope: longRunningEnvelope,
    recipe: null,
    continuation: null,
    wakeRetryCondition: "Wake on a material child receipt, decision request, or current-state change.",
  };
}

function freshnessFacts(
  input: CompileWorkerBriefInputV1,
  brief: WorkerBriefV1,
): WorkerBriefFreshnessFactsV1 {
  return {
    expectedSemanticDigest: brief.semanticDigest,
    runId: input.dispatch.runId,
    itemId: input.item.id,
    claimGeneration: input.control.claimGeneration,
    runGeneration: input.dispatch.runGeneration,
    leaseGeneration: input.dispatch.leaseGeneration,
    contractSnapshotSha256: input.policySnapshot.snapshotSha256,
    itemNextAction: input.item.nextAction,
  };
}

describe("worker-brief/v1 long-running manager rollover", () => {
  test("rotates exact action briefs inside one hot manager run", () => {
    const firstInput = managerInput();
    const firstBrief = compileWorkerBriefV1(firstInput);

    const nextInput = managerInput();
    nextInput.observedAt = "2026-08-25T09:00:00.000Z";
    nextInput.item.nextAction = "Adjudicate the accepted child review and choose one repair or completion action";
    nextInput.situation.outstandingDecisions = ["Adjudicate the latest child review receipt"];
    const nextBrief = compileWorkerBriefV1(nextInput);

    expect(nextBrief.execution.scopeClass).toBe("long-running");
    expect(nextBrief.identity.dispatch.runId).toBe(firstBrief.identity.dispatch.runId);
    expect(nextBrief.identity.dispatch.runGeneration).toBe(firstBrief.identity.dispatch.runGeneration);
    expect(nextBrief.identity.dispatch.leaseGeneration).toBe(firstBrief.identity.dispatch.leaseGeneration);
    expect(nextBrief.identity.dispatch.runnerProfile).toBe(PROFILE);
    expect(nextBrief.semanticDigest).not.toBe(firstBrief.semanticDigest);

    expect(() =>
      assertWorkerBriefCurrentV1(nextBrief, freshnessFacts(nextInput, nextBrief)),
    ).not.toThrow();
    expect(() =>
      assertWorkerBriefCurrentV1(firstBrief, freshnessFacts(nextInput, nextBrief)),
    ).toThrow("fails closed");
  });

  test("replaces a hot manager with a fresh same-profile run from durable handoff", () => {
    const incumbentInput = managerInput();
    incumbentInput.observedAt = "2026-08-25T10:00:00.000Z";
    incumbentInput.item.nextAction = "Consolidate accepted child evidence and prepare a manager handoff";
    const incumbentBrief = compileWorkerBriefV1(incumbentInput);

    const handoff = {
      ref: "handoff-manager-1616-a",
      fromRunId: incumbentInput.dispatch.runId,
      priorBriefDigest: incumbentBrief.semanticDigest,
      summary: "The worker-brief compiler is merged; run/profile semantics are reconciled; live server wiring remains.",
      findings: [
        "Exact briefs may rotate while one long-running manager run stays current",
        "Cache affinity carries no unique project fact",
      ],
      nextAction: "Bind live worker-brief compilation to the current run and exact runner profile source",
      evidenceRefs: [
        "issue:1616",
        "comment:5407784265",
        "commit:215dbc5100bced14646b6259c74aac7843dd524d",
      ],
      emittedAt: "2026-08-25T10:30:00.000Z",
      replacesClaimGeneration: 2,
    };

    const successorInput = managerInput("run-manager-b");
    successorInput.observedAt = "2026-08-25T11:00:00.000Z";
    successorInput.item.nextAction = handoff.nextAction;
    successorInput.control = {
      authorityState: "live",
      claimGeneration: 3,
      holderActorId: "manager-b",
      expiresAt: "2026-08-25T19:00:00.000Z",
    };
    successorInput.continuation = handoff;
    successorInput.objectiveOutcome = "Continue the same #1616 responsibility from accepted durable evidence.";
    const successorBrief = compileWorkerBriefV1(successorInput);

    expect(successorBrief.identity.itemId).toBe(incumbentBrief.identity.itemId);
    expect(successorBrief.identity.projectId).toBe(incumbentBrief.identity.projectId);
    expect(successorBrief.policy.contractSnapshotSha256)
      .toBe(incumbentBrief.policy.contractSnapshotSha256);
    expect(successorBrief.identity.dispatch.runId).not.toBe(incumbentBrief.identity.dispatch.runId);
    expect(successorBrief.identity.dispatch.runGeneration).toBe(1);
    expect(successorBrief.identity.dispatch.leaseGeneration).toBe(1);
    expect(successorBrief.identity.dispatch.runnerProfile).toBe(PROFILE);
    expect(successorBrief.semanticDigest).not.toBe(incumbentBrief.semanticDigest);
    expect(successorBrief.identity.continuation).toEqual({
      ref: handoff.ref,
      fromRunId: handoff.fromRunId,
    });
    expect(successorBrief.objective.nextAction).toBe(handoff.nextAction);
    expect(successorBrief.objective.nextActionSource).toEqual({
      kind: "handoff_record",
      coordinates: `handoff:${handoff.ref}`,
    });
    expect(successorBrief.continuation?.priorBriefDigest).toBe(incumbentBrief.semanticDigest);

    expect(() =>
      assertWorkerBriefCurrentV1(successorBrief, freshnessFacts(successorInput, successorBrief)),
    ).not.toThrow();
    expect(() =>
      assertWorkerBriefCurrentV1(incumbentBrief, freshnessFacts(successorInput, successorBrief)),
    ).toThrow("fails closed");

    const serialized = workerBriefJson(successorBrief).toLowerCase();
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("provider cache");
  });
});
