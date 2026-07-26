import { describe, expect, test } from "bun:test";
import {
  checkModel,
  checkModelWithFaultForTest,
  parseClaimRunConfig,
} from "../model/claim-run/check.js";

const bounds = {
  maxDepth: 8,
  maxTime: 4,
  recoveryHorizonTicks: 4,
};

describe("bounded claim/run lifecycle model", () => {
  test("checks fences, duplicate delivery, recovery, and #250 negative controls", () => {
    const report = checkModel(bounds);

    expect(report.exploration).toEqual({
      reachableStates: 3_652,
      exploredTransitions: 9_195,
      maximumDepthReached: 8,
    });
    expect(Object.keys(report.invariants).sort()).toEqual([
      "coherent_claim",
      "coherent_run",
      "completion_cancel_exclusive",
      "current_dispatch_authority_exact_claim_generation",
      "duplicate_delivery_at_most_one_effect",
      "expired_authority_no_effect",
      "missing_expiry_never_grants_authority",
      "stale_claim_fence_no_effect",
      "stale_run_fence_no_effect",
      "terminal_run_no_regression",
    ]);
    expect(Object.keys(report.boundedLiveness).sort()).toEqual([
      "expired_claim_reclaimable",
      "expired_run_abandonable",
      "queued_run_reaches_terminal_or_abandoned_within_recovery_horizon",
    ]);

    const [stale, missingLease] = report.negativeControls;
    expect(stale).toMatchObject({
      kind: "stale_same_actor_generation",
      reachable: true,
      trace: [
        "acquire:supervisor-a:runner-a",
        "dispatch:supervisor-a:runner-a:cg1",
        "release:runner-a:g1",
        "acquire:supervisor-a:runner-a",
      ],
      state: {
        claimHolder: "runner-a",
        claimGeneration: 3,
        runActor: "runner-a",
        runClaimGeneration: 1,
        runStatus: "queued",
      },
    });
    expect(missingLease).toMatchObject({
      kind: "missing_run_lease",
      reachable: false,
      trace: [
        "acquire:supervisor-a:runner-a",
        "dispatch:supervisor-a:runner-a:cg1",
        "synthesized-legacy-state:drop-run-lease-expiry",
      ],
      state: {
        runStatus: "queued",
        runLeaseExpiresAt: null,
      },
    });
  });

  test("rejects invalid explicit bounds and malformed configuration", () => {
    expect(() => checkModel({ ...bounds, maxDepth: 0 })).toThrow(
      "maxDepth bound",
    );
    expect(() => checkModel({ ...bounds, maxTime: 21 })).toThrow(
      "maxTime bound",
    );
    expect(() => checkModel({
      ...bounds,
      recoveryHorizonTicks: 0,
    })).toThrow("recoveryHorizonTicks bound");

    expect(() => parseClaimRunConfig({
      schemaVersion: 2,
      ...bounds,
    })).toThrow("schemaVersion");
    expect(() => parseClaimRunConfig({
      schemaVersion: 1,
      ...bounds,
      unexpected: true,
    })).toThrow("unknown config key unexpected");
    expect(() => parseClaimRunConfig({
      schemaVersion: 1,
      ...bounds,
      maxDepth: 40,
    })).toThrow("maxDepth bound");
  });

  test("fails when the authority rule is deliberately weakened", () => {
    expect(() => checkModelWithFaultForTest(
      "actor_only_authority",
      bounds,
    )).toThrow("authority accepted");
  });
});
