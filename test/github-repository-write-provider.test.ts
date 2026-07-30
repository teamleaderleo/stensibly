import { describe, expect, test } from "bun:test";
import {
  GitHubProviderPendingReconciliationError,
  GitHubRepositoryWriteProviderService,
  InMemoryGitHubProviderReceiptStore,
  RepositoryWriteFenceError,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderConnection,
  type GitHubRepositoryWriteAdapter,
  type RepositoryWriteProviderResult,
} from "../src/github-issue-provider.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";

const fixedNow = "2026-07-31T01:45:00.000Z";
const parent = "a".repeat(40);
const createdCommit = "b".repeat(40);
const updatedCommit = "c".repeat(40);
const deletedCommit = "d".repeat(40);
const branch = "rivet/repository-write-fence-test";
const request = {
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  actorId: "rivet",
  clientId: "chatgpt-project",
  capabilityGrantId: "grant_github_repository_write",
};

function attachment(): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: "stensibly",
    repositories: ["teamleaderleo/stensibly"],
    runnerProfiles: [],
    concurrency: { project: 2, global: 4 },
    autonomousActions: ["github_repository_write"],
    approvalRequired: [],
    checks: ["bun test test/github-repository-write-provider.test.ts"],
    tags: ["dogfood"],
    relatedProjects: [],
  }, {
    goal: "Guard repository file writes through Stensibly.",
    boundaries: "One attached repository and an explicit branch.",
    evidenceAndHandoff: "Retain receipts and verified commit ancestry.",
    escalation: "Reconcile every ambiguous repository effect before retry.",
  }));
  return {
    id: "patt_stensibly_repository_write_1",
    project: "stensibly",
    snapshot,
    sourceRevision: "942e18615571fcd1f92d48d1e6cb8245189d5504",
    acceptedBy: "leo",
    authorityWidening: false,
    acceptedAt: fixedNow,
  };
}

function connection(): GitHubProviderConnection {
  return {
    id: "ghconn_teamleaderleo_1",
    provider: "github",
    installationId: "12345",
    accountLogin: "teamleaderleo",
    credentialRef: "secret:github-installation:12345",
    status: "active",
    repositoryFullNames: ["teamleaderleo/stensibly"],
    observedAt: fixedNow,
  };
}

function binding(currentAttachment: ProjectAttachmentRecord): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_stensibly_repository_write_1",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    connectionId: "ghconn_teamleaderleo_1",
    attachmentId: currentAttachment.id,
    attachmentSnapshotSha256: currentAttachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: fixedNow,
  };
}

function intent(
  operation: "create_file" | "update_file" | "delete_file",
  expectedParentSha: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    repositoryFullName: "teamleaderleo/stensibly",
    path: "docs/repository-write-fence-test.md",
    operation,
    declaredTargetRef: branch,
    targetRef: branch,
    defaultBranch: "main",
    expectedParentSha,
    ...overrides,
  };
}

class FakeRepositoryWriteAdapter implements GitHubRepositoryWriteAdapter {
  createCalls = 0;
  updateCalls = 0;
  deleteCalls = 0;
  refReads = 0;
  parentReads = 0;
  refHead = parent;
  readonly parents = new Map<string, string[]>();
  verificationGate: Promise<void> | null = null;
  verificationStarted: (() => void) | null = null;

  async createFile(): Promise<RepositoryWriteProviderResult> {
    this.createCalls += 1;
    this.refHead = createdCommit;
    this.parents.set(createdCommit, [parent]);
    return {
      commitSha: createdCommit,
      parentSha: parent,
      targetRef: branch,
      providerRequestId: "provider-create-file-1",
    };
  }

  async updateFile(): Promise<RepositoryWriteProviderResult> {
    this.updateCalls += 1;
    this.refHead = updatedCommit;
    this.parents.set(updatedCommit, [createdCommit]);
    return {
      commitSha: updatedCommit,
      parentSha: createdCommit,
      targetRef: branch,
      providerRequestId: "provider-update-file-1",
    };
  }

  async deleteFile(): Promise<RepositoryWriteProviderResult> {
    this.deleteCalls += 1;
    this.refHead = deletedCommit;
    this.parents.set(deletedCommit, [updatedCommit]);
    return {
      commitSha: deletedCommit,
      parentSha: updatedCommit,
      targetRef: branch,
      providerRequestId: "provider-delete-file-1",
    };
  }

  async getRefHead(): Promise<string | null> {
    this.refReads += 1;
    this.verificationStarted?.();
    if (this.verificationGate) await this.verificationGate;
    return this.refHead;
  }

  async getCommitParents(input: { commitSha: string }): Promise<string[]> {
    this.parentReads += 1;
    return this.parents.get(input.commitSha) ?? [];
  }
}

function setup(adapter = new FakeRepositoryWriteAdapter()) {
  const currentAttachment = attachment();
  const currentConnection = connection();
  const currentBinding = binding(currentAttachment);
  let id = 0;
  const service = new GitHubRepositoryWriteProviderService({
    projects: {
      getProjectAttachment: async (project) => project === "stensibly"
        ? currentAttachment
        : null,
    },
    bindings: {
      getGitHubProjectRepositoryBinding: async (project, repositoryFullName) =>
        project === "stensibly" && repositoryFullName === "teamleaderleo/stensibly"
          ? currentBinding
          : null,
      getGitHubProviderConnection: async (connectionId) =>
        connectionId === currentConnection.id ? currentConnection : null,
    },
    authority: {
      authorizeGitHubOperation: async () => ({
        allowed: true,
        capabilityGrantId: "grant_github_repository_write",
      }),
    },
    adapter,
    receipts: new InMemoryGitHubProviderReceiptStore(),
    now: () => fixedNow,
    idFactory: () => `ghop_repository_write_${++id}`,
  });
  return { service, adapter };
}

describe("GitHub repository write provider", () => {
  test("rejects branch_name before provider dispatch", async () => {
    const { service, adapter } = setup();
    await expect(service.createFile({
      ...request,
      intent: intent("create_file", parent, { branch_name: "main" }),
      content: "guarded content\n",
      message: "test: reject unknown branch alias",
      idempotencyKey: "repository-write-unknown-branch-name",
    })).rejects.toMatchObject({
      code: "unknown_repository_write_field",
      disposition: "rejected",
      retry: "do_not_retry",
    } satisfies Partial<RepositoryWriteFenceError>);
    expect(adapter.createCalls).toBe(0);
    expect(adapter.refReads).toBe(0);
    expect(adapter.parentReads).toBe(0);
  });

  test("holds the ref lane until the returned commit is verified", async () => {
    const adapter = new FakeRepositoryWriteAdapter();
    let releaseVerification!: () => void;
    adapter.verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    adapter.verificationStarted = verificationStarted;
    const { service } = setup(adapter);

    const first = service.createFile({
      ...request,
      intent: intent("create_file", parent),
      content: "first guarded write\n",
      message: "test: create guarded file",
      idempotencyKey: "repository-write-create-1",
    });
    await started;
    expect(adapter.createCalls).toBe(1);

    await expect(service.updateFile({
      ...request,
      intent: intent("update_file", createdCommit),
      content: "second guarded write\n",
      contentSha: "e".repeat(40),
      message: "test: update guarded file",
      idempotencyKey: "repository-write-update-while-verifying",
    })).rejects.toMatchObject({
      receipt: {
        state: "pending_reconciliation",
        error: {
          code: "repository_write_verification_in_progress",
          retry: "reconcile_before_retry",
        },
      },
    });
    expect(adapter.updateCalls).toBe(0);

    releaseVerification();
    const verified = await first;
    expect(verified).toMatchObject({
      state: "succeeded",
      result: {
        state: "verified",
        targetRef: branch,
        commitSha: createdCommit,
        expectedParentSha: parent,
      },
      verification: {
        state: "passed",
        sourceRevision: createdCommit,
      },
    });
  });

  test("verifies every create, update, and delete dispatch", async () => {
    const { service, adapter } = setup();
    const created = await service.createFile({
      ...request,
      intent: intent("create_file", parent),
      content: "created\n",
      message: "test: create file",
      idempotencyKey: "repository-write-create-sequence",
    });
    const updated = await service.updateFile({
      ...request,
      intent: intent("update_file", createdCommit),
      content: "updated\n",
      contentSha: "e".repeat(40),
      message: "test: update file",
      idempotencyKey: "repository-write-update-sequence",
    });
    const deleted = await service.deleteFile({
      ...request,
      intent: intent("delete_file", updatedCommit),
      contentSha: "f".repeat(40),
      message: "test: delete file",
      idempotencyKey: "repository-write-delete-sequence",
    });

    expect([created, updated, deleted].map((receipt) => receipt.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect([adapter.createCalls, adapter.updateCalls, adapter.deleteCalls]).toEqual([1, 1, 1]);
    expect(adapter.refReads).toBe(3);
    expect(adapter.parentReads).toBe(3);
    expect(deleted.result).toMatchObject({
      operation: "delete_file",
      commitSha: deletedCommit,
      expectedParentSha: updatedCommit,
    });
  });
});
