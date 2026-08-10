import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { captureDataMethod } from "./captured-data-method.js";
import { registerGitHubCapabilityTools } from "./github-capability-mcp.js";
import type { GitHubIssueContext } from "./github-issue-context.js";
import type {
  GitHubProviderReceipt,
  GitHubProviderRequestContext,
} from "./github-provider-contracts.js";
import type {
  GitHubRepositoryWriteReceipt,
} from "./github-repository-write-provider-service.js";
import type { WorkLedger } from "./ledger.js";
import { asToolResult } from "./mcp-tool-result.js";
import type { McpRequestContext } from "./mcp-context.js";
import type { GitHubPublishChangeService } from "./github-publish-change-operation.js";
import type { GitHubOperationsService } from "./github-operations.js";
import { operationWorkflowStore } from "./operation-workflow-contracts.js";
import { runnerLedger } from "./runner-contracts.js";
import {
  principalAuthorizationId,
  principalCanAccessProject,
  principalHasScope,
} from "./token-contracts.js";

const maximumGitHubIssueNumber = 2_147_483_647;

function githubPublishChangeInputSchema() {
  return {
    project: projectSchema(),
    repository: repositorySchema(),
    runId: z.string().trim().min(1).max(240),
    branch: branchSchema(),
    fromCommitSha: commitShaSchema(),
    file: z.discriminatedUnion("operation", [
      z.object({
        operation: z.literal("create_file"),
        path: repositoryPathSchema(),
        content: repositoryFileContentSchema(),
        message: commitMessageSchema(),
      }).strict(),
      z.object({
        operation: z.literal("update_file"),
        path: repositoryPathSchema(),
        contentSha: commitShaSchema(),
        content: repositoryFileContentSchema(),
        message: commitMessageSchema(),
      }).strict(),
    ]),
    base: branchSchema(),
    expectedBaseSha: commitShaSchema(),
    title: z.string().trim().min(1).max(256),
    body: z.string().max(128 * 1024).optional(),
    draft: z.boolean().default(true),
    idempotencyKey: idempotencyKeySchema(),
  };
}

export interface GitHubIssueProviderReadService {
  listIssues(input: GitHubProviderRequestContext & {
    state?: "open" | "closed" | "all";
    labels?: string[];
    assignees?: string[];
    cursor?: string;
    limit?: number;
  }): Promise<{ issues: GitHubIssueContext[]; nextCursor: string | null }>;
  searchIssues(input: GitHubProviderRequestContext & {
    query: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    limit?: number;
  }): Promise<{ issues: GitHubIssueContext[]; nextCursor: string | null }>;
  getIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
  }): Promise<GitHubIssueContext>;
}

export interface GitHubIssueProviderWriteService {
  createIssue(input: GitHubProviderRequestContext & {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  updateIssue(input: GitHubProviderRequestContext & {
    issueNumber: number;
    expectedSourceRevision: string;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened" | null;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  addIssueComment(input: GitHubProviderRequestContext & {
    issueNumber: number;
    body: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
}

export interface GitHubProviderReceiptLookupService {
  getGitHubProviderReceipt(
    project: string,
    idempotencyKey: string,
  ): Promise<GitHubProviderReceipt | null>;
}

export interface GitHubPublicationProviderWriteService {
  createBranch(input: GitHubProviderRequestContext & {
    branch: string;
    fromCommitSha: string;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
  createPullRequest(input: GitHubProviderRequestContext & {
    title: string;
    body?: string;
    head: string;
    base: string;
    expectedHeadSha: string;
    expectedBaseSha: string;
    draft?: boolean;
    idempotencyKey: string;
  }): Promise<GitHubProviderReceipt>;
}

export interface GitHubRepositoryFileWriteService {
  createRepositoryFile(input: GitHubProviderRequestContext & {
    path: string;
    branch: string;
    expectedParentSha: string;
    content: string;
    message: string;
    idempotencyKey: string;
  }): Promise<GitHubRepositoryWriteReceipt>;
  updateRepositoryFile(input: GitHubProviderRequestContext & {
    path: string;
    branch: string;
    expectedParentSha: string;
    contentSha: string;
    content: string;
    message: string;
    idempotencyKey: string;
  }): Promise<GitHubRepositoryWriteReceipt>;
}

export function withGitHubRepositoryFileWriteService<T extends object>(
  target: T,
  service: GitHubRepositoryFileWriteService,
): T & GitHubRepositoryFileWriteService {
  return Object.assign(target, {
    createRepositoryFile: service.createRepositoryFile.bind(service),
    updateRepositoryFile: service.updateRepositoryFile.bind(service),
  });
}

export function withGitHubPublicationProviderWriteService<T extends object>(
  target: T,
  service: GitHubPublicationProviderWriteService,
): T & GitHubPublicationProviderWriteService {
  return Object.assign(target, {
    createBranch: service.createBranch.bind(service),
    createPullRequest: service.createPullRequest.bind(service),
  });
}

export function withGitHubIssueProviderWriteService<T extends object>(
  target: T,
  service: GitHubIssueProviderWriteService,
): T & GitHubIssueProviderWriteService {
  return Object.assign(target, {
    createIssue: service.createIssue.bind(service),
    updateIssue: service.updateIssue.bind(service),
    addIssueComment: service.addIssueComment.bind(service),
  });
}

export function withGitHubIssueProviderReadService<T extends object>(
  target: T,
  service: GitHubIssueProviderReadService,
): T & GitHubIssueProviderReadService {
  return Object.assign(target, {
    listIssues: service.listIssues.bind(service),
    searchIssues: service.searchIssues.bind(service),
    getIssue: service.getIssue.bind(service),
  });
}

export function registerGitHubIssueProviderTools(
  server: McpServer,
  ledger: WorkLedger,
  context: McpRequestContext,
): void {
  registerGitHubCapabilityTools(server, ledger, context);

  server.registerTool(
    "github_repo_health",
    {
      description: "Answer whether one accepted GitHub repository is ready for agent work: live provider connectivity, attachment/binding identity, default branch and exact head, repository state, catalogue identity, and the outcome-oriented operation surface. This is read-only and authorizes no mutation.",
      inputSchema: { project: projectSchema(), repository: repositorySchema() },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => operationsService(ledger).githubRepoHealth(
      providerContext(context, input.project, input.repository, "read"),
    )),
  );

  server.registerTool(
    "github_branch_tidy",
    {
      description: "Build a bounded, exact-SHA branch-cleanup plan. Candidates are eligible only when unprotected, fully contained in the default branch, old enough, and without an open pull request. The result includes recovery refs and never deletes a branch or authorizes mutation.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        minimumAgeDays: z.number().int().min(0).max(3650).default(14),
        maximumBranches: z.number().int().min(1).max(50).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => operationsService(ledger).githubBranchTidy({
      ...providerContext(context, input.project, input.repository, "read"),
      minimumAgeDays: input.minimumAgeDays,
      maximumBranches: input.maximumBranches,
    })),
  );

  server.registerTool(
    "github_ci_diagnose",
    {
      description: "Diagnose CI for one pull request by following its exact head through combined statuses, workflow runs, failed jobs, and optionally bounded failed-step metadata. Returns stable GitHub identities and a normalized healthy, pending, or failing verdict; authorizes no mutation.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        pullRequestNumber: z.number().int().min(1).max(maximumGitHubIssueNumber),
        includeJobSteps: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => operationsService(ledger).githubCiDiagnose({
      ...providerContext(context, input.project, input.repository, "read"),
      pullRequestNumber: input.pullRequestNumber,
      includeJobSteps: input.includeJobSteps,
    })),
  );

  server.registerTool(
    "github_land_pr",
    {
      description: "Land one pull request through a durable operation. Requires a current runner lease, an atomically fenced expected head, a freshly observed expected base, clean mergeability, positive successful CI evidence, no unresolved review threads, a pre-dispatch durable reservation, and post-merge base-parent verification. A base race requires reconciliation. Branch cleanup is separate.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        runId: z.string().trim().min(1).max(240),
        pullRequestNumber: z.number().int().min(1).max(maximumGitHubIssueNumber),
        expectedHeadSha: commitShaSchema(),
        expectedBaseSha: commitShaSchema(),
        method: z.enum(["merge", "squash"]).default("squash"),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    async (input) => asToolResult(async () => {
      const identity = providerContext(context, input.project, input.repository, "write");
      const runs = runnerLedger(ledger);
      if (!runs) throw new Error("GitHub land PR requires the runner ledger");
      const run = await runs.getRun(input.runId);
      if (!run.leaseExpiresAt || !run.leaseOwnerId) {
        throw new Error("GitHub land PR requires an active runner lease");
      }
      const detail = await ledger.getItem(run.itemId);
      if (detail.item.project !== input.project) {
        throw new Error("GitHub land PR run belongs to another project");
      }
      return operationsService(ledger).githubLandPr({
        ...identity,
        itemId: run.itemId,
        runId: run.id,
        authorityFence: {
          resource: `run:${run.id}:generation:${run.generation}`,
          holderId: identity.actorId,
          generation: run.leaseGeneration,
          expiresAt: run.leaseExpiresAt,
        },
        pullRequestNumber: input.pullRequestNumber,
        expectedHeadSha: input.expectedHeadSha,
        expectedBaseSha: input.expectedBaseSha,
        method: input.method,
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );

  server.registerTool(
    "github_list_issues",
    {
      description: "List a bounded page of GitHub issues from one repository bound to a Stensibly project. Pull requests and issue bodies stay outside the result.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
        assignees: z.array(z.string().trim().min(1).max(39)).max(100).optional(),
        cursor: z.string().trim().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => readService(ledger).listIssues({
      ...providerContext(context, input.project, input.repository, "read"),
      state: input.state,
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.assignees ? { assignees: input.assignees } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    })),
  );

  server.registerTool(
    "github_search_issues",
    {
      description: "Search GitHub issues inside one repository bound to a Stensibly project. Repository and issue-only qualifiers are enforced by the MCP boundary.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        query: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .refine(
            (value) => !/\b[A-Za-z][A-Za-z0-9_-]*:/.test(value),
            "GitHub issue search query cannot contain provider qualifiers",
          ),
        state: z.enum(["open", "closed", "all"]).default("all"),
        cursor: z.string().trim().min(1).max(512).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => readService(ledger).searchIssues({
      ...providerContext(context, input.project, input.repository, "read"),
      query: input.query,
      state: input.state,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit,
    })),
  );

  server.registerTool(
    "github_get_issue",
    {
      description: "Read one exact GitHub issue from a repository bound to a Stensibly project, with canonical identity and provider revision evidence while omitting the issue body.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: issueNumberSchema(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(() => readService(ledger).getIssue({
      ...providerContext(context, input.project, input.repository, "read"),
      issueNumber: input.issueNumber,
    })),
  );

  server.registerTool(
    "github_create_issue",
    {
      description: "Create one GitHub issue with optional initial labels and assignees in the repository bound to a Stensibly project. Requires write scope and an explicit idempotency key.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        title: z.string().trim().min(1).max(256),
        body: z.string().max(128 * 1024).optional(),
        labels: uniqueLabelsSchema().optional(),
        assignees: uniqueAssigneesSchema().optional(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => writeService(ledger).createIssue({
      ...providerContext(context, input.project, input.repository, "write"),
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      labels: input.labels ?? [],
      assignees: input.assignees ?? [],
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_update_issue",
    {
      description: "Update the title, body, or state of one exact GitHub issue using the last provider source revision as an optimistic-concurrency fence. Requires write scope and an explicit idempotency key.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: issueNumberSchema(),
        expectedSourceRevision: sourceRevisionSchema(),
        title: z.string().trim().min(1).max(256).optional(),
        body: z.string().max(128 * 1024).optional(),
        state: z.enum(["open", "closed"]).optional(),
        stateReason: z
          .enum(["completed", "not_planned", "reopened"])
          .nullable()
          .optional(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => writeService(ledger).updateIssue({
      ...providerContext(context, input.project, input.repository, "write"),
      issueNumber: input.issueNumber,
      expectedSourceRevision: input.expectedSourceRevision,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.stateReason === undefined
        ? {}
        : { stateReason: input.stateReason }),
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "github_add_issue_comment",
    {
      description: "Add one bounded comment to an exact GitHub issue. Requires write scope and an explicit idempotency key; the returned durable receipt omits the comment body.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        issueNumber: issueNumberSchema(),
        body: z.string().min(1).max(64 * 1024),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() => writeService(ledger).addIssueComment({
      ...providerContext(context, input.project, input.repository, "write"),
      issueNumber: input.issueNumber,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })),
  );

  server.registerTool(
    "get_github_provider_receipt",
    {
      description: "Reconcile one GitHub provider operation by project, repository, and idempotency key. Returns a bounded durable receipt only when it belongs to the authenticated actor and client; foreign or absent receipts return null.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const identity = providerContext(
        context,
        input.project,
        input.repository,
        "read",
      );
      const receipt = await receiptLookupService(ledger).getGitHubProviderReceipt(
        input.project,
        input.idempotencyKey,
      );
      if (
        !receipt
        || receipt.repositoryFullName !== input.repository.toLowerCase()
        || receipt.actorId !== identity.actorId
        || receipt.clientId !== identity.clientId
      ) {
        return null;
      }
      return receipt;
    }),
  );

  server.registerTool(
    "get_github_repository_write_receipt",
    {
      description: "Reconcile one native GitHub repository-file write by project, repository, and idempotency key. Returns a bounded durable receipt only when it belongs to the authenticated actor and client; foreign or absent receipts return null.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      const identity = providerContext(
        context,
        input.project,
        input.repository,
        "read",
      );
      const receipt = await repositoryWriteReceiptLookup(ledger)(
        input.project,
        input.idempotencyKey,
      );
      if (
        !receipt
        || receipt.repositoryFullName !== input.repository.toLowerCase()
        || receipt.actorId !== identity.actorId
        || receipt.clientId !== identity.clientId
      ) {
        return null;
      }
      return receipt;
    }),
  );

  server.registerTool(
    "github_create_branch",
    {
      description: "Create one absent GitHub branch at an exact commit in the repository bound to a Stensibly project. Requires write scope and an explicit idempotency key.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        branch: branchSchema(),
        fromCommitSha: commitShaSchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() =>
      publicationWriteService(ledger).createBranch({
        ...providerContext(context, input.project, input.repository, "write"),
        branch: input.branch,
        fromCommitSha: input.fromCommitSha,
        idempotencyKey: input.idempotencyKey,
      })
    ),
  );

  server.registerTool(
    "github_create_file",
    {
      description: "Create one absent UTF-8 file on an existing non-default GitHub branch through an exact expected-parent compare-and-swap. Requires write scope and an explicit idempotency key.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        path: repositoryPathSchema(),
        branch: branchSchema(),
        expectedParentSha: commitShaSchema(),
        content: repositoryFileContentSchema(),
        message: commitMessageSchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() =>
      repositoryFileWriteService(ledger).createRepositoryFile({
        ...providerContext(context, input.project, input.repository, "write"),
        path: input.path,
        branch: input.branch,
        expectedParentSha: input.expectedParentSha,
        content: boundedRepositoryFileContent(input.content),
        message: input.message,
        idempotencyKey: input.idempotencyKey,
      })
    ),
  );

  server.registerTool(
    "github_create_pull_request",
    {
      description: "Create one GitHub pull request between two exact repository branch revisions. Requires write scope, optimistic head/base commit fences, and an explicit idempotency key; the durable receipt omits the body.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        title: z.string().trim().min(1).max(256),
        body: z.string().max(128 * 1024).optional(),
        head: branchSchema(),
        base: branchSchema(),
        expectedHeadSha: commitShaSchema(),
        expectedBaseSha: commitShaSchema(),
        draft: z.boolean().default(false),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() =>
      publicationWriteService(ledger).createPullRequest({
        ...providerContext(context, input.project, input.repository, "write"),
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        head: input.head,
        base: input.base,
        expectedHeadSha: input.expectedHeadSha,
        expectedBaseSha: input.expectedBaseSha,
        draft: input.draft,
        idempotencyKey: input.idempotencyKey,
      })
    ),
  );

  server.registerTool(
    "github_update_file",
    {
      description: "Update one existing UTF-8 file on a non-default GitHub branch through exact expected-parent and existing-blob compare-and-swap fences. Requires write scope and an explicit idempotency key.",
      inputSchema: {
        project: projectSchema(),
        repository: repositorySchema(),
        path: repositoryPathSchema(),
        branch: branchSchema(),
        expectedParentSha: commitShaSchema(),
        contentSha: commitShaSchema(),
        content: repositoryFileContentSchema(),
        message: commitMessageSchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(() =>
      repositoryFileWriteService(ledger).updateRepositoryFile({
        ...providerContext(context, input.project, input.repository, "write"),
        path: input.path,
        branch: input.branch,
        expectedParentSha: input.expectedParentSha,
        contentSha: input.contentSha,
        content: boundedRepositoryFileContent(input.content),
        message: input.message,
        idempotencyKey: input.idempotencyKey,
      })
    ),
  );

  server.registerTool(
    "github_publish_change",
    {
      description: "Publish one bounded GitHub change as a durable operation: create an exact branch, create or update one file through an exact-parent fence, then open an exact-head/base pull request. Every provider step is reserved before dispatch; ambiguous outcomes stop for reconciliation. Requires a current Stensibly runner lease owned by this MCP principal.",
      inputSchema: githubPublishChangeInputSchema(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(async () => {
      const identity = providerContext(
        context,
        input.project,
        input.repository,
        "write",
      );
      const runs = runnerLedger(ledger);
      if (!runs) throw new Error("GitHub publish change requires the runner ledger");
      const run = await runs.getRun(input.runId);
      if (!run.leaseExpiresAt || !run.leaseOwnerId) {
        throw new Error("GitHub publish change requires an active runner lease");
      }
      const detail = await ledger.getItem(run.itemId);
      if (detail.item.project !== input.project) {
        throw new Error("GitHub publish change run belongs to another project");
      }
      return await publishChangeService(ledger).publishChange({
        ...identity,
        itemId: run.itemId,
        runId: run.id,
        authorityFence: {
          resource: `run:${run.id}:generation:${run.generation}`,
          holderId: identity.actorId,
          generation: run.leaseGeneration,
          expiresAt: run.leaseExpiresAt,
        },
        branch: input.branch,
        fromCommitSha: input.fromCommitSha,
        file: input.file,
        base: input.base,
        expectedBaseSha: input.expectedBaseSha,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        draft: input.draft,
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );

  server.registerTool(
    "reconcile_github_publish_change",
    {
      description: "Reconcile one interrupted GitHub publish-change workflow from its durable provider receipt. Resubmit the exact original bounded request so Stensibly can recompute every digest without retaining file or pull-request bodies. This never redispatches a GitHub mutation; ambiguous provider receipts remain blocked.",
      inputSchema: githubPublishChangeInputSchema(),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async (input) => asToolResult(async () => {
      const identity = providerContext(
        context,
        input.project,
        input.repository,
        "write",
      );
      const runs = runnerLedger(ledger);
      if (!runs) throw new Error("GitHub publish change reconciliation requires the runner ledger");
      const run = await runs.getRun(input.runId);
      if (!run.leaseExpiresAt || !run.leaseOwnerId) {
        throw new Error("GitHub publish change reconciliation requires an active runner lease");
      }
      const detail = await ledger.getItem(run.itemId);
      if (detail.item.project !== input.project) {
        throw new Error("GitHub publish change reconciliation run belongs to another project");
      }
      return await publishChangeService(ledger).reconcilePublishChange({
        ...identity,
        itemId: run.itemId,
        runId: run.id,
        authorityFence: {
          resource: `run:${run.id}:generation:${run.generation}`,
          holderId: identity.actorId,
          generation: run.leaseGeneration,
          expiresAt: run.leaseExpiresAt,
        },
        branch: input.branch,
        fromCommitSha: input.fromCommitSha,
        file: input.file,
        base: input.base,
        expectedBaseSha: input.expectedBaseSha,
        title: input.title,
        ...(input.body === undefined ? {} : { body: input.body }),
        draft: input.draft,
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );

  server.registerTool(
    "get_operation_workflow",
    {
      description: "Read one durable operation workflow by exact project and idempotency key. Returns content-minimised step state, authority fences, evidence digests, provider receipt references, and compensation status.",
      inputSchema: {
        project: projectSchema(),
        idempotencyKey: idempotencyKeySchema(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => asToolResult(async () => {
      assertProjectAccess(context, input.project, "read");
      const workflows = operationWorkflowStore(ledger);
      if (!workflows) throw new Error("Operation workflows are unavailable on this backend");
      return await workflows.getOperationWorkflow(input.project, input.idempotencyKey);
    }),
  );
}

function readService(ledger: WorkLedger): GitHubIssueProviderReadService {
  if (!hasReadService(ledger)) {
    throw new Error(
      "GitHub issue provider reads are unavailable because this backend has no mounted provider service",
    );
  }
  return ledger;
}

function operationsService(ledger: WorkLedger): GitHubOperationsService {
  const githubRepoHealth = captureDataMethod(ledger, "githubRepoHealth");
  const githubBranchTidy = captureDataMethod(ledger, "githubBranchTidy");
  const githubCiDiagnose = captureDataMethod(ledger, "githubCiDiagnose");
  const githubLandPr = captureDataMethod(ledger, "githubLandPr");
  if (!githubRepoHealth || !githubBranchTidy || !githubCiDiagnose || !githubLandPr) {
    throw new Error("GitHub operations are unavailable on this backend");
  }
  return Object.freeze({
    githubRepoHealth: githubRepoHealth as GitHubOperationsService["githubRepoHealth"],
    githubBranchTidy: githubBranchTidy as GitHubOperationsService["githubBranchTidy"],
    githubCiDiagnose: githubCiDiagnose as GitHubOperationsService["githubCiDiagnose"],
    githubLandPr: githubLandPr as GitHubOperationsService["githubLandPr"],
  });
}

function writeService(ledger: WorkLedger): GitHubIssueProviderWriteService {
  const createIssue = captureDataMethod(ledger, "createIssue");
  const updateIssue = captureDataMethod(ledger, "updateIssue");
  const addIssueComment = captureDataMethod(ledger, "addIssueComment");
  if (!createIssue || !updateIssue || !addIssueComment) {
    throw new Error(
      "GitHub issue provider writes are unavailable because this backend has no enabled provider write service",
    );
  }
  return Object.freeze({
    createIssue: createIssue as GitHubIssueProviderWriteService["createIssue"],
    updateIssue: updateIssue as GitHubIssueProviderWriteService["updateIssue"],
    addIssueComment:
      addIssueComment as GitHubIssueProviderWriteService["addIssueComment"],
  });
}

function receiptLookupService(
  ledger: WorkLedger,
): GitHubProviderReceiptLookupService {
  const get = captureDataMethod(ledger, "getGitHubProviderReceipt");
  if (!get) {
    throw new Error("GitHub provider receipts are unavailable on this backend");
  }
  return Object.freeze({
    getGitHubProviderReceipt:
      get as GitHubProviderReceiptLookupService["getGitHubProviderReceipt"],
  });
}

function publicationWriteService(
  ledger: WorkLedger,
): GitHubPublicationProviderWriteService {
  const createBranch = captureDataMethod(ledger, "createBranch");
  const createPullRequest = captureDataMethod(ledger, "createPullRequest");
  if (!createBranch || !createPullRequest) {
    throw new Error(
      "GitHub publication writes are unavailable because this backend has no enabled publication service",
    );
  }
  return Object.freeze({
    createBranch:
      createBranch as GitHubPublicationProviderWriteService["createBranch"],
    createPullRequest:
      createPullRequest as GitHubPublicationProviderWriteService["createPullRequest"],
  });
}

function repositoryFileWriteService(
  ledger: WorkLedger,
): GitHubRepositoryFileWriteService {
  const createRepositoryFile = captureDataMethod(ledger, "createRepositoryFile");
  const updateRepositoryFile = captureDataMethod(ledger, "updateRepositoryFile");
  if (!createRepositoryFile || !updateRepositoryFile) {
    throw new Error(
      "GitHub repository-file writes are unavailable because this backend has no enabled exact-CAS file service",
    );
  }
  return Object.freeze({
    createRepositoryFile:
      createRepositoryFile as GitHubRepositoryFileWriteService["createRepositoryFile"],
    updateRepositoryFile:
      updateRepositoryFile as GitHubRepositoryFileWriteService["updateRepositoryFile"],
  });
}

function publishChangeService(ledger: WorkLedger): GitHubPublishChangeService {
  const publishChange = captureDataMethod(ledger, "publishChange");
  const reconcilePublishChange = captureDataMethod(ledger, "reconcilePublishChange");
  if (!publishChange || !reconcilePublishChange) {
    throw new Error("GitHub publish change is unavailable on this backend");
  }
  return Object.freeze({
    publishChange: publishChange as GitHubPublishChangeService["publishChange"],
    reconcilePublishChange:
      reconcilePublishChange as GitHubPublishChangeService["reconcilePublishChange"],
  });
}

function repositoryWriteReceiptLookup(
  ledger: WorkLedger,
): (
  project: string,
  idempotencyKey: string,
) => Promise<GitHubRepositoryWriteReceipt | null> {
  const get = captureDataMethod(ledger, "getRepositoryWriteReceipt");
  if (!get) {
    throw new Error(
      "GitHub repository-write receipts are unavailable on this backend",
    );
  }
  return get as (
    project: string,
    idempotencyKey: string,
  ) => Promise<GitHubRepositoryWriteReceipt | null>;
}

function hasReadService(value: unknown): value is WorkLedger & GitHubIssueProviderReadService {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GitHubIssueProviderReadService>;
  return typeof candidate.listIssues === "function"
    && typeof candidate.searchIssues === "function"
    && typeof candidate.getIssue === "function";
}

function providerContext(
  context: McpRequestContext,
  project: string,
  repository: string,
  requiredScope: "read" | "write",
): GitHubProviderRequestContext {
  const principal = context.principal;
  if (!principal) {
    throw new Error(
      "GitHub issue provider operations require an authenticated remote MCP principal",
    );
  }
  if (!principalHasScope(principal, requiredScope)) {
    throw new Error(
      `GitHub issue provider operations require ${requiredScope} scope`,
    );
  }
  if (!principalCanAccessProject(principal, project)) {
    throw new Error(
      "GitHub issue provider operation is outside this principal's project scope",
    );
  }
  const tokenIdentity = `api-token:${principalAuthorizationId(principal)}`;
  return {
    project,
    repository,
    actorId: tokenIdentity,
    clientId: `mcp:${tokenIdentity}`,
  };
}

function assertProjectAccess(
  context: McpRequestContext,
  project: string,
  requiredScope: "read" | "write",
): void {
  const principal = context.principal;
  if (!principal) throw new Error("Operation workflows require an authenticated remote MCP principal");
  if (!principalHasScope(principal, requiredScope)) {
    throw new Error(`Operation workflows require ${requiredScope} scope`);
  }
  if (!principalCanAccessProject(principal, project)) {
    throw new Error("Operation workflow is outside this principal's project scope");
  }
}

function projectSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a lowercase project slug");
}

function repositoryPathSchema() {
  return z.string().min(1).max(4_096);
}

function repositoryFileContentSchema() {
  return z.string().max(256 * 1024);
}

function commitMessageSchema() {
  return z.string().trim().min(1).max(256);
}

function boundedRepositoryFileContent(value: string): string {
  if (new TextEncoder().encode(value).byteLength > 256 * 1024) {
    throw new RangeError("GitHub repository file content exceeds 256 KiB");
  }
  return value;
}

function repositorySchema() {
  return z
    .string()
    .trim()
    .min(3)
    .max(200)
    .regex(
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
      "Use a GitHub owner/repository identifier",
    );
}

function issueNumberSchema() {
  return z.number().int().min(1).max(maximumGitHubIssueNumber);
}

function labelSchema() {
  return z.string().trim().min(1).max(100);
}

function loginSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(39)
    .regex(
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,
      "Use a GitHub login",
    )
    .refine((value) => !value.includes("--"), "Use a GitHub login");
}

function uniqueLabelsSchema() {
  return z
    .array(labelSchema())
    .max(100)
    .refine(
      (values) => new Set(values).size === values.length,
      "GitHub labels must be unique",
    );
}

function uniqueAssigneesSchema() {
  return z
    .array(loginSchema())
    .max(10)
    .refine(
      (values) => new Set(values.map((value) => value.toLowerCase())).size === values.length,
      "GitHub assignees must be unique",
    );
}

function idempotencyKeySchema() {
  return z.string().trim().min(1).max(240);
}

function sourceRevisionSchema() {
  return z.string().regex(/^sha256:[a-f0-9]{64}$/);
}

function commitShaSchema() {
  return z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
}

function branchSchema() {
  return z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine((value) =>
      value !== "@"
      && value !== "HEAD"
      && !value.startsWith("refs/heads/")
      && !value.startsWith("/")
      && !value.endsWith("/")
      && !value.startsWith("-")
      && !value.includes("//")
      && !value.includes("..")
      && !value.includes("@{")
      && !/[~^:?*\[\\\s]/u.test(value)
      && value.split("/").every((segment) =>
        segment.length > 0
        && segment !== "."
        && segment !== ".."
        && !segment.startsWith(".")
        && !segment.endsWith(".")
        && !segment.endsWith(".lock")
      ), "Use a valid GitHub branch name");
}
