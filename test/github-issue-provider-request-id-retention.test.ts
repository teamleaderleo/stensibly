import { describe, expect, test } from "bun:test";
import {
  GitHubIssueProviderService,
  GitHubProviderPendingReconciliationError,
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

const now = "2026-08-03T00:00:00.000Z";
const repositoryFullName = "teamleaderleo/stensibly";
const issueNumber = 525;
const context = {
  project: "stensibly",
  repository: repositoryFullName,
  actorId: "request-id-review",
  clientId: "github-only-test",
};

type Mode = "create" | "update" | "comment" | "set" | "transport";

class RequestIdAdapter implements GitHubIssueProviderAdapter {
  readonly mode: Mode;
  mutationCalls = 0;
  effectReturned = false;
  current = issue();

  constructor(mode: Mode) {
    this.mode = mode;
  }

  async listIssues(): Promise<GitHubIssueProviderPage> {
    return { issues: [], nextCursor: null };
  }

  async searchIssues(): Promise<GitHubIssueProviderPage> {
    return { issues: [], nextCursor: null };
  }

  async getIssue(): Promise<GitHubIssueContextInput> {
    if (this.effectReturned) {
      throw new Error("synthetic-secret-detail from final issue read");
    }
    return structuredClone(this.current);
  }

  async createIssue() {
    this.#beginEffect("create");
    this.current = issue({ title: "Created", sourceRevision: "rev-create" });
    return {
      issue: structuredClone(this.current),
      providerRequestId: "REQ-CREATE",
    };
  }

  async updateIssue() {
    this.#beginEffect("update");
    this.current = issue({ title: "Updated", sourceRevision: "rev-update" });
    return {
      issue: structuredClone(this.current),
      providerRequestId: "REQ-UPDATE",
    };
  }

  async addIssueComment(
    input: Parameters<GitHubIssueProviderAdapter["addIssueComment"]>[0],
  ) {
    this.#beginEffect("comment");
    return {
      comment: comment(input.body),
      providerRequestId: "REQ-COMMENT",
    };
  }

  async getIssueComment(): Promise<GitHubIssueCommentInput> {
    throw new Error("synthetic-secret-detail from final comment read");
  }

  async addIssueLabels(
    input: Parameters<GitHubIssueProviderAdapter["addIssueLabels"]>[0],
  ) {
    this.#beginEffect(this.mode === "transport" ? "transport" : "set");
    this.current = issue({
      labels: [...new Set([...(this.current.labels ?? []), ...input.labels])],
      sourceRevision: "rev-set",
    });
    return {
      issue: structuredClone(this.current),
      providerRequestId: "REQ-SET",
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

  #beginEffect(expected: Mode): void {
    this.mutationCalls += 1;
    if (this.mode !== expected) {
      throw new Error(`unexpected ${expected} mutation for ${this.mode}`);
    }
    if (this.mode === "transport") {
      throw new Error("transport ended before an admissible provider response");
    }
    this.effectReturned = true;
  }
}

describe("GitHub provider request ID retention", () => {
  test("retains the exact request ID for every post-effect verification path", async () => {
    const cases: Array<{
      mode: Exclude<Mode, "transport">;
      requestId: string;
      idempotencyKey: string;
      execute: (
        service: GitHubIssueProviderService,
        idempotencyKey: string,
      ) => Promise<unknown>;
    }> = [
      {
        mode: "create",
        requestId: "REQ-CREATE",
        idempotencyKey: "retain-create-request",
        execute: (service, idempotencyKey) => service.createIssue({
          ...context,
          title: "Created",
          idempotencyKey,
        }),
      },
      {
        mode: "update",
        requestId: "REQ-UPDATE",
        idempotencyKey: "retain-update-request",
        execute: (service, idempotencyKey) => service.updateIssue({
          ...context,
          issueNumber,
          expectedSourceRevision: "rev-before",
          title: "Updated",
          idempotencyKey,
        }),
      },
      {
        mode: "comment",
        requestId: "REQ-COMMENT",
        idempotencyKey: "retain-comment-request",
        execute: (service, idempotencyKey) => service.addIssueComment({
          ...context,
          issueNumber,
          body: "Durable comment",
          idempotencyKey,
        }),
      },
      {
        mode: "set",
        requestId: "REQ-SET",
        idempotencyKey: "retain-set-request",
        execute: (service, idempotencyKey) => service.addIssueLabels({
          ...context,
          issueNumber,
          labels: ["area:github"],
          idempotencyKey,
        }),
      },
    ];

    for (const candidate of cases) {
      const adapter = new RequestIdAdapter(candidate.mode);
      const service = setup(adapter);
      const first = await pendingError(
        candidate.execute(service, candidate.idempotencyKey),
      );
      expect(first.receipt).toMatchObject({
        state: "pending_reconciliation",
        providerRequestId: candidate.requestId,
        error: {
          code: "ambiguous_provider_outcome",
          message:
            "GitHub provider effect requires reconciliation after verification failed",
          retry: "reconcile_before_retry",
        },
      });
      expect(first.receipt.error?.message).not.toContain("synthetic-secret-detail");

      const replay = await pendingError(
        candidate.execute(service, candidate.idempotencyKey),
      );
      expect(replay.receipt).toEqual(first.receipt);
      expect(adapter.mutationCalls).toBe(1);
    }
  });

  test("keeps request identity null when no admissible provider response existed", async () => {
    const adapter = new RequestIdAdapter("transport");
    const service = setup(adapter);
    const error = await pendingError(service.addIssueLabels({
      ...context,
      issueNumber,
      labels: ["area:github"],
      idempotencyKey: "retain-null-before-response",
    }));
    expect(error.receipt).toMatchObject({
      state: "pending_reconciliation",
      providerRequestId: null,
      error: {
        code: "ambiguous_provider_outcome",
        retry: "reconcile_before_retry",
      },
    });
    expect(adapter.mutationCalls).toBe(1);
  });
});

async function pendingError(
  promise: Promise<unknown>,
): Promise<GitHubProviderPendingReconciliationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubProviderPendingReconciliationError);
    return error as GitHubProviderPendingReconciliationError;
  }
  throw new Error("Expected pending reconciliation");
}

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
    now: () => now,
    idFactory: () => `ghop_request_id_${++id}`,
  });
}

function attachment(): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: "stensibly",
    repositories: [repositoryFullName],
    runnerProfiles: [],
    concurrency: { project: 1, global: 2 },
    autonomousActions: ["github_issue_read", "github_issue_write"],
    approvalRequired: [],
    checks: [],
    tags: ["dogfood"],
    relatedProjects: [],
  }, {
    goal: "Retain known provider request identity.",
    boundaries: "One exact repository.",
    evidenceAndHandoff: "Persist deterministic reconciliation evidence.",
    escalation: "Do not echo provider failure payloads.",
  }));
  return {
    id: "patt_request_id",
    project: "stensibly",
    snapshot,
    sourceRevision: "main@request-id",
    acceptedBy: "test",
    authorityWidening: false,
    acceptedAt: now,
  };
}

function binding(
  currentAttachment: ProjectAttachmentRecord,
): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_request_id",
    project: "stensibly",
    repositoryFullName,
    connectionId: "ghconn_request_id",
    attachmentId: currentAttachment.id,
    attachmentSnapshotSha256: currentAttachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: now,
  };
}

function connection(): GitHubProviderConnection {
  return {
    id: "ghconn_request_id",
    provider: "github",
    installationId: "installation_request_id",
    accountLogin: "teamleaderleo",
    credentialRef: "env://TEST_GITHUB_KEY",
    status: "active",
    repositoryFullNames: [repositoryFullName],
    observedAt: now,
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
    createdAt: now,
    updatedAt: now,
    providerNodeId: "I_request_id_525",
    sourceRevision: "rev-before",
    ...overrides,
  };
}

function comment(body: string): GitHubIssueCommentInput {
  return {
    id: "comment-request-id",
    issueNumber,
    body,
    canonicalUrl:
      `https://github.com/${repositoryFullName}/issues/${issueNumber}#issuecomment-1`,
    createdAt: now,
    updatedAt: now,
    sourceRevision: "comment-rev-request-id",
  };
}
