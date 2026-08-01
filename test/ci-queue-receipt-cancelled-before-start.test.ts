import { describe, expect, test } from "bun:test";
import {
  CI_CANONICAL_COMMAND_IDS_V1,
  CI_QUEUE_RECEIPT_V1,
  compileCiQueueReceiptV1,
  type CiQueueObservationInputV1,
} from "../src/ci-queue-receipt.ts";

const candidate = "a".repeat(40);
const base = "b".repeat(40);
const workflow = "c".repeat(40);
const newer = "d".repeat(40);

describe("CI queue receipt cancellation before runner assignment", () => {
  test("preserves a superseded queued job as cancelled with no start evidence", () => {
    const input: CiQueueObservationInputV1 = {
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
      concurrencyGroup: "ci-teamleaderleo/stensibly-pr-704",
      supersededByRevision: newer,
      createdAt: "2026-07-31T10:00:00Z",
      observedAt: "2026-07-31T10:05:00Z",
      completedAt: "2026-07-31T10:04:00Z",
      status: "completed",
      conclusion: "cancelled",
      jobs: [{
        jobId: 20,
        name: "test",
        requestedLabels: ["ubuntu-latest"],
        status: "completed",
        conclusion: "cancelled",
        queuedAt: "2026-07-31T10:00:02Z",
        startedAt: null,
        completedAt: "2026-07-31T10:03:00Z",
        runnerOs: null,
        runnerArch: null,
        runnerImage: null,
        failedStep: null,
        diagnosticsFingerprint: null,
      }],
    };

    const receipt = compileCiQueueReceiptV1(
      input,
      () => new Date(input.observedAt),
    );

    expect(receipt).toMatchObject({
      conclusion: "cancelled",
      supersededByRevision: newer,
      firstJobStartedAt: null,
      queueWaitMs: null,
      authorizesMerge: false,
      authorizesMutation: false,
    });
    expect(receipt.jobs[0]).toMatchObject({
      conclusion: "cancelled",
      startedAt: null,
      queueWaitMs: null,
      durationMs: null,
    });
  });

  test("continues to admit cancellation after execution started", () => {
    const input: CiQueueObservationInputV1 = {
      version: CI_QUEUE_RECEIPT_V1,
      repository: "teamleaderleo/stensibly",
      workflowName: "CI",
      workflowRunId: 30601889194,
      workflowAttempt: 1,
      event: "push",
      pullRequestNumber: null,
      candidateRevision: candidate,
      baseRevision: null,
      workflowRevision: candidate,
      validationProfile: "full_parallel",
      commandIds: [...CI_CANONICAL_COMMAND_IDS_V1],
      concurrencyGroup: "ci-teamleaderleo/stensibly-push-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      supersededByRevision: null,
      createdAt: "2026-07-31T10:00:00Z",
      observedAt: "2026-07-31T10:05:00Z",
      completedAt: "2026-07-31T10:04:00Z",
      status: "completed",
      conclusion: "cancelled",
      jobs: [{
        jobId: 21,
        name: "runtime-parity",
        requestedLabels: ["ubuntu-latest"],
        status: "completed",
        conclusion: "cancelled",
        queuedAt: "2026-07-31T10:00:02Z",
        startedAt: "2026-07-31T10:01:00Z",
        completedAt: "2026-07-31T10:03:00Z",
        runnerOs: "Linux",
        runnerArch: "X64",
        runnerImage: "ubuntu-24.04",
        failedStep: null,
        diagnosticsFingerprint: null,
      }],
    };

    expect(compileCiQueueReceiptV1(
      input,
      () => new Date(input.observedAt),
    ).jobs[0]).toMatchObject({
      conclusion: "cancelled",
      startedAt: "2026-07-31T10:01:00.000Z",
      queueWaitMs: 58_000,
      durationMs: 120_000,
    });
  });
});
