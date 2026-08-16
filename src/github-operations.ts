import { randomUUID } from "node:crypto";
import { GitHubCapabilityCatalogueService } from "./github-capability-service.js";
import {
  GitHubDelegatedProjectAttachmentRequiredError,
  type GitHubDelegatedReadReceipt,
} from "./github-delegated-read.js";
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

export interface GitHubObservationCoverage {
  version: 1;
  state: "complete" | "partial" | "blocked";
  requested: readonly string[];
  gaps: readonly string[];
}

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

const githubOperationSurface = Object.freeze([
  "github_repo_health",
  "github_branch_tidy",
  "github_ci_diagnose",
  "github_land_pr",
] as const);

const githubLandPrCandidatePrerequisites = Object.freeze([
  "current_runner_lease",
  "expected_head_sha",
  "fresh_expected_base_sha",
  "clean_mergeability",
  "successful_ci",
  "no_unresolved_review_threads",
] as const);

const repoHealthCoverage = Object.freeze([
  "repository_metadata",
  "default_branch_head",
] as const);

const ciSummaryCoverage = Object.freeze([
  "pull_request",
  "combined_status",
  "workflow_runs",
  "failed_jobs",
] as const);

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
    let repo: GitHubDelegatedReadReceipt;
    try {
      repo = await this.#read(input, "get_repo", {});
    } catch (error) {
      if (!(error instanceof GitHubDelegatedProjectAttachmentRequiredError)) throw error;
      return this.#blockedRepoHealth(input);
    }
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
      coverage: observationCoverage("complete", repoHealthCoverage, []),
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
      operationSurface: githubOperationSurface,
      operationAvailability: operationAvailability("ready"),
      catalogueFingerprint: this.#catalogue.registry.fingerprint,
      attention: Object.freeze(attention),
      authorizesMutation: false,
    });
  }

  #blockedRepoHealth(input: GitHubOperationIdentity): unknown {
    return Object.freeze({
      version: 1,
      project: input.project,
      repositoryFullName: input.repository,
      observedAt: this.#now(),
      health: "blocked",
      coverage: observationCoverage("blocked", repoHealthCoverage, [
        "project_attachment",
        "repository_metadata",
        "default_branch_head",
      ]),
      attachment: null,
      provider: Object.freeze({ connectivity: "blocked" }),
      repository: null,
      operationSurface: githubOperationSurface,
      operationAvailability: operationAvailability("blocked"),
      catalogueFingerprint: this.#catalogue.registry.fingerprint,
      attention: Object.freeze(["project_attachment_required"]),
      recovery: Object.freeze({
        inspectWith: "get_project_attachment",
        nextAction: "review_and_accept_project_attachment",
      }),
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
      const detailsWithCoverage = input.includeJobSteps
        ? await Promise.all(failedJobs.map(async (candidate) => {
          const job = record(candidate, "workflow job");
          const jobId = integer(job.id, "workflow job ID");
          try {
            const steps = await this.#read(input, "fetch_workflow_job_steps", { job_id: jobId });
            return Object.freeze({
              detail: Object.freeze({ job, steps: steps.result }),
              gap: null,
            });
          } catch {
            return Object.freeze({
              detail: Object.freeze({ job, steps: null, detailState: "unavailable" }),
              gap: `workflow_job_steps:${jobId}`,
            });
          }
        }))
        : failedJobs.map((job) => Object.freeze({
          detail: Object.freeze({ job, steps: null }),
          gap: null,
        }));
      return Object.freeze({
        failureGroup: Object.freeze({
          run,
          failedJobs: Object.freeze(detailsWithCoverage.map((value) => value.detail)),
        }),
        gaps: Object.freeze(
          detailsWithCoverage.flatMap((value) => value.gap === null ? [] : [value.gap]),
        ),
      });
    }));
    const coverageGaps = jobGroups
      .flatMap((group) => group.gaps)
      .slice()
      .sort();
    const requestedCoverage = input.includeJobSteps
      ? [...ciSummaryCoverage, "failed_job_steps"]
      : ciSummaryCoverage;
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
      coverage: observationCoverage(
        coverageGaps.length === 0 ? "complete" : "partial",
        requestedCoverage,
        coverageGaps,
      ),
      pullRequest,
      headSha,
      combinedStatus: statuses.result,
      workflowRuns: workflows.result,
      failures: Object.freeze(jobGroups.map((group) => group.failureGroup)),
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
    if (text(statuses.commitSha, "combined status commit SHA") !== input.expectedHeadSha) {
      throw new Error("GitHub operation combined status commit SHA was invalid");
    }
    const statusCount = integerAllowZero(statuses.totalCount, "combined status count");
    if (statusCount > 0 && statuses.state !== "success") {
      throw new Error("GitHub pull request checks are not successful");
    }
    const reviews = record(reviewReceipt.result, "review threads");
    const unresolved = array(reviews.threads, "review threads")
      .filter((value) => record(value, "review thread").isResolved !== true);
    if (unresolved.length > 0) throw new Error("GitHub pull request has unresolved review threads");
    const workflows = record(workflowReceipt.result, "workflow runs");
    if (text(workflows.commitSha, "workflow runs commit SHA") !== input.expectedHeadSha) {
      throw new Error("GitHub operation workflow runs commit SHA was invalid");
    }
    const workflowRuns = array(workflows.workflowRuns, "workflow runs");
    const currentWorkflowRuns = latestNonSkippedWorkflowRuns(
      workflowRuns,
      input.expectedHeadSha,
    );
    const unready = currentWorkflowRuns.some((run) => {
      return run.status !== "completed"
        || (run.conclusion !== "success" && run.conclusion !== "neutral");
    });
    if (unready) throw new Error("GitHub pull request workflows are not successful");
    const hasSuccessfulWorkflow = currentWorkflowRuns.some(
      (run) => run.status === "completed" && run.conclusion === "success",
    );
    if (statusCount === 0 && !hasSuccessfulWorkflow) {
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

function observationCoverage(
  state: GitHubObservationCoverage["state"],
  requested: readonly string[],
  gaps: readonly string[],
): GitHubObservationCoverage {
  return Object.freeze({
    version: 1,
    state,
    requested: Object.freeze([...requested]),
    gaps: Object.freeze([...gaps]),
  });
}

function operationAvailability(binding: "ready" | "blocked") {
  const availability = (operationBinding: "ready" | "blocked") => Object.freeze({
    capability: "present" as const,
    binding: operationBinding,
    blockedBy: operationBinding === "blocked" ? "project_attachment" as const : null,
  });
  return Object.freeze({
    github_repo_health: availability("ready"),
    github_branch_tidy: availability(binding),
    github_ci_diagnose: availability(binding),
    github_land_pr: Object.freeze({
      ...availability(binding),
      candidatePrerequisites: githubLandPrCandidatePrerequisites,
    }),
  });
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

function latestNonSkippedWorkflowRuns(
  values: readonly unknown[],
  expectedHeadSha: string,
): readonly Readonly<Record<string, unknown>>[] {
  const latest = new Map<string, {
    readonly runs: Readonly<Record<string, unknown>>[];
    readonly createdAt: number;
  }>();
  for (const value of values) {
    const run = record(value, "workflow run");
    integer(run.id, "workflow run ID");
    const workflowId = integer(run.workflowId, "workflow ID");
    const event = text(run.event, "workflow run event");
    if (text(run.headSha, "workflow run head SHA") !== expectedHeadSha) {
      throw new Error("GitHub operation workflow run head SHA was invalid");
    }
    const status = text(run.status, "workflow run status");
    const conclusion = run.conclusion;
    const createdAtText = text(run.createdAt, "workflow run creation time");
    const createdAt = Date.parse(createdAtText);
    if (!Number.isFinite(createdAt) || new Date(createdAt).toISOString() !== createdAtText) {
      throw new Error("GitHub operation workflow run creation time was invalid");
    }
    // Metadata-only workflow runs carry no source evidence. Excluding them here
    // preserves the prior non-skipped result instead of allowing a later skip to
    // hide either a successful or a failed source-validation attempt.
    if (status === "completed" && conclusion === "skipped") continue;
    const cohort = `${workflowId}:${event}`;
    const previous = latest.get(cohort);
    if (!previous || createdAt > previous.createdAt) {
      latest.set(cohort, { runs: [run], createdAt });
    } else if (createdAt === previous.createdAt) {
      previous.runs.push(run);
    }
  }
  return Object.freeze(
    [...latest.values()].flatMap((value) => value.runs.map((run) => Object.freeze(run))),
  );
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
