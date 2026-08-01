import { describe, expect, test } from "bun:test";
import {
  GITHUB_ACTIONS_CI_RECEIPT_BUNDLE_V1,
  compileGitHubActionsCiReceiptV1,
  type GitHubActionsCiReceiptBundleV1,
  type GitHubActionsCompletedJobV1,
} from "../src/github-actions-ci-receipt.ts";

const candidate = "a".repeat(40);
const base = "b".repeat(40);
const workflow = "c".repeat(40);

function job(
  id: number,
  name: GitHubActionsCompletedJobV1["name"],
  conclusion: GitHubActionsCompletedJobV1["conclusion"],
): GitHubActionsCompletedJobV1 {
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
    startedAt: "2026-07-31T10:01:00Z",
    completedAt: "2026-07-31T10:20:00Z",
    labels: ["ubuntu-latest"],
    steps: [{
      number: 1,
      name: conclusion === "failure" ? "Contradictory failure" : "Run gate",
      status: "completed",
      conclusion,
    }],
  };
}

function bundle(
  failedName: "browser-evidence" | "serial-full",
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
    jobs: [
      job(10, "browser-evidence", failedName === "browser-evidence" ? "failure" : "success"),
      job(20, "test", "success"),
      job(30, "runtime-parity", "success"),
      job(40, "serial-full", failedName === "serial-full" ? "failure" : "success"),
    ],
    diagnosticsArtifacts: [],
  };
}

describe("signed GitHub Actions restored-job compatibility", () => {
  test("rejects browser and exact-head job outcomes that contradict success", () => {
    for (const name of ["browser-evidence", "serial-full"] as const) {
      expect(() => compileGitHubActionsCiReceiptV1(
        bundle(name),
        () => new Date("2026-07-31T10:31:00Z"),
      )).toThrow(`${name} conclusion is incompatible with the run conclusion`);
    }
  });
});
