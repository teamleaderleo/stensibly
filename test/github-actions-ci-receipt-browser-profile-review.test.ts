import { expect, test } from "bun:test";
import { compileGitHubActionsCiReceiptV1 } from "../src/github-actions-ci-receipt.js";

const candidate = "a".repeat(40);
const base = "b".repeat(40);
const workflow = "c".repeat(40);

function completedJob(
  name: string,
  conclusion: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const skipped = conclusion === "skipped";
  return {
    id: name === "browser-evidence"
      ? 5
      : name === "test"
        ? 10
        : name === "runtime-parity"
          ? 20
          : 30,
    runId: 30638086970,
    runAttempt: 1,
    headSha: candidate,
    workflowName: "CI",
    name,
    status: "completed",
    conclusion,
    createdAt: "2026-07-31T10:00:01Z",
    startedAt: skipped ? null : "2026-07-31T10:01:00Z",
    completedAt: skipped
      ? "2026-07-31T10:00:03Z"
      : "2026-07-31T10:20:00Z",
    labels: ["ubuntu-latest"],
    steps: skipped
      ? []
      : [{
        number: 1,
        name: "Set up job",
        status: "completed",
        conclusion: "success",
      }],
    ...overrides,
  };
}

function receiptBundle(
  jobs: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
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
    jobs,
    diagnosticsArtifacts: [],
    ...overrides,
  };
}

const compile = (input: unknown) => compileGitHubActionsCiReceiptV1(
  input,
  () => new Date("2026-07-31T10:31:00Z"),
);

test("retains the complete active full-parallel browser topology", () => {
  const receipt = compile(receiptBundle([
    completedJob("browser-evidence", "success"),
    completedJob("test", "success"),
    completedJob("runtime-parity", "success"),
    completedJob("serial-full", "skipped"),
  ]));

  expect(receipt.jobs.map((job) => job.name)).toEqual([
    "browser-evidence",
    "test",
    "runtime-parity",
    "serial-full",
  ]);
});

test("preserves benign sk-proj prose in retained CI identities", () => {
  const receipt = compile(receiptBundle([
    completedJob("test", "success", {
      labels: ["runner-sk-proj-review"],
      steps: [{
        number: 1,
        name: "Run sk-proj-review checks",
        status: "completed",
        conclusion: "success",
      }],
    }),
    completedJob("runtime-parity", "success"),
    completedJob("serial-full", "skipped"),
  ], {
    repository: "teamleaderleo/task-sk-proj-research",
  }));

  expect(receipt.repository).toBe("teamleaderleo/task-sk-proj-research");
  expect(receipt.jobs.find((job) => job.name === "test")?.requestedLabels)
    .toContain("runner-sk-proj-review");
});
