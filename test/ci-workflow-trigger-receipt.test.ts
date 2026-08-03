import { describe, expect, test } from "bun:test";
import {
  CI_WORKFLOW_TRIGGER_RECEIPT_V1,
  compileCiWorkflowTriggerReceiptV1,
  type CiWorkflowTriggerObservationInputV1,
} from "../src/ci-workflow-trigger-receipt.ts";

const candidate = "a".repeat(40);
const workflow = "b".repeat(40);

function observation(
  overrides: Partial<CiWorkflowTriggerObservationInputV1> = {},
): CiWorkflowTriggerObservationInputV1 {
  return {
    version: CI_WORKFLOW_TRIGGER_RECEIPT_V1,
    repository: "teamleaderleo/stensibly",
    workflowId: 319014676,
    workflowRevision: workflow,
    candidateRevision: candidate,
    event: "pull_request",
    pullRequestNumber: 950,
    observedAt: "2026-08-02T16:30:00Z",
    lookupComplete: true,
    runs: [],
    ...overrides,
  };
}

function compile(input = observation()) {
  return compileCiWorkflowTriggerReceiptV1(
    input,
    () => new Date(input.observedAt),
  );
}

describe("CI workflow trigger receipt", () => {
  test("records a complete empty lookup without inferring trigger absence", () => {
    const receipt = compile();

    expect(receipt.triggerState).toBe("run_not_observed");
    expect(receipt.lookupComplete).toBe(true);
    expect(receipt.runs).toEqual([]);
    expect(receipt.receiptFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(receipt.authorizesMerge).toBe(false);
    expect(receipt.authorizesMutation).toBe(false);
    expect(receipt.authorizesRetry).toBe(false);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.runs)).toBe(true);
  });

  test("allows a later run observation after a complete empty lookup", () => {
    const first = compile(observation({
      observedAt: "2026-08-02T16:30:00Z",
      lookupComplete: true,
      runs: [],
    }));
    const later = compile(observation({
      observedAt: "2026-08-02T16:30:01Z",
      lookupComplete: true,
      runs: [{ runId: 30756269305, attempt: 1 }],
    }));

    expect(first.triggerState).toBe("run_not_observed");
    expect(later.triggerState).toBe("run_observed");
    expect(first.candidateRevision).toBe(later.candidateRevision);
    expect(first.workflowRevision).toBe(later.workflowRevision);
    expect(first.receiptFingerprint).not.toBe(later.receiptFingerprint);
  });

  test("keeps incomplete empty lookup coverage unknown", () => {
    const receipt = compile(observation({ lookupComplete: false }));

    expect(receipt.triggerState).toBe("provider_state_unknown");
    expect(receipt.receiptFingerprint).not.toBe(compile().receiptFingerprint);
  });

  test("records exact run-attempt references without inferring queue state", () => {
    const receipt = compile(observation({
      lookupComplete: false,
      runs: [
        { runId: 30756269305, attempt: 2 },
        { runId: 30756269305, attempt: 1 },
      ],
    }));

    expect(receipt.triggerState).toBe("run_observed");
    expect(receipt.runs).toEqual([
      { runId: 30756269305, attempt: 1 },
      { runId: 30756269305, attempt: 2 },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("queued");
  });

  test("rejects duplicate run-attempt identity and oversized lookups", () => {
    expect(() => compile(observation({
      runs: [
        { runId: 1, attempt: 1 },
        { runId: 1, attempt: 1 },
      ],
    }))).toThrow("unique run-attempt identities");

    expect(() => compile(observation({
      runs: Array.from({ length: 33 }, (_, index) => ({
        runId: index + 1,
        attempt: 1,
      })),
    }))).toThrow("outside the accepted range");
  });

  test("matches landed CI numeric identity bounds", () => {
    const receipt = compile(observation({
      pullRequestNumber: 2_147_483_647,
      runs: [{
        runId: Number.MAX_SAFE_INTEGER,
        attempt: 1_000_000,
      }],
    }));
    expect(receipt.pullRequestNumber).toBe(2_147_483_647);
    expect(receipt.runs).toEqual([{
      runId: Number.MAX_SAFE_INTEGER,
      attempt: 1_000_000,
    }]);

    expect(() => compile(observation({
      pullRequestNumber: 2_147_483_648,
    }))).toThrow("positive safe integer");
    expect(() => compile(observation({
      runs: [{ runId: 1, attempt: 1_000_001 }],
    }))).toThrow("positive safe integer");
  });

  test("binds event and pull-request identity exactly", () => {
    expect(() => compile(observation({ pullRequestNumber: null })))
      .toThrow("requires a pull request number");
    expect(() => compile(observation({ event: "push", pullRequestNumber: 950 })))
      .toThrow("Only pull-request");
    expect(() => compile(observation({ candidateRevision: "ABC" })))
      .toThrow("candidate revision");
    expect(() => compile(observation({ repository: "TeamLeaderLeo/Stensibly" })))
      .toThrow("exact lowercase");
  });

  test("matches the landed CI repository identity domain", () => {
    expect(compile(observation({
      repository: `${"a".repeat(39)}/repo.name-_`,
    })).repository).toBe(`${"a".repeat(39)}/repo.name-_`);

    for (const repository of [
      "owner.name/repo",
      "owner_name/repo",
      "owner-/repo",
      `${"a".repeat(40)}/repo`,
      "owner--name/repo",
      "owner/github_pat_secret",
      " owner/repo",
    ]) {
      expect(() => compile(observation({ repository }))).toThrow(
        "CI trigger repository",
      );
    }
  });

  test("requires one matching trusted observation-time reading", () => {
    const input = observation();
    let reads = 0;
    const receipt = compileCiWorkflowTriggerReceiptV1(input, () => {
      reads += 1;
      return new Date(input.observedAt);
    });
    expect(receipt.observedAt).toBe("2026-08-02T16:30:00.000Z");
    expect(reads).toBe(1);

    const message = "CI trigger trusted observation clock did not attest the observation time";
    expect(() => compileCiWorkflowTriggerReceiptV1(input, () => {
      throw new Error("github_pat_secret_should_not_escape");
    })).toThrow(message);
    expect(() => compileCiWorkflowTriggerReceiptV1(
      input,
      () => new Date("2026-08-02T16:29:59Z"),
    )).toThrow(message);
  });

  test("rejects hostile descriptors without invoking accessors", () => {
    let reads = 0;
    const hostile = observation() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, "runs", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("github_pat_secret_should_not_escape");
      },
    });

    expect(() => compileCiWorkflowTriggerReceiptV1(
      hostile,
      () => new Date("2026-08-02T16:30:00Z"),
    )).toThrow("enumerable data properties");
    expect(reads).toBe(0);

    const hostileRuns: unknown[] = [];
    Object.defineProperty(hostileRuns, "0", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("github_pat_secret_should_not_escape");
      },
    });
    hostileRuns.length = 1;
    expect(() => compile(observation({
      runs: hostileRuns as CiWorkflowTriggerObservationInputV1["runs"],
    }))).toThrow("dense data properties");
    expect(reads).toBe(0);
  });

  test("detaches accepted evidence from producer mutation", () => {
    const runs = [{ runId: 7, attempt: 1 }];
    const receipt = compile(observation({ runs }));

    runs[0]!.attempt = 2;
    runs.push({ runId: 8, attempt: 1 });

    expect(receipt.runs).toEqual([{ runId: 7, attempt: 1 }]);
  });
});
