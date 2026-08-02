import { describe, expect, test } from "bun:test";
import {
  GitHubIssueProviderService,
  GitHubProviderPendingReconciliationError,
  GitHubProviderRejectedError,
  InMemoryGitHubProviderReceiptStore,
  type GitHubIssueCommentInput,
  type GitHubIssueProviderAdapter,
  type GitHubIssueProviderPage,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderConnection,
} from "../src/github-issue-provider.ts";
import type { GitHubIssueContextInput } from "../src/github-issue-context.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";

const fixedNow = "2026-08-03T00:00:00.000Z";
const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const context = {
  project: "stensibly",
  repository: repositoryFullName,
  actorId: "call-local-review",
  clientId: "github-only-test",
};

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

interface PostReadPlan {
  started: Deferred<void>;
  error?: Error;
}

class InterleavingAdapter implements GitHubIssueProviderAdapter {
  current = issue({ labels: ["existing"], title: "Before" });
  readonly updateCalled = new Deferred<void>();
  readonly labelCalled = new Deferred<void>();
  readonly updateRelease = new Deferred<void>();
  readonly labelRelease = new Deferred<void>();
  readonly postReads: PostReadPlan[] = [];
  updateCalls = 0;
  labelCalls = 0;
  ordinaryReads = 0;

  queuePostRead(error?: Error): PostReadPlan {
    const plan = { started: new Deferred<void>(), ...(error ? { error } : {}) };
    this.postReads.push(plan);
    return plan;
  }

  async listIssues(): Promise<GitHubIssueProviderPage> {
    return { issues: [structuredClone(this.current)], nextCursor: null };
  }

  async searchIssues(): Promise<GitHubIssueProviderPage> {
    return { issues: [structuredClone(this.current)], nextCursor: null };
  }

  async getIssue(): Promise<GitHubIssueContextInput> {
    const plan = this.postReads.shift();
    if (plan) {
      plan.started.resolve();
      if (plan.error) throw plan.error;
      return structuredClone(this.current);
    }
    this.ordinaryReads += 1;
    return structuredClone(this.current);
  }

  async createIssue() {
    throw new Error("create is outside this control");
  }

  async updateIssue(input: Parameters<GitHubIssueProviderAdapter["updateIssue"]>[0]) {
    this.updateCalls += 1;
    this.updateCalled.resolve();
    await this.updateRelease.promise;
    this.current = issue({
      ...this.current,
      title: input.title ?? this.current.title,
      sourceRevision: "github-rev-update",
    });
    return {
      issue: structuredClone(this.current),
      providerRequestId: "request-update",
    };
  }

  async addIssueComment() {
    throw new Error("comment is outside this control");
  }

  async getIssueComment(): Promise<GitHubIssueCommentInput> {
    throw new Error("comment is outside this control");
  }

  async addIssueLabels(input: Parameters<GitHubIssueProviderAdapter["addIssueLabels"]>[0]) {
    this.labelCalls += 1;
    this.labelCalled.resolve();
    await this.labelRelease.promise;
    this.current = issue({
      ...this.current,
      labels: [...new Set([...(this.current.labels ?? []), ...input.labels])].sort(),
      sourceRevision: "github-rev-label",
    });
    return {
      issue: structuredClone(this.current),
      providerRequestId: "request-label",
    };
  }

  async removeIssueLabel() {
    throw new Error("remove label is outside this control");
  }

  async addIssueAssignees() {
    throw new Error("add assignees is outside this control");
  }

  async removeIssueAssignees() {
    throw new Error("remove assignees is outside this control");
  }
}

class OutcomeAdapter implements GitHubIssueProviderAdapter {
  current = issue();
  postReadError: Error | null = null;
  mutationError: Error | null = null;
  mutationCalls = 0;
  reads = 0;

  async listIssues(): Promise<GitHubIssueProviderPage> {
    return { issues: [], nextCursor: null };
  }

  async searchIssues(): Promise<GitHubIssueProviderPage> {
    return { issues: [], nextCursor: null };
  }

  async getIssue(): Promise<GitHubIssueContextInput> {
    this.reads += 1;
    if (this.mutationCalls > 0 && this.postReadError) throw this.postReadError;
    return structuredClone(this.current);
  }

  async createIssue() {
    throw new Error("create is outside this control");
  }

  async updateIssue() {
    throw new Error("update is outside this control");
  }

  async addIssueComment() {
    throw new Error("comment is outside this control");
  }

  async getIssueComment(): Promise<GitHubIssueCommentInput> {
    throw new Error("comment is outside this control");
  }

  async addIssueLabels(input: Parameters<GitHubIssueProviderAdapter["addIssueLabels"]>[0]) {
    this.mutationCalls += 1;
    if (this.mutationError) throw this.mutationError;
    this.current = issue({
      labels: [...new Set([...(this.current.labels ?? []), ...input.labels])],
      sourceRevision: "github-rev-effect",
    });
    return {
      issue: structuredClone(this.current),
      providerRequestId: "request-effect",
    };
  }

  async removeIssueLabel() {
    throw new Error("remove label is outside this control");
  }

  async addIssueAssignees() {
    throw new Error("add assignees is outside this control");
  }

  async removeIssueAssignees() {
    throw new Error("remove assignees is outside this control");
  }
}

describe("GitHub provider call-local readback settlement", () => {
  test("keeps update and label settlement independent in both completion orders", async () => {
    for (const first of ["update", "label"] as const) {
      const adapter = new InterleavingAdapter();
      const service = setup(adapter);
      const update = service.updateIssue({
        ...context,
        issueNumber,
        expectedSourceRevision: "github-rev-before",
        title: "After update",
        idempotencyKey: `call-local-update-${first}`,
      });
      const label = service.addIssueLabels({
        ...context,
        issueNumber,
        labels: ["area:github"],
        idempotencyKey: `call-local-label-${first}`,
      });

      await Promise.all([adapter.updateCalled.promise, adapter.labelCalled.promise]);
      const failed = adapter.queuePostRead(
        new GitHubProviderRejectedError(
          "github_resource_not_found",
          "synthetic post-effect 404",
        ),
      );
      if (first === "update") adapter.updateRelease.resolve();
      else adapter.labelRelease.resolve();
      await failed.started.promise;

      const succeeded = adapter.queuePostRead();
      if (first === "update") adapter.labelRelease.resolve();
      else adapter.updateRelease.resolve();
      await succeeded.started.promise;

      const [updateResult, labelResult] = await Promise.allSettled([update, label]);
      const failedResult = first === "update" ? updateResult : labelResult;
      const succeededResult = first === "update" ? labelResult : updateResult;
      expect(failedResult.status).toBe("rejected");
      if (failedResult.status === "rejected") {
        expect(failedResult.reason).toBeInstanceOf(
          GitHubProviderPendingReconciliationError,
        );
      }
      expect(succeededResult.status).toBe("fulfilled");
      if (succeededResult.status === "fulfilled") {
        expect(succeededResult.value.state).toBe("succeeded");
      }
      expect(adapter.updateCalls).toBe(1);
      expect(adapter.labelCalls).toBe(1);
    }
  });

  test("an unrelated read cannot steal or inherit mutation ambiguity", async () => {
    const adapter = new InterleavingAdapter();
    const service = setup(adapter);
    const label = service.addIssueLabels({
      ...context,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "call-local-unrelated-read",
    });
    await adapter.labelCalled.promise;

    const unrelated = await service.getIssue({ ...context, issueNumber });
    expect(unrelated.reference.externalId).toBe(
      `github:${repositoryFullName}#${issueNumber}`,
    );

    const failed = adapter.queuePostRead(
      new GitHubProviderRejectedError(
        "github_request_rejected",
        "synthetic post-effect 422",
      ),
    );
    adapter.labelRelease.resolve();
    await failed.started.promise;
    await expect(label).rejects.toBeInstanceOf(
      GitHubProviderPendingReconciliationError,
    );
    expect(adapter.ordinaryReads).toBe(2);
  });

  test("classifies every post-effect read failure as pending and never redispatches", async () => {
    for (const [name, error] of [
      ["404", new GitHubProviderRejectedError("github_resource_not_found", "404")],
      ["422", new GitHubProviderRejectedError("github_request_rejected", "422")],
      ["503", new Error("503")],
      ["malformed", new TypeError("malformed JSON")],
      ["identity", new RangeError("provider identity changed")],
    ] as const) {
      const adapter = new OutcomeAdapter();
      adapter.postReadError = error;
      const service = setup(adapter);
      const input = {
        ...context,
        issueNumber,
        labels: ["area:github"],
        idempotencyKey: `call-local-post-effect-${name}`,
      };
      await expect(service.addIssueLabels(input)).rejects.toBeInstanceOf(
        GitHubProviderPendingReconciliationError,
      );
      await expect(service.addIssueLabels(input)).rejects.toBeInstanceOf(
        GitHubProviderPendingReconciliationError,
      );
      expect(adapter.mutationCalls).toBe(1);
    }
  });

  test("keeps a provider denial before effect as rejected", async () => {
    const adapter = new OutcomeAdapter();
    adapter.mutationError = new GitHubProviderRejectedError(
      "github_permission_denied",
      "provider denied the mutation",
    );
    const service = setup(adapter);
    const receipt = await service.addIssueLabels({
      ...context,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "call-local-pre-effect-denial",
    });
    expect(receipt).toMatchObject({
      state: "rejected",
      error: {
        code: "github_permission_denied",
        retry: "do_not_retry",
      },
    });
    expect(adapter.mutationCalls).toBe(1);
  });
});

function setup(adapter: GitHubIssueProviderAdapter): GitHubIssueProviderService {
  const currentAttachment = attachment();
  const currentBinding = binding(currentAttachment);
  const currentConnection = connection();
  let id = 0;
  return new GitHubIssueProviderService({
    projects: {
      getProjectAttachment: async (project) =>
        project === "stensibly" ? currentAttachment : null,
    },
    bindings: {
      getGitHubProjectRepositoryBinding: async (project, repository) =>
        project === "stensibly" && repository === repositoryFullName
          ? currentBinding
          : null,
      getGitHubProviderConnection: async (connectionId) =>
        connectionId === currentConnection.id ? currentConnection : null,
    },
    authority: {
      authorizeGitHubOperation: async () => ({ allowed: true }),
    },
    adapter,
    receipts: new InMemoryGitHubProviderReceiptStore(),
    now: () => fixedNow,
    idFactory: () => `ghop_call_local_${++id}`,
  });
}

function attachment(): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: "stensibly",
    repositories: [repositoryFullName],
    runnerProfiles: [],
    concurrency: { project: 2, global: 4 },
    autonomousActions: ["github_issue_read", "github_issue_write"],
    approvalRequired: [],
    checks: [],
    tags: ["dogfood"],
    relatedProjects: [],
  }, {
    goal: "Prove call-local provider settlement.",
    boundaries: "One exact repository.",
    evidenceAndHandoff: "Retain deterministic provider receipts.",
    escalation: "Reconcile every uncertain post-effect read.",
  }));
  return {
    id: "patt_call_local",
    project: "stensibly",
    snapshot,
    sourceRevision: "main@call-local",
    acceptedBy: "test",
    authorityWidening: false,
    acceptedAt: fixedNow,
  };
}

function binding(
  currentAttachment: ProjectAttachmentRecord,
): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_call_local",
    project: "stensibly",
    repositoryFullName,
    connectionId: "ghconn_call_local",
    attachmentId: currentAttachment.id,
    attachmentSnapshotSha256: currentAttachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: fixedNow,
  };
}

function connection(): GitHubProviderConnection {
  return {
    id: "ghconn_call_local",
    provider: "github",
    installationId: "installation_call_local",
    accountLogin: "teamleaderleo",
    credentialRef: "env://TEST_GITHUB_KEY",
    status: "active",
    repositoryFullNames: [repositoryFullName],
    observedAt: fixedNow,
  };
}

function issue(
  overrides: Partial<GitHubIssueContextInput> = {},
): GitHubIssueContextInput {
  return {
    owner: "teamleaderleo",
    repository: "stensibly",
    number: issueNumber,
    title: "Before",
    body: "Body",
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    milestone: null,
    relationships: [],
    createdAt: fixedNow,
    updatedAt: fixedNow,
    providerNodeId: "I_call_local_525",
    sourceRevision: "github-rev-before",
    ...overrides,
  };
}
