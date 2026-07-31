import { describe, expect, test } from "bun:test";
import {
  CI_CANONICAL_COMMAND_IDS_V1,
  CI_QUEUE_RECEIPT_V1,
  CI_RUN_CONCLUSIONS,
  CI_RUN_STATUSES,
  CI_VALIDATION_PROFILE_COMMANDS_V1,
  compileCiQueueReceiptV1,
  type CiJobConclusion,
  type CiJobObservationInputV1,
  type CiQueueObservationInputV1,
  type CiRunStatus,
} from "../src/ci-queue-receipt.ts";

const candidate = "a".repeat(40);
const base = "b".repeat(40);
const workflow = "c".repeat(40);
const newer = "d".repeat(40);
const diagnostics = `sha256:${"e".repeat(64)}`;

function waitingJob(status: CiRunStatus = "queued", overrides: Partial<CiJobObservationInputV1> = {}): CiJobObservationInputV1 {
  return {
    jobId: 20,
    name: "test",
    requestedLabels: ["ubuntu-24.04"],
    status,
    conclusion: null,
    queuedAt: "2026-07-31T10:00:02Z",
    startedAt: null,
    completedAt: null,
    runnerOs: null,
    runnerArch: null,
    runnerImage: null,
    failedStep: null,
    diagnosticsFingerprint: null,
    ...overrides,
  };
}

function completedJob(conclusion: CiJobConclusion, overrides: Partial<CiJobObservationInputV1> = {}): CiJobObservationInputV1 {
  const noStart = ["skipped", "action_required", "stale", "startup_failure"].includes(conclusion);
  return waitingJob("completed", {
    conclusion,
    startedAt: noStart ? null : "2026-07-31T10:12:02Z",
    completedAt: "2026-07-31T10:20:02Z",
    runnerOs: noStart ? null : "Linux",
    runnerArch: noStart ? null : "X64",
    runnerImage: noStart ? null : "ubuntu-24.04",
    failedStep: conclusion === "failure" ? "Run Bun tests" : null,
    diagnosticsFingerprint: conclusion === "failure" ? diagnostics : null,
    ...overrides,
  });
}

function observation(overrides: Partial<CiQueueObservationInputV1> = {}): CiQueueObservationInputV1 {
  return {
    version: CI_QUEUE_RECEIPT_V1,
    repository: "teamleaderleo/stensibly",
    workflowName: "CI",
    workflowRunId: 30601889193,
    workflowAttempt: 1,
    event: "pull_request",
    pullRequestNumber: 704,
    candidateRevision: candidate,
    baseRevision: base,
    workflowRevision: workflow,
    validationProfile: "full_parallel",
    commandIds: [...CI_CANONICAL_COMMAND_IDS_V1],
    concurrencyGroup: "ci-pr-704",
    supersededByRevision: null,
    createdAt: "2026-07-31T10:00:00Z",
    observedAt: "2026-07-31T10:15:00Z",
    completedAt: null,
    status: "queued",
    conclusion: null,
    jobs: [waitingJob()],
    ...overrides,
  };
}

function completedRun(conclusion: CiJobConclusion, jobs: CiJobObservationInputV1[], overrides: Partial<CiQueueObservationInputV1> = {}): CiQueueObservationInputV1 {
  return observation({
    observedAt: "2026-07-31T10:31:00Z",
    completedAt: "2026-07-31T10:30:00Z",
    status: "completed",
    conclusion,
    jobs,
    ...overrides,
  });
}

function compile(input: CiQueueObservationInputV1 = observation()) {
  return compileCiQueueReceiptV1(input, () => new Date(input.observedAt));
}

describe("CI queue receipt", () => {
  test("admits every provider status and preserves bounded waiting reasons", () => {
    const reasons = {
      requested: "workflow_request",
      waiting: "deployment_protection",
      pending: "concurrency_limit",
      queued: "unknown",
    } as const;
    for (const [status, reason] of Object.entries(reasons) as [keyof typeof reasons, string][]) {
      const receipt = compile(observation({ status, jobs: [waitingJob(status)] }));
      expect(receipt).toMatchObject({
        status,
        awaitingExecutionStart: true,
        queueReason: reason,
        queuePosition: "unknown",
        observedQueueAgeMs: 15 * 60 * 1_000,
      });
    }
    const inProgress = compile(observation({ status: "in_progress", jobs: [waitingJob("pending")] }));
    expect(inProgress.firstJobStartedAt).toBeNull();
    expect(inProgress.awaitingExecutionStart).toBe(true);
    expect(inProgress.queueReason).toBe("unknown");
    expect(CI_RUN_STATUSES).toEqual(["requested", "waiting", "pending", "queued", "in_progress", "completed"]);
  });

  test("derives queue waits and durations from canonical timestamps", () => {
    const receipt = compile(completedRun("success", [
      completedJob("success", { jobId: 20, requestedLabels: ["x64", "ubuntu-24.04"] }),
      completedJob("success", {
        jobId: 10,
        name: "runtime-parity",
        requestedLabels: ["ubuntu-24.04", "x64"],
        queuedAt: "2026-07-31T10:00:03Z",
        startedAt: "2026-07-31T10:12:03Z",
        completedAt: "2026-07-31T10:30:00Z",
      }),
    ]));
    expect(receipt.jobs.map((job) => job.jobId)).toEqual([10, 20]);
    expect(receipt.jobs[0]?.requestedLabels).toEqual(["ubuntu-24.04", "x64"]);
    expect(receipt).toMatchObject({
      firstJobStartedAt: "2026-07-31T10:12:02.000Z",
      queueWaitMs: 12 * 60 * 1_000 + 2_000,
      durationMs: 30 * 60 * 1_000,
      awaitingExecutionStart: false,
      observedQueueAgeMs: null,
      queueReason: null,
    });
    expect(receipt.jobs[0]?.durationMs).toBe(17 * 60 * 1_000 + 57_000);
  });

  test("admits every terminal conclusion with compatible skipped and no-start work", () => {
    const fixtures = [
      completedRun("success", [completedJob("success", { jobId: 1, name: "matrix" }), completedJob("skipped", { jobId: 2, name: "matrix" })]),
      completedRun("failure", [completedJob("failure", { jobId: 1 }), completedJob("skipped", { jobId: 2 })]),
      completedRun("cancelled", [completedJob("success", { jobId: 1 }), completedJob("cancelled", { jobId: 2 }), completedJob("skipped", { jobId: 3 })]),
      completedRun("neutral", [completedJob("neutral")]),
      completedRun("skipped", [completedJob("skipped")]),
      completedRun("timed_out", [completedJob("timed_out")]),
      completedRun("action_required", []),
      completedRun("stale", [completedJob("stale")]),
      completedRun("startup_failure", []),
    ];
    expect(fixtures.map((fixture) => compile(fixture).conclusion)).toEqual([...CI_RUN_CONCLUSIONS]);
    for (const conclusion of ["skipped", "action_required", "stale", "startup_failure"] as const) {
      const job = compile(completedRun(conclusion, [completedJob(conclusion)])).jobs[0];
      expect(job).toMatchObject({ conclusion, startedAt: null, runnerOs: null, failedStep: null });
    }
  });

  test("keeps display names presentational and job IDs unique", () => {
    const receipt = compile(completedRun("success", [
      completedJob("success", { jobId: 10, name: "test (ubuntu)" }),
      completedJob("skipped", { jobId: 11, name: "test (ubuntu)" }),
    ]));
    expect(receipt.jobs.map((job) => job.name)).toEqual(["test (ubuntu)", "test (ubuntu)"]);
    expect(() => compile(completedRun("success", [
      completedJob("success", { jobId: 10 }), completedJob("skipped", { jobId: 10 }),
    ]))).toThrow("unique job IDs");
  });

  test("binds reviewed profiles to one canonical ordered gate contract", () => {
    expect(CI_VALIDATION_PROFILE_COMMANDS_V1.full_parallel).toBe(CI_CANONICAL_COMMAND_IDS_V1);
    expect(CI_VALIDATION_PROFILE_COMMANDS_V1.serial_full).toBe(CI_CANONICAL_COMMAND_IDS_V1);
    expect(compile().validationProfileState).toBe("reviewed");
    const unreviewed = compile(observation({ validationProfile: "experimental_v2", commandIds: ["custom-gate"] }));
    expect(unreviewed.validationProfileState).toBe("unreviewed");
    expect(() => compile(observation({ validationProfile: "serial_full", commandIds: ["typecheck"] })))
      .toThrow("canonical command IDs");
  });

  test("requires one exact trusted observation-time attestation", () => {
    const input = observation();
    let reads = 0;
    expect(compileCiQueueReceiptV1(input, () => { reads += 1; return new Date(input.observedAt); }).observedAt)
      .toBe("2026-07-31T10:15:00.000Z");
    expect(reads).toBe(1);
    const message = "CI trusted observation clock did not attest the observation time";
    expect(() => compileCiQueueReceiptV1(input, () => { throw new Error("github_pat_private"); })).toThrow(message);
    expect(() => compileCiQueueReceiptV1(input, () => new Date(Number.NaN))).toThrow(message);
    expect(() => compileCiQueueReceiptV1(input, () => new Date("2026-07-31T10:14:59Z"))).toThrow(message);
  });

  test("requires lowercase identity and rejects credential-shaped identifiers", () => {
    expect(() => compile(observation({ repository: "TeamLeaderLeo/Stensibly" }))).toThrow("exact lowercase identity");
    for (const validationProfile of [
      "profile:github_pat_private", "profile:ghp_private", "profile:stn.tok_private",
      "profile:sk-proj-private", "profile:xoxb-private", "profile:secret://private",
    ]) {
      expect(() => compile(observation({ validationProfile, commandIds: ["custom-gate"] })))
        .toThrow("CI validation profile is invalid");
    }
    expect(() => compile(observation({ validationProfile: "experimental_v2", commandIds: ["gate:github_pat_private"] })))
      .toThrow("CI validation command IDs is invalid");
    expect(() => compile(observation({ jobs: [waitingJob("queued", { requestedLabels: ["runner:ghp_private"] })] })))
      .toThrow("CI requested runner labels is invalid");
  });

  test("keeps hostile diagnostics fixed and never invokes getters", () => {
    const hostileKey = "credential:github_pat_private";
    let reads = 0;
    const hostile = observation() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, hostileKey, { enumerable: true, get() { reads += 1; return "secret"; } });
    let error: unknown;
    try { compileCiQueueReceiptV1(hostile, () => new Date("2026-07-31T10:15:00Z")); } catch (caught) { error = caught; }
    expect((error as Error).message).toBe("CI queue observation contains unknown fields");
    expect((error as Error).message).not.toContain(hostileKey);
    expect(reads).toBe(0);
    const accessor = observation() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(accessor, "observedAt", { enumerable: true, get() { reads += 1; return "2026-07-31T10:15:00Z"; } });
    expect(() => compileCiQueueReceiptV1(accessor, () => new Date("2026-07-31T10:15:00Z")))
      .toThrow("fields must be enumerable data properties");
    expect(reads).toBe(0);
  });

  test("rejects decorated, sparse, symbolic, and out-of-range arrays before reads", () => {
    const symbolic = [waitingJob()] as unknown as Record<PropertyKey, unknown>;
    symbolic[Symbol("secret")] = true;
    expect(() => compile(observation({ jobs: symbolic as unknown as CiJobObservationInputV1[] }))).toThrow("unsupported fields");
    const decorated = [waitingJob()] as CiJobObservationInputV1[] & { authority?: boolean };
    decorated.authority = true;
    expect(() => compile(observation({ jobs: decorated }))).toThrow("unsupported fields");
    const sparse: CiJobObservationInputV1[] = []; sparse.length = 1;
    expect(() => compile(observation({ jobs: sparse }))).toThrow("dense");
    let reads = 0;
    const outOfRange = [waitingJob()];
    Object.defineProperty(outOfRange, "4294967295", { get() { reads += 1; return "secret"; } });
    expect(() => compile(observation({ jobs: outOfRange }))).toThrow("unsupported fields");
    expect(reads).toBe(0);
  });

  test("binds revisions, profile, timing, supersession, and zero authority", () => {
    const first = compile();
    expect(first.receiptFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.authorizesMerge).toBe(false);
    expect(first.authorizesMutation).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.receiptFingerprint).not.toBe(compile(observation({ candidateRevision: newer })).receiptFingerprint);
    expect(first.receiptFingerprint).not.toBe(compile(observation({ workflowRevision: newer })).receiptFingerprint);
    expect(first.receiptFingerprint).not.toBe(compile(observation({ observedAt: "2026-07-31T10:16:00Z" })).receiptFingerprint);
    expect(compile(completedRun("cancelled", [completedJob("cancelled")], { supersededByRevision: newer })).supersededByRevision).toBe(newer);
    expect(() => compile(completedRun("success", [completedJob("success")], { supersededByRevision: newer })))
      .toThrow("superseded CI run must be completed as cancelled");
  });

  test("rejects contradictory timing, runner, diagnostics, and compatibility evidence", () => {
    expect(() => compile(observation({ status: "queued", conclusion: "success" }))).toThrow("status and conclusion are inconsistent");
    expect(() => compile(observation({ jobs: [waitingJob("queued", { queuedAt: "2026-07-31T09:59:59Z" })] }))).toThrow("queue time is outside");
    expect(() => compile(observation({ jobs: [waitingJob("queued", { runnerOs: "Linux" })] }))).toThrow("Unstarted CI jobs");
    expect(() => compile(completedRun("success", [completedJob("failure")]))).toThrow("incompatible with its job conclusions");
    expect(() => compile(completedRun("failure", [completedJob("skipped")]))).toThrow("require a failed job");
    expect(() => compile(completedRun("timed_out", [completedJob("cancelled")]))).toThrow("require a timed-out job");
    expect(() => compile(completedRun("action_required", [completedJob("skipped")]))).toThrow("require action-required job evidence");
    expect(() => compile(completedRun("stale", [completedJob("skipped")]))).toThrow("require stale job evidence");
    expect(() => compile(completedRun("timed_out", [completedJob("timed_out", { failedStep: "Unknown timeout" })])))
      .toThrow("Only failed CI jobs may carry failure diagnostics");
  });
});
