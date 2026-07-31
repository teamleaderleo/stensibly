import { describe, expect, test } from "bun:test";
import {
  GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
  compileGitHubActionsCiReceiptV1,
  type GitHubActionsCiReceiptBundleV1,
  type GitHubActionsCompletedJobV1,
  type GitHubActionsCompletedStepV1,
} from "../src/github-actions-ci-receipt.ts";

const candidate = "a".repeat(40);
const base = "b".repeat(40);
const workflow = "c".repeat(40);
const newer = "d".repeat(40);
const diagnostics = `sha256:${"e".repeat(64)}`;

function step(
  number: number,
  name: string,
  conclusion: GitHubActionsCompletedStepV1["conclusion"] = "success",
): GitHubActionsCompletedStepV1 {
  return { number, name, status: "completed", conclusion };
}

function job(
  name: GitHubActionsCompletedJobV1["name"],
  conclusion: GitHubActionsCompletedJobV1["conclusion"],
  overrides: Partial<GitHubActionsCompletedJobV1> = {},
): GitHubActionsCompletedJobV1 {
  const noStart = [
    "skipped", "action_required", "stale", "startup_failure",
  ].includes(conclusion);
  return {
    id: name === "test" ? 10 : name === "runtime-parity" ? 20 : 30,
    runId: 30638086970,
    runAttempt: 1,
    headSha: candidate,
    workflowName: "CI",
    name,
    status: "completed",
    conclusion,
    createdAt: "2026-07-31T10:00:01Z",
    startedAt: noStart ? null : "2026-07-31T10:02:00Z",
    completedAt: noStart
      ? "2026-07-31T10:00:03Z"
      : "2026-07-31T10:20:00Z",
    labels: ["ubuntu-latest"],
    steps: noStart ? [] : [step(1, "Set up job"), step(2, "Run gate")],
    ...overrides,
  };
}

function bundle(
  overrides: Partial<GitHubActionsCiReceiptBundleV1> = {},
): GitHubActionsCiReceiptBundleV1 {
  return {
    version: GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
    repository: "teamleaderleo/stensibly",
    receivedAt: "2026-07-31T10:31:00Z",
    workflowRevision: workflow,
    validationProfile: "full_parallel",
    run: {
      id: 30638086970,
      attempt: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      headSha: candidate,
      createdAt: "2026-07-31T10:00:00Z",
      completedAt: "2026-07-31T10:30:00Z",
      pullRequests: [{ number: 704, headSha: candidate, baseSha: base }],
    },
    jobs: [
      job("test", "success"),
      job("runtime-parity", "success", {
        startedAt: "2026-07-31T10:01:00Z",
        completedAt: "2026-07-31T10:05:00Z",
      }),
      job("serial-full", "skipped"),
    ],
    diagnosticsArtifacts: [],
    ...overrides,
  };
}

function compile(input: GitHubActionsCiReceiptBundleV1 = bundle()) {
  return compileGitHubActionsCiReceiptV1(
    input,
    () => new Date(input.receivedAt),
  );
}

function failedBundle(
  artifacts: GitHubActionsCiReceiptBundleV1["diagnosticsArtifacts"] = [],
): GitHubActionsCiReceiptBundleV1 {
  return bundle({
    run: { ...bundle().run, conclusion: "failure" },
    jobs: [
      job("test", "failure", {
        steps: [step(1, "Set up job"), step(2, "Run Bun tests", "failure")],
      }),
      job("runtime-parity", "success"),
      job("serial-full", "skipped"),
    ],
    diagnosticsArtifacts: artifacts,
  });
}

describe("signed GitHub Actions CI receipt compiler", () => {
  test("binds independent workflow bytes and exact queue evidence", () => {
    const receipt = compile();
    expect(receipt).toMatchObject({
      workflowRunId: 30638086970,
      workflowAttempt: 1,
      event: "pull_request",
      pullRequestNumber: 704,
      candidateRevision: candidate,
      baseRevision: base,
      workflowRevision: workflow,
      validationProfile: "full_parallel",
      validationProfileState: "reviewed",
      concurrencyGroup: "ci-teamleaderleo/stensibly-pr-704",
      firstJobStartedAt: "2026-07-31T10:01:00.000Z",
      queueWaitMs: 60_000,
      durationMs: 1_800_000,
      supersededByRevision: null,
      queuePosition: "unknown",
      authorizesMerge: false,
      authorizesMutation: false,
    });
    expect(receipt.jobs.find((entry) => entry.name === "runtime-parity"))
      .toMatchObject({
        queuedAt: "2026-07-31T10:00:01.000Z",
        queueWaitMs: 59_000,
      });
    expect(compile(bundle({ workflowRevision: newer })).receiptFingerprint)
      .not.toBe(receipt.receiptFingerprint);
  });

  test("binds diagnostics to the exact run attempt and failed job", () => {
    const artifact = {
      workflowRunId: 30638086970,
      workflowRunAttempt: 1,
      workflowJobId: 10,
      name: "diagnostics" as const,
      digest: diagnostics,
    };
    const receipt = compile(failedBundle([artifact]));
    expect(receipt.jobs.find((entry) => entry.name === "test"))
      .toMatchObject({
        failedStep: "Run Bun tests",
        diagnosticsFingerprint: diagnostics,
      });

    expect(() => compile(failedBundle([{ ...artifact, workflowRunAttempt: 2 }])))
      .toThrow("another run attempt");
    expect(() => compile(failedBundle([{ ...artifact, workflowJobId: 20 }])))
      .toThrow("another workflow job");
    expect(() => compile(bundle({ diagnosticsArtifacts: [artifact] })))
      .toThrow("requires its failed canonical job");
  });

  test("rejects failed steps hidden under a non-failed job", () => {
    expect(() => compile(bundle({
      jobs: [
        job("test", "success", {
          steps: [step(1, "continued failure", "failure")],
        }),
        job("runtime-parity", "success"),
        job("serial-full", "skipped"),
      ],
    }))).toThrow("non-failed job cannot contain a failed step");
  });

  test("records cancellation without inventing supersession causality", () => {
    const input = bundle({
      run: { ...bundle().run, conclusion: "cancelled" },
      jobs: [
        job("test", "cancelled", {
          startedAt: null,
          completedAt: "2026-07-31T10:04:00Z",
          steps: [],
        }),
        job("runtime-parity", "cancelled", {
          startedAt: null,
          completedAt: "2026-07-31T10:04:00Z",
          steps: [],
        }),
        job("serial-full", "skipped"),
      ],
    });
    const receipt = compile(input);
    expect(receipt).toMatchObject({
      conclusion: "cancelled",
      supersededByRevision: null,
      firstJobStartedAt: null,
      queueWaitMs: null,
    });

    const arbitrary = { ...input, supersededByRevision: newer };
    expect(() => compileGitHubActionsCiReceiptV1(
      arbitrary,
      () => new Date(input.receivedAt),
    )).toThrow("contains unknown fields");
  });

  test("requires zero steps for every job that never started", () => {
    expect(() => compile(bundle({
      jobs: [
        job("test", "success"),
        job("runtime-parity", "success"),
        job("serial-full", "skipped", {
          steps: [step(1, "Skipped setup", "skipped")],
        }),
      ],
    }))).toThrow("unstarted job cannot contain completed steps");

    expect(() => compile(bundle({
      run: { ...bundle().run, conclusion: "cancelled" },
      jobs: [
        job("test", "cancelled", {
          startedAt: null,
          completedAt: "2026-07-31T10:04:00Z",
          steps: [step(1, "Cancelled setup", "cancelled")],
        }),
        job("runtime-parity", "cancelled", {
          startedAt: null,
          completedAt: "2026-07-31T10:04:00Z",
          steps: [],
        }),
        job("serial-full", "skipped"),
      ],
    }))).toThrow("unstarted job cannot contain completed steps");

    const afterStart = compile(bundle({
      run: { ...bundle().run, conclusion: "cancelled" },
      jobs: [
        job("test", "cancelled", {
          steps: [step(1, "Set up job"), step(2, "Cancellation received", "cancelled")],
        }),
        job("runtime-parity", "cancelled", {
          steps: [step(1, "Set up job"), step(2, "Cancellation received", "cancelled")],
        }),
        job("serial-full", "skipped"),
      ],
    }));
    expect(afterStart.jobs.filter((entry) => entry.conclusion === "cancelled"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ startedAt: "2026-07-31T10:02:00.000Z" }),
      ]));
  });

  test("compiles the opt-in serial exact-ref topology", () => {
    const input = bundle({
      workflowRevision: candidate,
      validationProfile: "serial_full",
      run: {
        ...bundle().run,
        event: "workflow_dispatch",
        headSha: candidate,
        pullRequests: [],
      },
      jobs: [
        job("test", "skipped"),
        job("runtime-parity", "skipped"),
        job("serial-full", "success", {
          startedAt: "2026-07-31T10:01:30Z",
          completedAt: "2026-07-31T10:28:00Z",
        }),
      ],
    });
    expect(compile(input)).toMatchObject({
      event: "workflow_dispatch",
      baseRevision: null,
      workflowRevision: candidate,
      validationProfile: "serial_full",
      concurrencyGroup:
        `ci-teamleaderleo/stensibly-dispatch-${candidate}-serial_full`,
    });
    expect(() => compile({ ...input, workflowRevision: newer }))
      .toThrow("non-pull-request workflow revision must equal the run head");
  });

  test("rejects cross-run, cross-attempt, and topology drift", () => {
    expect(() => compile(bundle({
      jobs: [
        job("test", "success", { runId: 99 }),
        job("runtime-parity", "success"),
        job("serial-full", "skipped"),
      ],
    }))).toThrow("another workflow run");
    expect(() => compile(bundle({
      jobs: [
        job("test", "success", { runAttempt: 2 }),
        job("runtime-parity", "success"),
        job("serial-full", "skipped"),
      ],
    }))).toThrow("another workflow attempt");
    expect(() => compile(bundle({
      jobs: [
        job("test", "success"),
        job("runtime-parity", "success"),
        job("serial-full", "success"),
      ],
    }))).toThrow("serial job to be skipped");
  });

  test("admits benign sk labels and prose while rejecting realistic credentials", () => {
    const benign = bundle({
      repository: "teamleaderleo/task-sk-research",
      run: { ...bundle().run, conclusion: "failure" },
      jobs: [
        job("test", "failure", {
          labels: ["runner-sk-review"],
          steps: [step(1, "Run sk-review checks", "failure")],
        }),
        job("runtime-parity", "success"),
        job("serial-full", "skipped"),
      ],
    });
    const receipt = compile(benign);
    expect(receipt.repository).toBe("teamleaderleo/task-sk-research");
    expect(receipt.jobs.find((entry) => entry.name === "test"))
      .toMatchObject({
        requestedLabels: ["runner-sk-review"],
        failedStep: "Run sk-review checks",
      });

    const secret = `context.github_pat_${"A".repeat(30)}`;
    let error: unknown;
    try {
      compile(bundle({
        run: { ...bundle().run, conclusion: "failure" },
        jobs: [
          job("test", "failure", { steps: [step(1, secret, "failure")] }),
          job("runtime-parity", "success"),
          job("serial-full", "skipped"),
        ],
      }));
    } catch (caught) { error = caught; }
    expect((error as Error).message).toBe("GitHub Actions step name is invalid");
    expect((error as Error).message).not.toContain(secret);
  });

  test("keeps descriptor diagnostics fixed and invokes zero getters", () => {
    let reads = 0;
    const hostile = bundle() as unknown as Record<PropertyKey, unknown>;
    const hostileKey = `credential:github_pat_${"A".repeat(30)}`;
    Object.defineProperty(hostile, hostileKey, {
      enumerable: true,
      get() { reads += 1; return "secret"; },
    });
    let error: unknown;
    try {
      compileGitHubActionsCiReceiptV1(
        hostile,
        () => new Date("2026-07-31T10:31:00Z"),
      );
    } catch (caught) { error = caught; }
    expect((error as Error).message)
      .toBe("GitHub Actions CI receipt bundle contains unknown fields");
    expect((error as Error).message).not.toContain(hostileKey);
    expect(reads).toBe(0);
  });

  test("collapses invalid timestamps to fixed receipt prose", () => {
    expect(() => compile(bundle({ receivedAt: "2026-13-31T10:31:00Z" })))
      .toThrow("GitHub Actions receipt time must be a canonical timestamp");
  });
});
