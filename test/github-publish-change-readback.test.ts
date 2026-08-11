import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  type GitHubPublishChangeInput,
  type GitHubPublishChangeService,
} from "../src/github-publish-change-operation.ts";
import { GitHubPublishChangeReadbackService } from "../src/github-publish-change-readback.ts";
import {
  fingerprintGitHubRepositoryWritePayload,
  type GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service.ts";
import {
  OperationWorkflowPendingReconciliationError,
  type OperationWorkflow,
  type OperationWorkflowStep,
} from "../src/operation-workflow-contracts.ts";

const commit = (digit: string) => digit.repeat(40);

const input: GitHubPublishChangeInput = {
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  actorId: "agent_kite",
  clientId: "codex",
  itemId: "item_1325",
  runId: "run_kite",
  authorityFence: {
    resource: "run:run_kite:generation:1",
    holderId: "agent_kite",
    generation: 1,
    expiresAt: "2026-08-10T00:00:59.000Z",
  },
  branch: "kite/readback",
  fromCommitSha: commit("a"),
  file: {
    operation: "create_file",
    path: "docs/readback.md",
    content: "exact publication body",
    message: "Add readback proof",
  },
  base: "main",
  expectedBaseSha: commit("a"),
  title: "Add publication readback",
  body: "exact pull request body",
  draft: true,
  idempotencyKey: "publish-change:1325",
};

describe("GitHub publish-change readback bridge", () => {
  test("observes a pending branch and re-enters the durable reconciler", async () => {
    const delegate = new FakeDelegate(workflow(1));
    const observed: unknown[] = [];
    const service = new GitHubPublishChangeReadbackService({
      delegate,
      publicationReadback: {
        reconcileBranch: async (request) => {
          observed.push(request);
          return {} as GitHubProviderReceipt;
        },
        reconcilePullRequest: async () => {
          throw new Error("unexpected PR readback");
        },
      },
      repositoryFiles: {
        getRepositoryWriteReceipt: async () => {
          throw new Error("unexpected file receipt read");
        },
        reconcileRepositoryFile: async () => {
          throw new Error("unexpected file readback");
        },
      },
    });

    const result = await service.reconcilePublishChange(input);
    expect(result.state).toBe("succeeded");
    expect(delegate.reconcileCalls).toBe(2);
    expect(observed).toEqual([{
      project: input.project,
      repository: input.repository,
      actorId: input.actorId,
      clientId: input.clientId,
      branch: input.branch,
      fromCommitSha: input.fromCommitSha,
      idempotencyKey: "provider-step-1",
    }]);
  });

  test("uses the verified file receipt as the exact PR head before readback", async () => {
    const delegate = new FakeDelegate(workflow(3));
    const observed: unknown[] = [];
    const service = new GitHubPublishChangeReadbackService({
      delegate,
      publicationReadback: {
        reconcileBranch: async () => {
          throw new Error("unexpected branch readback");
        },
        reconcilePullRequest: async (request) => {
          observed.push(request);
          return {} as GitHubProviderReceipt;
        },
      },
      repositoryFiles: {
        getRepositoryWriteReceipt: async (_project, key) =>
          succeededWriteReceipt(key),
        reconcileRepositoryFile: async () => {
          throw new Error("unexpected file readback");
        },
      },
    });

    const result = await service.reconcilePublishChange(input);
    expect(result.state).toBe("succeeded");
    expect(delegate.reconcileCalls).toBe(2);
    expect(observed).toEqual([{
      project: input.project,
      repository: input.repository,
      actorId: input.actorId,
      clientId: input.clientId,
      title: input.title,
      body: input.body,
      head: input.branch,
      base: input.base,
      expectedHeadSha: commit("b"),
      expectedBaseSha: input.expectedBaseSha,
      draft: true,
      idempotencyKey: "provider-step-3",
    }]);
  });

  test("reconciles the exact pending repository-file request and re-enters the workflow", async () => {
    const pending = workflow(2);
    const delegate = new FakeDelegate(pending);
    let publicationReads = 0;
    const fileReads: unknown[] = [];
    const service = new GitHubPublishChangeReadbackService({
      delegate,
      publicationReadback: {
        reconcileBranch: async () => {
          publicationReads += 1;
          return {} as GitHubProviderReceipt;
        },
        reconcilePullRequest: async () => {
          publicationReads += 1;
          return {} as GitHubProviderReceipt;
        },
      },
      repositoryFiles: {
        getRepositoryWriteReceipt: async () => null,
        reconcileRepositoryFile: async (request) => {
          fileReads.push(request);
          return succeededWriteReceipt(request.idempotencyKey);
        },
      },
    });

    await expect(service.reconcilePublishChange(input)).resolves.toMatchObject({
      state: "succeeded",
    });
    expect(delegate.reconcileCalls).toBe(2);
    expect(publicationReads).toBe(0);
    expect(fileReads).toEqual([{
      project: input.project,
      repository: input.repository,
      actorId: input.actorId,
      clientId: input.clientId,
      operation: "create_file",
      path: input.file.path,
      content: input.file.content,
      message: input.file.message,
      branch: input.branch,
      expectedParentSha: input.fromCommitSha,
      idempotencyKey: "provider-step-2",
    }]);
  });

  test("rejects a changed file receipt before PR provider observation", async () => {
    const delegate = new FakeDelegate(workflow(3));
    let publicationReads = 0;
    const service = new GitHubPublishChangeReadbackService({
      delegate,
      publicationReadback: {
        reconcileBranch: async () => ({} as GitHubProviderReceipt),
        reconcilePullRequest: async () => {
          publicationReads += 1;
          return {} as GitHubProviderReceipt;
        },
      },
      repositoryFiles: {
        getRepositoryWriteReceipt: async (_project, key) => ({
          ...succeededWriteReceipt(key),
          actorId: "another_actor",
        }),
        reconcileRepositoryFile: async () => {
          throw new Error("unexpected file readback");
        },
      },
    });

    await expect(service.reconcilePublishChange(input)).rejects.toMatchObject({
      code: "operation_workflow_conflict",
    });
    expect(delegate.reconcileCalls).toBe(1);
    expect(publicationReads).toBe(0);
  });
});

class FakeDelegate implements GitHubPublishChangeService {
  readonly pending: OperationWorkflow;
  reconcileCalls = 0;

  constructor(pending: OperationWorkflow) {
    this.pending = pending;
  }

  async publishChange(): Promise<OperationWorkflow> {
    return succeededWorkflow(this.pending);
  }

  async reconcilePublishChange(): Promise<OperationWorkflow> {
    this.reconcileCalls += 1;
    if (this.reconcileCalls === 1) {
      throw new OperationWorkflowPendingReconciliationError(this.pending);
    }
    return succeededWorkflow(this.pending);
  }
}

function workflow(pendingOrdinal: 1 | 2 | 3): OperationWorkflow {
  return {
    version: 1,
    id: "opw_readback",
    revision: 4,
    project: input.project,
    itemId: input.itemId,
    runId: input.runId,
    actorId: input.actorId,
    clientId: input.clientId,
    kind: "github_publish_change",
    target: `${input.repository}:refs/heads/${input.branch}`,
    requestSha256: "sha256:" + "1".repeat(64),
    idempotencyKey: input.idempotencyKey,
    state: "waiting_reconciliation",
    steps: ([1, 2, 3] as const).map((ordinal) => step(
      ordinal,
      ordinal === pendingOrdinal
        ? "pending_reconciliation"
        : ordinal < pendingOrdinal ? "verified" : "planned",
    )),
    cancellationRequestedAt: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:04.000Z",
    terminalAt: null,
    recovery: { nextAction: "reconcile_current_step" },
  };
}

function succeededWorkflow(current: OperationWorkflow): OperationWorkflow {
  return {
    ...current,
    revision: current.revision + 1,
    state: "succeeded",
    steps: current.steps.map((candidate) => ({
      ...candidate,
      state: "verified" as const,
      retry: "none" as const,
    })),
    updatedAt: "2026-08-10T00:00:05.000Z",
    terminalAt: "2026-08-10T00:00:05.000Z",
    recovery: { nextAction: "none" },
  };
}

function step(
  ordinal: 1 | 2 | 3,
  state: OperationWorkflowStep["state"],
): OperationWorkflowStep {
  return {
    id: `step-${ordinal}`,
    ordinal,
    kind: ordinal === 1
      ? "github_create_branch"
      : ordinal === 2 ? "github_create_file" : "github_create_pull_request",
    commandId: `command-${ordinal}`,
    commandSha256: "sha256:" + String(ordinal).repeat(64),
    providerIdempotencyKey: `provider-step-${ordinal}`,
    authorityFence: input.authorityFence,
    state,
    reservedAt: state === "planned" ? null : "2026-08-10T00:00:01.000Z",
    settledAt: state === "verified" ? "2026-08-10T00:00:02.000Z" : null,
    providerReceiptRef: state === "verified" ? `receipt-${ordinal}` : null,
    beforeSha256: state === "verified" ? "sha256:" + "4".repeat(64) : null,
    afterSha256: state === "verified" ? "sha256:" + "5".repeat(64) : null,
    verificationSha256: state === "verified" ? "sha256:" + "6".repeat(64) : null,
    errorCode: state === "pending_reconciliation"
      ? "ambiguous_provider_outcome"
      : null,
    retry: state === "pending_reconciliation"
      ? "reconcile_before_retry"
      : "none",
    compensation: {
      disposition: "conditionally_reversible",
      kind: null,
      commandSha256: null,
      state: "not_started",
      providerReceiptRef: null,
    },
  };
}

function succeededWriteReceipt(
  idempotencyKey: string,
): GitHubRepositoryWriteReceipt {
  const requestSha256 = "sha256:" + "5".repeat(64);
  return {
    version: 1,
    id: "ghrw_readback_file",
    project: input.project,
    repositoryFullName: input.repository,
    targetRef: input.branch,
    path: input.file.path,
    operation: "create_file",
    expectedParentSha: input.fromCommitSha,
    requestSha256,
    payloadSha256: fingerprintGitHubRepositoryWritePayload({
      operation: "create_file",
      content: input.file.operation === "create_file" ? input.file.content : "",
      message: input.file.message,
    }),
    actorId: input.actorId,
    clientId: input.clientId,
    idempotencyKey,
    state: "succeeded",
    dispatchCount: 1,
    createdAt: "2026-08-10T00:00:02.000Z",
    updatedAt: "2026-08-10T00:00:03.000Z",
    verified: {
      version: 1,
      state: "verified",
      repositoryFullName: input.repository,
      path: input.file.path,
      operation: "create_file",
      targetRef: input.branch,
      defaultBranch: "main",
      expectedParentSha: input.fromCommitSha,
      authorityId: "authority_readback",
      authorityGeneration: 1,
      defaultBranchApprovalId: null,
      commitSha: commit("b"),
      nextExpectedParentSha: commit("b"),
      providerRequestId: "WRITE:CREATE",
      requestSha256,
      verifiedAt: "2026-08-10T00:00:03.000Z",
      authorizesRetry: false,
    },
    error: null,
  };
}
