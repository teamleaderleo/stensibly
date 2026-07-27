import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  compareSmolRunnerReceiptTransitions,
  parseSmolRunnerReceiptIntake,
  projectSmolRunnerReceiptLiveness,
  type SmolRunnerReceiptIntake,
} from "../src/smolrunner-receipt-intake.ts";

const progressFixture = fixture("smolrunner-receipt-progress-v1.json");
const completedFixture = fixture("smolrunner-receipt-completed-v1.json");

describe("SmolRunner receipt intake", () => {
  test("maps a bounded progress receipt without granting executor authority", () => {
    const transition = parseSmolRunnerReceiptIntake(progressFixture);

    expect(transition).toMatchObject({
      schemaVersion: 1,
      transitionKind: "progress_checkpoint",
      executionId: "exec_quarry_238_a",
      checkpointGeneration: 3,
      producerVersion: "0.1.0",
      sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sourceTree: "cccccccccccccccccccccccccccccccccccccccc",
      state: "running",
      phaseId: "source-work",
      observedAt: "2026-07-28T18:02:00.000Z",
      receiptDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      progress: { completed: 4, total: 12, unit: "actions" },
      disposition: "none",
      publicCode: null,
      nextAction: "continue",
      authority: {
        merge: false,
        deploy: false,
        credentials: false,
        spending: false,
        providerAdministration: false,
      },
    });
    expect(transition.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const publicJson = JSON.stringify(transition);
    for (const forbidden of [
      "/home/operator/private",
      "--dangerous-command",
      "SECRET_TOKEN",
      "raw stdout",
      "raw stderr",
    ]) {
      expect(publicJson).not.toContain(forbidden);
    }
  });

  test("uses deterministic canonical fingerprints regardless of object key order", () => {
    const ordinary = parseSmolRunnerReceiptIntake(progressFixture);
    const reordered = parseSmolRunnerReceiptIntake(reverseObject(progressFixture));

    expect(reordered).toEqual(ordinary);
    expect(reordered.fingerprint).toBe(ordinary.fingerprint);
  });

  test("allows a published candidate head to advance on the next exact checkpoint", () => {
    const progress = parseSmolRunnerReceiptIntake(progressFixture);
    const completed = parseSmolRunnerReceiptIntake(completedFixture);

    expect(progress.attempt.candidateHead).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(completed.attempt.candidateHead).toBe("dddddddddddddddddddddddddddddddddddddddd");
    expect(compareSmolRunnerReceiptTransitions(progress, completed)).toEqual({ status: "advance" });
    expect(completed.transitionKind).toBe("execution_completed");
    expect(projectSmolRunnerReceiptLiveness(completed, "2026-07-28T18:09:00.000Z"))
      .toEqual({ state: "terminal" });
  });

  test("classifies exact replay, conflicting reuse, stale delivery, and checkpoint gaps", () => {
    const progress = parseSmolRunnerReceiptIntake(progressFixture);
    expect(compareSmolRunnerReceiptTransitions(null, progress)).toEqual({ status: "insert" });
    expect(compareSmolRunnerReceiptTransitions(progress, progress)).toEqual({ status: "duplicate" });

    const changedSameCheckpoint = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.progress = { completed: 5, total: 12, unit: "actions" };
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, changedSameCheckpoint)).toEqual({
      status: "conflict",
      reason: "checkpoint_semantics",
    });

    const stale = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 2;
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, stale)).toEqual({
      status: "stale",
      reason: "checkpoint_generation",
    });

    const gap = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 5;
      value.receipt.observedAt = "2026-07-28T18:03:00.000Z";
      value.receipt.heartbeat = {
        intervalSeconds: 60,
        leaseExpiresAt: "2026-07-28T18:06:00.000Z",
      };
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, gap)).toEqual({
      status: "conflict",
      reason: "checkpoint_gap",
    });
  });

  test("fails closed on changed authority or execution identity", () => {
    const progress = parseSmolRunnerReceiptIntake(progressFixture);

    const changedClaim = parseSmolRunnerReceiptIntake(modify(completedFixture, (value) => {
      value.attempt.claimGeneration = 8;
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, changedClaim)).toEqual({
      status: "conflict",
      reason: "attempt_identity",
    });

    const changedExecution = parseSmolRunnerReceiptIntake(modify(completedFixture, (value) => {
      value.receipt.executionId = "exec_quarry_238_b";
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, changedExecution)).toEqual({
      status: "conflict",
      reason: "execution_identity",
    });
  });

  test("rejects candidate-head regression, terminal advance, invalid state order, and time reversal", () => {
    const progress = parseSmolRunnerReceiptIntake(progressFixture);

    const headRegression = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 4;
      value.receipt.state = "verifying";
      value.receipt.phaseId = "checkpoint-verify";
      value.receipt.observedAt = "2026-07-28T18:03:00.000Z";
      value.receipt.heartbeat = {
        intervalSeconds: 60,
        leaseExpiresAt: "2026-07-28T18:06:00.000Z",
      };
      value.attempt.candidateHead = null;
      value.receipt.source.commit = value.attempt.resolvedBaseCommit;
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, headRegression)).toEqual({
      status: "conflict",
      reason: "candidate_head_regression",
    });

    const completed = parseSmolRunnerReceiptIntake(completedFixture);
    const postTerminal = parseSmolRunnerReceiptIntake(modify(completedFixture, (value) => {
      value.receipt.checkpointGeneration = 5;
      value.receipt.observedAt = "2026-07-28T18:09:00.000Z";
      value.receipt.terminalAt = "2026-07-28T18:09:00.000Z";
    }));
    expect(compareSmolRunnerReceiptTransitions(completed, postTerminal)).toEqual({
      status: "conflict",
      reason: "terminal_immutable",
    });

    const backToReserved = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 4;
      value.receipt.state = "reserved";
      value.receipt.phaseId = "reservation";
      value.receipt.observedAt = "2026-07-28T18:03:00.000Z";
      value.receipt.startedAt = null;
      value.receipt.heartbeat = null;
      value.receipt.progress = null;
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, backToReserved)).toEqual({
      status: "conflict",
      reason: "state_transition",
    });

    const reversedTime = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 4;
      value.receipt.observedAt = "2026-07-28T18:01:00.000Z";
      value.receipt.heartbeat = {
        intervalSeconds: 60,
        leaseExpiresAt: "2026-07-28T18:04:00.000Z",
      };
    }));
    expect(compareSmolRunnerReceiptTransitions(progress, reversedTime)).toEqual({
      status: "conflict",
      reason: "observation_time",
    });
  });

  test("projects three missed heartbeats as stalled without misclassifying named waits", () => {
    const progress = parseSmolRunnerReceiptIntake(progressFixture);
    expect(projectSmolRunnerReceiptLiveness(progress, "2026-07-28T18:04:59.999Z"))
      .toEqual({ state: "active", stalledAt: "2026-07-28T18:05:00.000Z" });
    expect(projectSmolRunnerReceiptLiveness(progress, "2026-07-28T18:05:00.000Z"))
      .toEqual({ state: "stalled", stalledAt: "2026-07-28T18:05:00.000Z" });

    const externalWait = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 4;
      value.receipt.state = "waiting_external";
      value.receipt.phaseId = "hosted-ci";
      value.receipt.observedAt = "2026-07-28T18:04:00.000Z";
      value.receipt.heartbeat = null;
      value.receipt.progress = null;
      value.receipt.outcome.nextAction = "wait_external";
    }));
    expect(projectSmolRunnerReceiptLiveness(externalWait, "2026-07-29T18:04:00.000Z"))
      .toEqual({ state: "waiting_external" });

    const continuation = parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.checkpointGeneration = 4;
      value.receipt.state = "continuation_required";
      value.receipt.phaseId = "fresh-host-observation";
      value.receipt.observedAt = "2026-07-28T18:04:00.000Z";
      value.receipt.heartbeat = null;
      value.receipt.progress = null;
      value.receipt.outcome.disposition = "continuation_required";
      value.receipt.outcome.freshObservationRequired = true;
      value.receipt.outcome.continuationBarriers = ["fresh-host-observation"];
      value.receipt.outcome.nextAction = "fresh_observation";
    }));
    expect(projectSmolRunnerReceiptLiveness(continuation, "2026-07-29T18:04:00.000Z"))
      .toEqual({ state: "continuation_required" });
  });

  test("rejects cross-boundary identity drift and private or authority-bearing fields", () => {
    for (const mutation of [
      (value: SmolRunnerReceiptIntake) => { value.receipt.repository = "other/repository"; },
      (value: SmolRunnerReceiptIntake) => { value.receipt.profileId = "quarry.pre-ready"; },
      (value: SmolRunnerReceiptIntake) => { value.receipt.runnerProfileId = "quarry.pre-ready"; },
      (value: SmolRunnerReceiptIntake) => { value.receipt.workspaceReceiptRef = "smolrunner:workspace:other"; },
      (value: SmolRunnerReceiptIntake) => { value.receipt.source.commit = "ffffffffffffffffffffffffffffffffffffffff"; },
    ]) {
      expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, mutation))).toThrow();
    }

    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      (value.receipt as unknown as Record<string, unknown>).privatePath = "/home/operator/private";
    }))).toThrow();
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      (value.receipt.outcome as unknown as Record<string, unknown>).stdout = "raw stdout";
    }))).toThrow();
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      (value.receipt.authority as Record<string, boolean>).merge = true;
    }))).toThrow();
  });

  test("rejects inconsistent receipt states, unsafe references, and unbounded progress", () => {
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.outcome.disposition = "succeeded";
    }))).toThrow();
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.heartbeat = null;
    }))).toThrow();
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.progress = { completed: 13, total: 12, unit: "actions" };
    }))).toThrow();
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.receipt.evidence.logRef = "/home/operator/private/log.txt";
    }))).toThrow();
    expect(() => parseSmolRunnerReceiptIntake(modify(progressFixture, (value) => {
      value.attempt.requestedBase = "refs/heads/../../private";
    }))).toThrow();
  });
});

function fixture(name: string): SmolRunnerReceiptIntake {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as SmolRunnerReceiptIntake;
}

function modify(
  input: SmolRunnerReceiptIntake,
  mutation: (value: SmolRunnerReceiptIntake) => void,
): SmolRunnerReceiptIntake {
  const output = structuredClone(input);
  mutation(output);
  return output;
}

function reverseObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseObject(entry)]),
  );
}
