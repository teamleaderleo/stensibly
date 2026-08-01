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
const diagnostics = `sha256:${"d".repeat(64)}`;

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
  const id = name === "browser-evidence" ? 10
    : name === "test" ? 20
    : name === "runtime-parity" ? 30
    : 40;
  const noStart = [
    "skipped", "action_required", "stale", "startup_failure",
  ].includes(conclusion);
  return {
    id,
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

function parallelJobs(): GitHubActionsCompletedJobV1[] {
  return [
    job("browser-evidence", "success", {
      startedAt: "2026-07-31T10:00:30Z",
      completedAt: "2026-07-31T10:12:00Z",
    }),
    job("test", "success"),
    job("runtime-parity", "success", {
      startedAt: "2026-07-31T10:01:00Z",
      completedAt: "2026-07-31T10:05:00Z",
    }),
    job("serial-full", "success", {
      startedAt: "2026-07-31T10:03:00Z",
      completedAt: "2026-07-31T10:28:00Z",
    }),
  ];
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
      pullRequests: [{ number: 783, headSha: candidate, baseSha: base }],
    },
    jobs: parallelJobs(),
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

describe("signed GitHub Actions CI receipt compiler", () => {
  test("retains the complete pull-request browser topology and exact queue evidence", () => {
    const receipt = compile();
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.jobs)).toBe(true);
    expect(receipt).toMatchObject({
      workflowRunId: 30638086970,
      workflowAttempt: 1,
      event: "pull_request",
      pullRequestNumber: 783,
      candidateRevision: candidate,
      baseRevision: base,
      workflowRevision: workflow,
      validationProfile: "full_parallel",
      commandIds: expect.arrayContaining([
        "browser-typecheck", "browser-tests", "browser-artifacts",
      ]),
      concurrencyGroup: "ci-teamleaderleo/stensibly-pr-783",
      firstJobStartedAt: "2026-07-31T10:00:30.000Z",
      queueWaitMs: 30_000,
      supersededByRevision: null,
      queuePosition: "unknown",
      authorizesMerge: false,
      authorizesMutation: false,
    });
    expect(receipt.jobs.map((entry) => entry.name)).toEqual([
      "browser-evidence", "test", "runtime-parity", "serial-full",
    ]);
    expect(receipt.jobs.find((entry) => entry.name === "browser-evidence"))
      .toMatchObject({ queuedAt: "2026-07-31T10:00:01.000Z", queueWaitMs: 29_000 });
  });

  test("requires every canonical browser-profile job", () => {
    const missing = bundle() as unknown as { jobs: GitHubActionsCompletedJobV1[] };
    missing.jobs = parallelJobs().filter((entry) => entry.name !== "browser-evidence");
    expect(() => compileGitHubActionsCiReceiptV1(
      missing,
      () => new Date("2026-07-31T10:31:00Z"),
    )).toThrow("between 4 and 4 entries");
  });

  test("records browser-only failure as positive active-profile evidence", () => {
    const input = bundle({
      run: { ...bundle().run, conclusion: "failure" },
      jobs: [
        job("browser-evidence", "failure", {
          steps: [step(1, "Set up job"), step(2, "Run browser evidence", "failure")],
        }),
        job("test", "success"),
        job("runtime-parity", "success"),
        job("serial-full", "success"),
      ],
    });
    expect(compile(input).jobs.find((entry) => entry.name === "browser-evidence"))
      .toMatchObject({ conclusion: "failure", failedStep: "Run browser evidence" });
  });

  test("rejects terminal runs whose active profile has no matching evidence", () => {
    expect(() => compile(bundle({
      run: { ...bundle().run, conclusion: "failure" },
      jobs: [
        job("browser-evidence", "skipped"),
        job("test", "skipped"),
        job("runtime-parity", "skipped"),
        job("serial-full", "skipped"),
      ],
    }))).toThrow("positive active-profile failure evidence");
  });

  test("compiles the serial exact-ref topology with browser work on the same runner", () => {
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
        job("browser-evidence", "skipped"),
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
      validationProfile: "serial_full",
      concurrencyGroup:
        `ci-teamleaderleo/stensibly-dispatch-${candidate}-serial_full`,
    });
  });

  test("binds diagnostics to the exact run attempt and failed job", () => {
    const artifact = {
      workflowRunId: 30638086970,
      workflowRunAttempt: 1,
      workflowJobId: 20,
      name: "diagnostics" as const,
      digest: diagnostics,
    };
    const failed = bundle({
      run: { ...bundle().run, conclusion: "failure" },
      jobs: [
        job("browser-evidence", "success"),
        job("test", "failure", {
          steps: [step(1, "Set up job"), step(2, "Run Bun tests", "failure")],
        }),
        job("runtime-parity", "success"),
        job("serial-full", "success"),
      ],
      diagnosticsArtifacts: [artifact],
    });
    expect(compile(failed).jobs.find((entry) => entry.name === "test"))
      .toMatchObject({ failedStep: "Run Bun tests", diagnosticsFingerprint: diagnostics });
    expect(() => compile({
      ...failed,
      diagnosticsArtifacts: [{ ...artifact, workflowRunAttempt: 2 }],
    })).toThrow("another run attempt");
    expect(() => compile({
      ...failed,
      diagnosticsArtifacts: [{ ...artifact, workflowJobId: 30 }],
    })).toThrow("another workflow job");
  });

  test("requires zero steps when a job never started", () => {
    expect(() => compile(bundle({
      jobs: [
        job("browser-evidence", "success"),
        job("test", "success"),
        job("runtime-parity", "success"),
        job("serial-full", "skipped", {
          steps: [step(1, "Skipped setup", "skipped")],
        }),
      ],
    }))).toThrow("unstarted job cannot contain completed steps");
  });

  test("admits benign sk-proj names and rejects realistic credential forms", () => {
    const benign = bundle({
      repository: "teamleaderleo/task-sk-proj-research",
      run: { ...bundle().run, conclusion: "failure" },
      jobs: [
        job("browser-evidence", "success"),
        job("test", "failure", {
          labels: ["runner-sk-proj-review"],
          steps: [step(1, "Run sk-proj-review checks", "failure")],
        }),
        job("runtime-parity", "success"),
        job("serial-full", "success"),
      ],
    });
    const receipt = compile(benign);
    expect(receipt.repository).toBe("teamleaderleo/task-sk-proj-research");
    expect(receipt.jobs.find((entry) => entry.name === "test"))
      .toMatchObject({
        requestedLabels: ["runner-sk-proj-review"],
        failedStep: "Run sk-proj-review checks",
      });

    const secret = `context.sk-proj-${"A".repeat(24)}`;
    let error: unknown;
    try {
      compile(bundle({
        run: { ...bundle().run, conclusion: "failure" },
        jobs: [
          job("browser-evidence", "success"),
          job("test", "failure", { steps: [step(1, secret, "failure")] }),
          job("runtime-parity", "success"),
          job("serial-full", "success"),
        ],
      }));
    } catch (caught) { error = caught; }
    expect((error as Error).message).toBe("GitHub Actions step name is invalid");
    expect((error as Error).message).not.toContain(secret);
  });

  test("rejects caller-authored supersession causality", () => {
    const hostile = { ...bundle(), supersededByRevision: "e".repeat(40) };
    expect(() => compileGitHubActionsCiReceiptV1(
      hostile,
      () => new Date("2026-07-31T10:31:00Z"),
    )).toThrow("contains unknown fields");
  });

  test("keeps descriptor diagnostics fixed and invokes zero getters", () => {
    let reads = 0;
    const hostile = bundle() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, "credential-field", {
      enumerable: true,
      get() { reads += 1; return "secret"; },
    });
    expect(() => compileGitHubActionsCiReceiptV1(
      hostile,
      () => new Date("2026-07-31T10:31:00Z"),
    )).toThrow("contains unknown fields");
    expect(reads).toBe(0);
  });
});
