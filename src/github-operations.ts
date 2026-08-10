import { randomUUID } from "node:crypto";
import { GitHubCapabilityCatalogueService } from "./github-capability-service.js";
import type { GitHubDelegatedReadReceipt } from "./github-delegated-read.js";
import type { HostedGitHubDelegatedReadInput } from "./hosted-github-delegated-read-provider.js";
import { sha256, stableJson } from "./canonical-json.js";
import {
  OperationWorkflowConflictError,
  OperationWorkflowPendingReconciliationError,
  type OperationAuthorityFence,
  type OperationWorkflow,
  type OperationWorkflowStore,
} from "./operation-workflow-contracts.js";
import {
  buildOperationWorkflow,
  reserveOperationWorkflowStep,
  settleOperationWorkflowStep,
} from "./operation-workflow-machine.js";

export interface GitHubBranchTidyPlan {
  version: 1;
  repositoryFullName: string;
  defaultBranch: string;
  defaultBranchSha: string;
  observedAt: string;
  minimumAgeDays: number;
  scannedBranchCount: number;
  candidates: readonly {
    branch: string;
    expectedSha: string;
    protected: boolean;
    openPullRequests: readonly number[];
    aheadBy: number;
    behindBy: number;
    headCommittedAt: string;
    ageDays: number;
    eligible: boolean;
    reasons: readonly string[];
    recovery: { kind: "recreate_branch"; branch: string; commitSha: string };
  }[];
  eligibleCount: number;
  reviewCount: number;
  authorizesMutation: false;
}

export interface GitHubLandInspection {
  repositoryFullName: string;
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeable: boolean | null;
  mergeableState: string;
  mergeCommitSha: string | null;
}

export interface GitHubOperationsProvider {
  readBranchHead(repositoryFullName: string, branch: string): Promise<string>;
  planBranchTidy(input: {
    repositoryFullName: string;
    defaultBranch: string;
    defaultBranchSha: string;
    minimumAgeDays: number;
    maximumBranches: number;
  }): Promise<GitHubBranchTidyPlan>;
  inspectPullRequest(repositoryFullName: string, number: number): Promise<GitHubLandInspection>;
  readMergeCommit(repositoryFullName: string, mergeCommitSha: string): Promise<{
    commitSha: string;
    parentShas: readonly string[];
  }>;
  mergePullRequest(input: {
    repositoryFullName: string;
    number: number;
    expectedHeadSha: string;
    method: "merge" | "squash";
  }): Promise<{ mergeCommitSha: string; providerRequestId: string | null }>;
}

export interface GitHubOperationsServiceDependencies {
  delegated(input: HostedGitHubDelegatedReadInput): Promise<GitHubDelegatedReadReceipt>;
  provider: GitHubOperationsProvider;
  workflows: OperationWorkflowStore;
  assertAuthority(input: GitHubLandPrInput): Promise<void>;
  now?: () => string;
}

export interface GitHubOperationIdentity {
  project: string;
  repository: string;
  actorId: string;
  clientId: string;
}

export interface GitHubLandPrInput extends GitHubOperationIdentity {
  itemId: string;
  runId: string;
  authorityFence: OperationAuthorityFence;
  pullRequestNumber: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  method: "merge" | "squash";
  idempotencyKey: string;
}

export interface GitHubOperationsService {
  githubRepoHealth(input: GitHubOperationIdentity): Promise<unknown>;
  githubBranchTidy(input: GitHubOperationIdentity & {
    minimumAgeDays: number;
    maximumBranches: number;
  }): Promise<GitHubBranchTidyPlan>;
  githubCiDiagnose(input: GitHubOperationIdentity & {
    pullRequestNumber: number;
    includeJobSteps: boolean;
  }): Promise<unknown>;
  githubLandPr(input: GitHubLandPrInput): Promise<OperationWorkflow>;
}

export function withGitHubOperationsService<T extends object>(
  target: T,
  service: GitHubOperationsService,
): T & GitHubOperationsService {
  return Object.assign(target, {
    githubRepoHealth: service.githubRepoHealth.bind(service),
    githubBranchTidy: service.githubBranchTidy.bind(service),
    githubCiDiagnose: service.githubCiDiagnose.bind(service),
    githubLandPr: service.githubLandPr.bind(service),
  });
}

export class DefaultGitHubOperationsService implements GitHubOperationsService {
  readonly #dependencies: GitHubOperationsServiceDependencies;
  readonly #catalogue = new GitHubCapabilityCatalogueService();
  readonly #now: () => string;

  constructor(dependencies: GitHubOperationsServiceDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async githubRepoHealth(input: GitHubOperationIdentity): Promise<unknown> {
    const repo = await this.#read(input, "get_repo", {});
    const metadata = record(repo.result, "repository metadata");
    const defaultBranch = text(metadata.defaultBranch, "default branch");
    const defaultBranchSha = await this.#dependencies.provider.readBranchHead(
      repo.repositoryFullName,
      defaultBranch,
    );
    const attention = [
      metadata.archived === true ? "repository_archived" : null,
      metadata.disabled === true ? "repository_disabled" : null,
    ].filter((value): value is string => value !== null);
    return Object.freeze({
      version: 1,
      project: repo.project,
      repositoryFullName: repo.repositoryFullName,
      observedAt: this.#now(),
      health: attention.length === 0 ? "healthy" : "attention",
      attachment: Object.freeze({
        id: repo.attachmentId,
        snapshotSha256: repo.attachmentSnapshotSha256,
        bindingId: repo.bindingId,
      }),
      provider: Object.freeze({
        connectionId: repo.connectionId,
        installationId: repo.installationId,
        connectivity: "ready",
      }),
      repository: Object.freeze({ ...metadata, defaultBranchSha }),
      operationSurface: Object.freeze([
        "github_repo_health",
        "github_branch_tidy",
        "github_ci_diagnose",
        "github_land_pr",
      ]),
      catalogueFingerprint: this.#catalogue.registry.fingerprint,
      attention: Object.freeze(attention),
      authorizesMutation: false,
    });
  }

  async githubBranchTidy(
    input: GitHubOperationIdentity & { minimumAgeDays: number; maximumBranches: number },
  ): Promise<GitHubBranchTidyPlan> {
    const repo = await this.#read(input, "get_repo", {});
    const metadata = record(repo.result, "repository metadata");
    const defaultBranch = text(metadata.defaultBranch, "default branch");
    const defaultBranchSha = await this.#dependencies.provider.readBranchHead(
      repo.repositoryFullName,
      defaultBranch,
    );
    return this.#dependencies.provider.planBranchTidy({
      repositoryFullName: repo.repositoryFullName,
      defaultBranch,
      defaultBranchSha,
      minimumAgeDays: input.minimumAgeDays,
      maximumBranches: input.maximumBranches,
    });
  }

  async githubCiDiagnose(
    input: GitHubOperationIdentity & { pullRequestNumber: number; includeJobSteps: boolean },
  ): Promise<unknown> {
    const pr = await this.#read(input, "get_pr_info", {
      pr_number: input.pullRequestNumber,
    });
    const pullRequest = record(pr.result, "pull request");
    const headSha = text(pullRequest.headSha, "pull request head SHA");
    const [statuses, workflows] = await Promise.all([
      this.#read(input, "get_commit_combined_status", { commit_sha: headSha }),
      this.#read(input, "fetch_commit_workflow_runs", { commit_sha: headSha }),
    ]);
    const workflowResult = record(workflows.result, "workflow runs");
    const runs = array(workflowResult.workflowRuns, "workflow runs");
    const failingRuns = runs.filter((value) => {
      const run = record(value, "workflow run");
      return run.status === "completed" && run.conclusion !== "success"
        && run.conclusion !== "neutral" && run.conclusion !== "skipped";
    }).slice(0, 10);
    const jobGroups = await Promise.all(failingRuns.map(async (value) => {
      const run = record(value, "workflow run");
      const runId = integer(run.id, "workflow run ID");
      const jobs = await this.#read(input, "fetch_workflow_run_jobs", { run_id: runId });
      const jobsResult = record(jobs.result, "workflow jobs");
      const failedJobs = array(jobsResult.jobs, "workflow jobs").filter((candidate) => {
        const job = record(candidate, "workflow job");
        return job.status === "completed" && job.conclusion !== "success"
          && job.conclusion !== "neutral" && job.conclusion !== "skipped";
      }).slice(0, 20);
      const details = input.includeJobSteps
        ? await Promise.all(failedJobs.map(async (candidate) => {
          const job = record(candidate, "workflow job");
          const jobId = integer(job.id, "workflow job ID");
          try {
            const steps = await this.#read(input, "fetch_workflow_job_steps", { job_id: jobId });
            return Object.freeze({ job, steps: steps.result });
          } catch {
            return Object.freeze({ job, steps: null, detailState: "unavailable" });
          }
        }))
        : failedJobs.map((job) => Object.freeze({ job, steps: null }));
      return Object.freeze({ run, failedJobs: Object.freeze(details) });
    }));
    const statusResult = record(statuses.result, "combined status");
    const statusState = text(statusResult.state, "combined status state");
    const pending = runs.some((value) => record(value, "workflow run").status !== "completed")
      || statusState === "pending";
    const verdict = failingRuns.length > 0 || statusState === "failure" || statusState === "error"
      ? "failing"
      : pending ? "pending" : "healthy";
    return Object.freeze({
      version: 1,
      project: pr.project,
      repositoryFullName: pr.repositoryFullName,
      observedAt: this.#now(),
      verdict,
      pullRequest,
      headSha,
      combinedStatus: statuses.result,
      workflowRuns: workflows.result,
      failures: Object.freeze(jobGroups),
      authorizesMutation: false,
    });
  }

  async githubLandPr(input: GitHubLandPrInput): Promise<OperationWorkflow> {
    await this.#dependencies.assertAuthority(input);
    const candidate = this.#buildLandWorkflow(input);
    const reservation = await this.#dependencies.workflows.reserveOperationWorkflow(candidate);
    if (reservation.outcome === "conflict") throw new OperationWorkflowConflictError();
    let workflow = reservation.workflow;
    if (workflow.state === "succeeded") return workflow;
    const step = workflow.steps[0]!;
    if (step.state === "dispatch_reserved" || step.state === "pending_reconciliation") {
      const inspected = await this.#dependencies.provider.inspectPullRequest(
        input.repository,
        input.pullRequestNumber,
      );
      if (inspected.merged && inspected.headSha === input.expectedHeadSha && inspected.mergeCommitSha) {
        const mergeCommit = await this.#dependencies.provider.readMergeCommit(
          input.repository,
          inspected.mergeCommitSha,
        );
        if (mergeCommit.parentShas[0] !== input.expectedBaseSha) {
          throw new OperationWorkflowPendingReconciliationError(workflow);
        }
        const settled = settleOperationWorkflowStep(workflow, {
          stepId: step.id,
          outcome: "verified",
          settledAt: this.#now(),
          providerReceiptRef: `github-pr:${input.repository}#${input.pullRequestNumber}:merge:${inspected.mergeCommitSha}`,
          before: { headSha: input.expectedHeadSha, baseSha: input.expectedBaseSha },
          after: { mergeCommitSha: inspected.mergeCommitSha, baseParentSha: mergeCommit.parentShas[0] },
          verification: { pullRequest: inspected, mergeCommit },
        });
        return this.#dependencies.workflows.transitionOperationWorkflow({ current: workflow, next: settled });
      }
      throw new OperationWorkflowPendingReconciliationError(workflow);
    }

    const inspection = await this.#assertLandReadiness(input);
    await this.#dependencies.assertAuthority(input);
    workflow = await this.#dependencies.workflows.transitionOperationWorkflow({
      current: workflow,
      next: reserveOperationWorkflowStep(workflow, step.id, this.#now()),
    });
    try {
      await this.#dependencies.assertAuthority(input);
      const merged = await this.#dependencies.provider.mergePullRequest({
        repositoryFullName: input.repository,
        number: input.pullRequestNumber,
        expectedHeadSha: input.expectedHeadSha,
        method: input.method,
      });
      const readback = await this.#dependencies.provider.inspectPullRequest(
        input.repository,
        input.pullRequestNumber,
      );
      if (!readback.merged || readback.headSha !== input.expectedHeadSha
        || readback.mergeCommitSha !== merged.mergeCommitSha) {
        throw new Error("GitHub land PR readback did not prove the exact merge");
      }
      const mergeCommit = await this.#dependencies.provider.readMergeCommit(
        input.repository,
        merged.mergeCommitSha,
      );
      if (mergeCommit.parentShas[0] !== input.expectedBaseSha) {
        throw new Error("GitHub land PR base moved during provider merge");
      }
      const settled = settleOperationWorkflowStep(workflow, {
        stepId: step.id,
        outcome: "verified",
        settledAt: this.#now(),
        providerReceiptRef: `github-pr:${input.repository}#${input.pullRequestNumber}:merge:${merged.mergeCommitSha}`,
        before: inspection,
        after: { mergeCommitSha: merged.mergeCommitSha, baseParentSha: mergeCommit.parentShas[0] },
        verification: { pullRequest: readback, mergeCommit },
      });
      return await this.#dependencies.workflows.transitionOperationWorkflow({ current: workflow, next: settled });
    } catch {
      const pending = settleOperationWorkflowStep(workflow, {
        stepId: step.id,
        outcome: "pending_reconciliation",
        settledAt: this.#now(),
        errorCode: "github_land_pr_requires_reconciliation",
      });
      workflow = await this.#dependencies.workflows.transitionOperationWorkflow({ current: workflow, next: pending });
      throw new OperationWorkflowPendingReconciliationError(workflow);
    }
  }

  async #assertLandReadiness(input: GitHubLandPrInput): Promise<GitHubLandInspection> {
    const inspection = await this.#dependencies.provider.inspectPullRequest(
      input.repository,
      input.pullRequestNumber,
    );
    if (inspection.state !== "open" || inspection.draft || inspection.merged
      || inspection.headSha !== input.expectedHeadSha
      || inspection.baseSha !== input.expectedBaseSha
      || inspection.mergeable !== true || inspection.mergeableState !== "clean") {
      throw new Error("GitHub pull request is not exactly ready to land");
    }
    const baseHead = await this.#dependencies.provider.readBranchHead(
      input.repository,
      inspection.baseRef,
    );
    if (baseHead !== input.expectedBaseSha) {
      throw new Error("GitHub pull request base branch moved before landing");
    }
    const [statusReceipt, reviewReceipt, workflowReceipt] = await Promise.all([
      this.#read(input, "get_commit_combined_status", { commit_sha: input.expectedHeadSha }),
      this.#read(input, "list_pull_request_review_threads", { pr_number: input.pullRequestNumber }),
      this.#read(input, "fetch_commit_workflow_runs", { commit_sha: input.expectedHeadSha }),
    ]);
    const statuses = record(statusReceipt.result, "combined status");
    const statusCount = integerAllowZero(statuses.totalCount, "combined status count");
    if (statusCount > 0 && statuses.state !== "success") {
      throw new Error("GitHub pull request checks are not successful");
    }
    const reviews = record(reviewReceipt.result, "review threads");
    const unresolved = array(reviews.threads, "review threads")
      .filter((value) => record(value, "review thread").isResolved !== true);
    if (unresolved.length > 0) throw new Error("GitHub pull request has unresolved review threads");
    const workflows = record(workflowReceipt.result, "workflow runs");
    const workflowRuns = array(workflows.workflowRuns, "workflow runs");
    const unready = workflowRuns.some((value) => {
      const run = record(value, "workflow run");
      return run.status !== "completed"
        || (run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped");
    });
    if (unready) throw new Error("GitHub pull request workflows are not successful");
    if (statusCount === 0 && workflowRuns.length === 0) {
      throw new Error("GitHub pull request has no successful CI evidence");
    }
    return inspection;
  }

  #buildLandWorkflow(input: GitHubLandPrInput): OperationWorkflow {
    return buildOperationWorkflow({
      id: `opw_${randomUUID()}`,
      project: input.project,
      itemId: input.itemId,
      runId: input.runId,
      actorId: input.actorId,
      clientId: input.clientId,
      kind: "github_land_pr",
      target: `${input.repository}:pull/${input.pullRequestNumber}`,
      request: {
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        expectedHeadSha: input.expectedHeadSha,
        expectedBaseSha: input.expectedBaseSha,
        method: input.method,
      },
      idempotencyKey: input.idempotencyKey,
      authorityFence: input.authorityFence,
      steps: [{
        kind: "github_merge_pull_request",
        command: {
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          expectedHeadSha: input.expectedHeadSha,
          expectedBaseSha: input.expectedBaseSha,
          method: input.method,
        },
        compensation: { disposition: "irreversible" },
      }],
      now: this.#now(),
    });
  }

  #read(
    input: GitHubOperationIdentity,
    tool: HostedGitHubDelegatedReadInput["tool"],
    args: Record<string, unknown>,
  ): Promise<GitHubDelegatedReadReceipt> {
    return this.#dependencies.delegated({
      project: input.project,
      repository: input.repository,
      tool,
      arguments: args,
      actorId: input.actorId,
      clientId: input.clientId,
      catalogueFingerprint: this.#catalogue.registry.fingerprint,
    });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub operation ${label} was invalid`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`GitHub operation ${label} was invalid`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`GitHub operation ${label} was invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`GitHub operation ${label} was invalid`);
  }
  return value as number;
}

function integerAllowZero(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`GitHub operation ${label} was invalid`);
  }
  return value as number;
}

export function githubLandRequestFingerprint(input: GitHubLandPrInput): string {
  return sha256(stableJson({
    project: input.project,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadSha: input.expectedHeadSha,
    expectedBaseSha: input.expectedBaseSha,
    method: input.method,
  }));
}
