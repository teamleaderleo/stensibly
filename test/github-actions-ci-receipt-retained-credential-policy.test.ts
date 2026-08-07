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

function step(name: string): GitHubActionsCompletedStepV1 {
  return {
    number: 1,
    name,
    status: "completed",
    conclusion: "success",
  };
}

function job(
  name: GitHubActionsCompletedJobV1["name"],
  overrides: Partial<GitHubActionsCompletedJobV1> = {},
): GitHubActionsCompletedJobV1 {
  const id = name === "browser-evidence" ? 10
    : name === "test" ? 20
    : name === "runtime-parity" ? 30
    : 40;
  return {
    id,
    runId: 30638086970,
    runAttempt: 1,
    headSha: candidate,
    workflowName: "CI",
    name,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-08-08T00:00:01Z",
    startedAt: "2026-08-08T00:00:30Z",
    completedAt: "2026-08-08T00:05:00Z",
    labels: ["ubuntu-latest"],
    steps: [step("Run gate")],
    ...overrides,
  };
}

function bundle(
  testJob: Partial<GitHubActionsCompletedJobV1> = {},
): GitHubActionsCiReceiptBundleV1 {
  return {
    version: GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
    repository: "teamleaderleo/stensibly",
    receivedAt: "2026-08-08T00:06:00Z",
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
      createdAt: "2026-08-08T00:00:00Z",
      completedAt: "2026-08-08T00:05:30Z",
      pullRequests: [{ number: 1180, headSha: candidate, baseSha: base }],
    },
    jobs: [
      job("browser-evidence"),
      job("test", testJob),
      job("runtime-parity"),
      job("serial-full"),
    ],
    diagnosticsArtifacts: [],
  };
}

function compile(input: GitHubActionsCiReceiptBundleV1) {
  return compileGitHubActionsCiReceiptV1(
    input,
    () => new Date(input.receivedAt),
  );
}

describe("GitHub Actions CI receipt shared retained credential policy", () => {
  test("rejects realistic Stensibly evidence at the shared 12-character threshold", () => {
    const serviceIdentity = `stn.svc_${"a".repeat(12)}`;
    const tokenIdentity = `stn.tok_${"b".repeat(12)}`;

    expect(() => compile(bundle({
      labels: [serviceIdentity],
    }))).toThrow();

    expect(() => compile(bundle({
      steps: [step(tokenIdentity)],
    }))).toThrow();
  });

  test("retains benign Stensibly-like evidence below the shared threshold", () => {
    const benign = `stn.tok_${"a".repeat(11)}`;
    const receipt = compile(bundle({
      labels: [benign],
      steps: [step(benign)],
    }));
    const testJob = receipt.jobs.find((entry) => entry.name === "test");

    expect(testJob?.requestedLabels).toEqual([benign]);
    expect(testJob?.steps[0]?.name).toBe(benign);
  });
});
