import { describe, expect, test } from "bun:test";
import {
  DefaultGitHubOperationsService,
  type GitHubLandInspection,
  type GitHubOperationsProvider,
} from "../src/github-operations.js";
import {
  GitHubDelegatedBindingError,
  GitHubDelegatedProjectAttachmentRequiredError,
  type GitHubDelegatedReadReceipt,
} from "../src/github-delegated-read.js";
import type { OperationWorkflow, OperationWorkflowStore } from "../src/operation-workflow-contracts.js";
import { operationWorkflowStableRequestJson } from "../src/operation-workflow-admission.js";

const commit = (digit: string) => digit.repeat(40);
const at = "2026-08-10T00:00:00.000Z";

describe("GitHub outcome operations", () => {
  test("projects repository health from accepted attachment and live default head", async () => {
    const fixture = makeFixture();
    const result = await fixture.service.githubRepoHealth(identity()) as Record<string, any>;
    expect(result.health).toBe("healthy");
    expect(result.coverage).toEqual({
      version: 1,
      state: "complete",
      requested: ["repository_metadata", "default_branch_head"],
      gaps: [],
    });
    expect(result.repository.defaultBranchSha).toBe(commit("a"));
    expect(result.attachment.snapshotSha256).toBe(`sha256:${"1".repeat(64)}`);
    expect(result.operationSurface).toEqual([
      "github_repo_health", "github_branch_tidy", "github_ci_diagnose", "github_land_pr",
    ]);
    expect(result.operationAvailability.github_land_pr).toEqual({
      capability: "present",
      binding: "ready",
      blockedBy: null,
      candidatePrerequisites: [
        "current_runner_lease",
        "expected_head_sha",
        "fresh_expected_base_sha",
        "clean_mergeability",
        "successful_ci",
        "no_unresolved_review_threads",
      ],
    });
    expect(result.authorizesMutation).toBe(false);
    fixture.close();
  });

  test("keeps merge capability visible while a project attachment is missing", async () => {
    const fixture = makeFixture({ attachmentMissing: true });
    const result = await fixture.service.githubRepoHealth(identity()) as Record<string, any>;
    expect(result).toMatchObject({
      health: "blocked",
      project: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
      coverage: {
        version: 1,
        state: "blocked",
        requested: ["repository_metadata", "default_branch_head"],
        gaps: ["project_attachment", "repository_metadata", "default_branch_head"],
      },
      attachment: null,
      provider: { connectivity: "blocked" },
      repository: null,
      attention: ["project_attachment_required"],
      recovery: {
        inspectWith: "get_project_attachment",
        nextAction: "review_and_accept_project_attachment",
      },
      authorizesMutation: false,
    });
    expect(result.operationSurface).toContain("github_land_pr");
    expect(result.operationAvailability.github_land_pr).toMatchObject({
      capability: "present",
      binding: "blocked",
      blockedBy: "project_attachment",
    });
    fixture.close();
  });

  test("does not turn other binding failures into attachment setup guidance", async () => {
    const fixture = makeFixture({
      delegatedFailure: new GitHubDelegatedBindingError("binding is stale"),
    });
    await expect(fixture.service.githubRepoHealth(identity())).rejects.toThrow(
      "binding is stale",
    );
    fixture.close();
  });

  test("keeps branch tidy plan-only with exact recovery refs", async () => {
    const fixture = makeFixture();
    const result = await fixture.service.githubBranchTidy({
      ...identity(), minimumAgeDays: 14, maximumBranches: 25,
    });
    expect(result.authorizesMutation).toBe(false);
    expect(result.eligibleCount).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      branch: "dogfood/merged",
      expectedSha: commit("b"),
      eligible: true,
      recovery: { kind: "recreate_branch", commitSha: commit("b") },
    });
    expect(fixture.merges).toBe(0);
    fixture.close();
  });

  test("diagnoses failed workflow identities without authorizing a retry", async () => {
    const fixture = makeFixture({ failingCi: true });
    const result = await fixture.service.githubCiDiagnose({
      ...identity(), pullRequestNumber: 42, includeJobSteps: true,
    }) as Record<string, any>;
    expect(result.verdict).toBe("failing");
    expect(result.coverage).toEqual({
      version: 1,
      state: "complete",
      requested: [
        "pull_request", "combined_status", "workflow_runs", "failed_jobs", "failed_job_steps",
      ],
      gaps: [],
    });
    expect(result.failures[0].run.id).toBe(9001);
    expect(result.failures[0].failedJobs[0].job.id).toBe(7001);
    expect(result.failures[0].failedJobs[0].steps.failedStepCount).toBe(1);
    expect(result.authorizesMutation).toBe(false);
    fixture.close();
  });

  test("keeps a failing verdict while exposing unavailable requested job-step coverage", async () => {
    const fixture = makeFixture({ failingCi: true, jobStepsUnavailable: true });
    const result = await fixture.service.githubCiDiagnose({
      ...identity(), pullRequestNumber: 42, includeJobSteps: true,
    }) as Record<string, any>;

    expect(result.verdict).toBe("failing");
    expect(result.coverage).toEqual({
      version: 1,
      state: "partial",
      requested: [
        "pull_request", "combined_status", "workflow_runs", "failed_jobs", "failed_job_steps",
      ],
      gaps: ["workflow_job_steps:7001"],
    });
    expect(result.failures[0].failedJobs[0]).toMatchObject({
      job: { id: 7001 },
      steps: null,
      detailState: "unavailable",
    });
    expect(result.authorizesMutation).toBe(false);
    fixture.close();
  });

  test("summary-only CI diagnosis is complete without requesting job-step detail", async () => {
    const fixture = makeFixture({ failingCi: true, jobStepsUnavailable: true });
    const result = await fixture.service.githubCiDiagnose({
      ...identity(), pullRequestNumber: 42, includeJobSteps: false,
    }) as Record<string, any>;

    expect(result.verdict).toBe("failing");
    expect(result.coverage).toEqual({
      version: 1,
      state: "complete",
      requested: ["pull_request", "combined_status", "workflow_runs", "failed_jobs"],
      gaps: [],
    });
    expect(result.failures[0].failedJobs[0]).toMatchObject({ job: { id: 7001 }, steps: null });
    expect(result.failures[0].failedJobs[0].detailState).toBeUndefined();
    fixture.close();
  });

  test("lands once behind exact readiness and durable reservation fences", async () => {
    const fixture = makeFixture();
    const input = landInput();
    const result = await fixture.service.githubLandPr(input);
    expect(result.state).toBe("succeeded");
    expect(result.steps[0]).toMatchObject({
      kind: "github_merge_pull_request", state: "verified",
      compensation: { disposition: "irreversible", state: "unavailable" },
    });
    expect(fixture.merges).toBe(1);
    const replay = await fixture.service.githubLandPr(input);
    expect(replay).toEqual(result);
    expect(fixture.merges).toBe(1);
    fixture.close();
  });

  test("refuses unresolved review threads before provider merge dispatch", async () => {
    const fixture = makeFixture({ unresolved: true });
    await expect(fixture.service.githubLandPr(landInput())).rejects.toThrow(
      "unresolved review threads",
    );
    expect(fixture.merges).toBe(0);
    fixture.close();
  });

  test("requires positive successful CI evidence before provider merge dispatch", async () => {
    const fixture = makeFixture({ noCi: true });
    await expect(fixture.service.githubLandPr(landInput())).rejects.toThrow(
      "no successful CI evidence",
    );
    expect(fixture.merges).toBe(0);
    fixture.close();
  });

  test("holds a completed merge for reconciliation when the base races", async () => {
    const fixture = makeFixture({ racedBase: true });
    await expect(fixture.service.githubLandPr(landInput())).rejects.toMatchObject({
      code: "operation_workflow_pending_reconciliation",
      workflow: { state: "waiting_reconciliation" },
    });
    expect(fixture.merges).toBe(1);
    await expect(fixture.service.githubLandPr(landInput())).rejects.toMatchObject({
      code: "operation_workflow_pending_reconciliation",
    });
    expect(fixture.merges).toBe(1);
    fixture.close();
  });
});

function makeFixture(options: {
  failingCi?: boolean;
  unresolved?: boolean;
  noCi?: boolean;
  racedBase?: boolean;
  attachmentMissing?: boolean;
  delegatedFailure?: Error;
  jobStepsUnavailable?: boolean;
} = {}) {
  const workflows = new MemoryWorkflowStore();
  let merged = false;
  let merges = 0;
  const inspection = (): GitHubLandInspection => ({
    repositoryFullName: "teamleaderleo/stensibly",
    number: 42,
    state: merged ? "closed" : "open",
    draft: false,
    merged,
    headRef: "codex/change",
    headSha: commit("b"),
    baseRef: "main",
    baseSha: commit("a"),
    mergeable: merged ? null : true,
    mergeableState: merged ? "unknown" : "clean",
    mergeCommitSha: merged ? commit("c") : null,
  });
  const provider: GitHubOperationsProvider = {
    async readBranchHead() { return commit("a"); },
    async planBranchTidy(input) {
      return {
        version: 1,
        repositoryFullName: input.repositoryFullName,
        defaultBranch: input.defaultBranch,
        defaultBranchSha: input.defaultBranchSha,
        observedAt: at,
        minimumAgeDays: input.minimumAgeDays,
        scannedBranchCount: 2,
        candidates: [{
          branch: "dogfood/merged", expectedSha: commit("b"), protected: false,
          openPullRequests: [], aheadBy: 0, behindBy: 3,
          headCommittedAt: "2026-07-01T00:00:00.000Z", ageDays: 40,
          eligible: true, reasons: ["merged_or_fully_contained"],
          recovery: { kind: "recreate_branch", branch: "dogfood/merged", commitSha: commit("b") },
        }],
        eligibleCount: 1,
        reviewCount: 0,
        authorizesMutation: false,
      };
    },
    async inspectPullRequest() { return inspection(); },
    async readMergeCommit(_repository, commitSha) {
      return {
        commitSha,
        parentShas: [options.racedBase ? commit("d") : commit("a")],
      };
    },
    async mergePullRequest() {
      merges += 1;
      merged = true;
      return { mergeCommitSha: commit("c"), providerRequestId: "REQ-1" };
    },
  };
  const service = new DefaultGitHubOperationsService({
    delegated: async (input) => {
      if (options.delegatedFailure) throw options.delegatedFailure;
      if (options.attachmentMissing) {
        throw new GitHubDelegatedProjectAttachmentRequiredError(
          "Project stensibly has no accepted repository attachment",
        );
      }
      if (input.tool === "fetch_workflow_job_steps" && options.jobStepsUnavailable) {
        throw new Error("workflow job steps unavailable");
      }
      return receipt(input.tool, delegatedResult(input.tool, options));
    },
    provider,
    workflows,
    assertAuthority: async () => undefined,
    now: () => at,
  });
  return {
    service,
    get merges() { return merges; },
    close() {},
  };
}

class MemoryWorkflowStore implements OperationWorkflowStore {
  readonly #values = new Map<string, OperationWorkflow>();

  async reserveOperationWorkflow(workflow: OperationWorkflow) {
    const key = `${workflow.project}:${workflow.idempotencyKey}`;
    const current = this.#values.get(key);
    if (!current) {
      this.#values.set(key, workflow);
      return { outcome: "reserved" as const, workflow };
    }
    return operationWorkflowStableRequestJson(current) === operationWorkflowStableRequestJson(workflow)
      ? { outcome: "replay" as const, workflow: current }
      : { outcome: "conflict" as const, workflow: current };
  }

  async transitionOperationWorkflow(input: { current: OperationWorkflow; next: OperationWorkflow }) {
    const key = `${input.current.project}:${input.current.idempotencyKey}`;
    if (this.#values.get(key)?.revision !== input.current.revision) {
      throw new Error("workflow changed");
    }
    this.#values.set(key, input.next);
    return input.next;
  }

  async getOperationWorkflow(project: string, idempotencyKey: string) {
    return this.#values.get(`${project}:${idempotencyKey}`) ?? null;
  }
}

function delegatedResult(tool: string, options: {
  failingCi?: boolean;
  unresolved?: boolean;
  noCi?: boolean;
}) {
  if (tool === "get_repo") return {
    repositoryFullName: "teamleaderleo/stensibly", private: true, archived: false,
    disabled: false, visibility: "private", defaultBranch: "main",
    updatedAt: at, pushedAt: at,
  };
  if (tool === "get_pr_info") return {
    repositoryFullName: "teamleaderleo/stensibly", number: 42,
    headSha: commit("b"), baseSha: commit("a"), headRef: "codex/change", baseRef: "main",
  };
  if (tool === "get_commit_combined_status") return {
    repositoryFullName: "teamleaderleo/stensibly", commitSha: commit("b"),
    state: options.failingCi ? "failure" : options.noCi ? "pending" : "success",
    totalCount: options.noCi ? 0 : 1,
    statuses: [],
  };
  if (tool === "list_pull_request_review_threads") return {
    repositoryFullName: "teamleaderleo/stensibly", number: 42,
    threads: options.unresolved ? [{ id: "thread-1", isResolved: false }] : [],
  };
  if (tool === "fetch_commit_workflow_runs") return {
    repositoryFullName: "teamleaderleo/stensibly", commitSha: commit("b"),
    workflowRuns: options.failingCi
      ? [{ id: 9001, status: "completed", conclusion: "failure", headSha: commit("b") }]
      : [],
  };
  if (tool === "fetch_workflow_run_jobs") return {
    repositoryFullName: "teamleaderleo/stensibly", runId: 9001,
    jobs: [{ id: 7001, status: "completed", conclusion: "failure", headSha: commit("b") }],
  };
  if (tool === "fetch_workflow_job_steps") return { jobId: 7001, failedStepCount: 1, steps: [] };
  throw new Error(`unexpected delegated tool ${tool}`);
}

function receipt(tool: string, result: unknown): GitHubDelegatedReadReceipt {
  return {
    version: 1,
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    tool,
    actorId: "agent_keel",
    clientId: "codex",
    connectionId: "github-installation-1",
    installationId: "1",
    bindingId: "binding-1",
    attachmentId: "attachment-1",
    attachmentSnapshotSha256: `sha256:${"1".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    catalogueFingerprint: `sha256:${"2".repeat(64)}`,
    parametersSha256: `sha256:${"3".repeat(64)}`,
    providerRequestId: "REQ-1",
    resultSha256: `sha256:${"4".repeat(64)}`,
    result,
  };
}

function identity() {
  return {
    project: "stensibly", repository: "teamleaderleo/stensibly",
    actorId: "agent_keel", clientId: "codex",
  };
}

function landInput() {
  return {
    ...identity(), itemId: "item-1", runId: "run-1",
    authorityFence: {
      resource: "run:run-1:generation:1", holderId: "agent_keel",
      generation: 1, expiresAt: "2026-08-10T00:10:00.000Z",
    },
    pullRequestNumber: 42, expectedHeadSha: commit("b"), expectedBaseSha: commit("a"),
    method: "squash" as const, idempotencyKey: "land-pr-42",
  };
}
