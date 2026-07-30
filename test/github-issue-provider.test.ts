import { describe, expect, test } from "bun:test";
import {
  GitHubIssueProviderService,
  GitHubProviderBindingError,
  GitHubProviderIdempotencyConflictError,
  GitHubProviderPendingReconciliationError,
  InMemoryGitHubProviderReceiptStore,
  type GitHubIssueCommentInput,
  type GitHubIssueProviderAdapter,
  type GitHubIssueProviderPage,
  type GitHubProjectRepositoryBinding,
  type GitHubProviderConnection,
} from "../src/github-issue-provider.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import type { GitHubIssueContextInput } from "../src/github-issue-context.ts";

const fixedNow = "2026-07-31T00:04:00.000Z";
const request = {
  project: "stensibly",
  repository: "https://github.com/teamleaderleo/stensibly.git",
  actorId: "chatgpt",
  clientId: "chatgpt-project",
  capabilityGrantId: "grant_github_issue_write",
};

function attachment(): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: "stensibly",
    repositories: ["teamleaderleo/stensibly"],
    runnerProfiles: [],
    concurrency: { project: 2, global: 4 },
    autonomousActions: ["github_issue_read", "github_issue_write"],
    approvalRequired: [],
    checks: ["bun test test/github-issue-provider.test.ts"],
    tags: ["dogfood"],
    relatedProjects: [],
  }, {
    goal: "Exercise GitHub issue operations through Stensibly.",
    boundaries: "One explicitly attached repository.",
    evidenceAndHandoff: "Retain provider receipts and exact source revisions.",
    escalation: "Escalate access widening and ambiguous provider effects.",
  }));
  return {
    id: "patt_stensibly_1",
    project: "stensibly",
    snapshot,
    sourceRevision: "7500506d6b9d451d12b2f6ef492ac46b496c3d6e",
    acceptedBy: "leo",
    authorityWidening: false,
    acceptedAt: fixedNow,
  };
}

function connection(overrides: Partial<GitHubProviderConnection> = {}): GitHubProviderConnection {
  return {
    id: "ghconn_teamleaderleo_1",
    provider: "github",
    installationId: "12345",
    accountLogin: "teamleaderleo",
    credentialRef: "secret:github-installation:12345",
    status: "active",
    repositoryFullNames: ["teamleaderleo/stensibly"],
    observedAt: fixedNow,
    ...overrides,
  };
}

function binding(
  currentAttachment: ProjectAttachmentRecord,
  overrides: Partial<GitHubProjectRepositoryBinding> = {},
): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_stensibly_1",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    connectionId: "ghconn_teamleaderleo_1",
    attachmentId: currentAttachment.id,
    attachmentSnapshotSha256: currentAttachment.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: fixedNow,
    ...overrides,
  };
}

function issue(
  number: number,
  overrides: Partial<GitHubIssueContextInput> = {},
): GitHubIssueContextInput {
  return {
    owner: "teamleaderleo",
    repository: "stensibly",
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    milestone: null,
    relationships: [],
    createdAt: fixedNow,
    updatedAt: fixedNow,
    providerNodeId: `I_${number}`,
    sourceRevision: `github-rev-${number}-1`,
    ...overrides,
  };
}

class FakeGitHubAdapter implements GitHubIssueProviderAdapter {
  readonly issues = new Map<number, GitHubIssueContextInput>();
  readonly comments = new Map<string, GitHubIssueCommentInput>();
  createCalls = 0;
  updateCalls = 0;
  failReadbackAfterCreate = false;
  nextIssueNumber = 600;
  nextCommentNumber = 1;

  async listIssues(input: {
    repositoryFullName: string;
    state?: "open" | "closed" | "all";
    labels?: string[];
    assignees?: string[];
    cursor?: string;
    limit: number;
  }): Promise<GitHubIssueProviderPage> {
    const issues = [...this.issues.values()]
      .filter((entry) => input.state === undefined || input.state === "all" || entry.state === input.state)
      .slice(0, input.limit)
      .map((entry) => structuredClone(entry));
    return { issues, nextCursor: null };
  }

  async searchIssues(input: {
    repositoryFullName: string;
    query: string;
    state?: "open" | "closed" | "all";
    cursor?: string;
    limit: number;
  }): Promise<GitHubIssueProviderPage> {
    const query = input.query.toLowerCase();
    const issues = [...this.issues.values()]
      .filter((entry) => entry.title.toLowerCase().includes(query))
      .slice(0, input.limit)
      .map((entry) => structuredClone(entry));
    return { issues, nextCursor: null };
  }

  async getIssue(input: {
    repositoryFullName: string;
    issueNumber: number;
  }): Promise<GitHubIssueContextInput> {
    if (this.failReadbackAfterCreate && this.createCalls > 0) {
      throw new Error("simulated readback timeout");
    }
    const current = this.issues.get(input.issueNumber);
    if (!current) throw new Error(`missing issue ${input.issueNumber}`);
    return structuredClone(current);
  }

  async createIssue(input: {
    repositoryFullName: string;
    title: string;
    body?: string;
    labels: string[];
    assignees: string[];
    idempotencyKey: string;
  }) {
    this.createCalls += 1;
    const number = this.nextIssueNumber++;
    const created = issue(number, {
      title: input.title,
      body: input.body ?? null,
      labels: input.labels,
      assignees: input.assignees,
      sourceRevision: `github-create-${number}`,
    });
    this.issues.set(number, created);
    return {
      issue: structuredClone(created),
      providerRequestId: `provider-create-${number}`,
    };
  }

  async updateIssue(input: {
    repositoryFullName: string;
    issueNumber: number;
    title?: string;
    body?: string;
    state?: "open" | "closed";
    stateReason?: "completed" | "not_planned" | "reopened" | null;
    expectedSourceRevision: string;
    idempotencyKey: string;
  }) {
    this.updateCalls += 1;
    const current = await this.getIssue(input);
    const updated = issue(input.issueNumber, {
      ...current,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.stateReason === undefined ? {} : { stateReason: input.stateReason }),
      updatedAt: "2026-07-31T00:05:00.000Z",
      sourceRevision: `${current.sourceRevision}-updated`,
    });
    this.issues.set(input.issueNumber, updated);
    return {
      issue: structuredClone(updated),
      providerRequestId: `provider-update-${input.issueNumber}`,
    };
  }

  async addIssueComment(input: {
    repositoryFullName: string;
    issueNumber: number;
    body: string;
    idempotencyKey: string;
  }) {
    const id = String(this.nextCommentNumber++);
    const comment: GitHubIssueCommentInput = {
      id,
      issueNumber: input.issueNumber,
      body: input.body,
      canonicalUrl: `https://github.com/teamleaderleo/stensibly/issues/${input.issueNumber}#issuecomment-${id}`,
      createdAt: fixedNow,
      updatedAt: fixedNow,
      sourceRevision: `github-comment-${id}`,
    };
    this.comments.set(id, comment);
    return { comment: structuredClone(comment), providerRequestId: `provider-comment-${id}` };
  }

  async getIssueComment(input: {
    repositoryFullName: string;
    issueNumber: number;
    commentId: string;
  }): Promise<GitHubIssueCommentInput> {
    const comment = this.comments.get(input.commentId);
    if (!comment) throw new Error(`missing comment ${input.commentId}`);
    return structuredClone(comment);
  }

  async addIssueLabels(input: {
    repositoryFullName: string;
    issueNumber: number;
    labels: string[];
    idempotencyKey: string;
  }) {
    const current = await this.getIssue(input);
    const updated = issue(input.issueNumber, {
      ...current,
      labels: [...new Set([...(current.labels ?? []), ...input.labels])].sort(),
      sourceRevision: `${current.sourceRevision}-labels-added`,
    });
    this.issues.set(input.issueNumber, updated);
    return { issue: structuredClone(updated) };
  }

  async removeIssueLabel(input: {
    repositoryFullName: string;
    issueNumber: number;
    label: string;
    idempotencyKey: string;
  }) {
    const current = await this.getIssue(input);
    const updated = issue(input.issueNumber, {
      ...current,
      labels: (current.labels ?? []).filter((entry) => entry !== input.label),
      sourceRevision: `${current.sourceRevision}-label-removed`,
    });
    this.issues.set(input.issueNumber, updated);
    return { issue: structuredClone(updated) };
  }

  async addIssueAssignees(input: {
    repositoryFullName: string;
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }) {
    const current = await this.getIssue(input);
    const updated = issue(input.issueNumber, {
      ...current,
      assignees: [...new Set([...(current.assignees ?? []), ...input.assignees])].sort(),
      sourceRevision: `${current.sourceRevision}-assignees-added`,
    });
    this.issues.set(input.issueNumber, updated);
    return { issue: structuredClone(updated) };
  }

  async removeIssueAssignees(input: {
    repositoryFullName: string;
    issueNumber: number;
    assignees: string[];
    idempotencyKey: string;
  }) {
    const current = await this.getIssue(input);
    const updated = issue(input.issueNumber, {
      ...current,
      assignees: (current.assignees ?? []).filter((entry) => !input.assignees.includes(entry)),
      sourceRevision: `${current.sourceRevision}-assignees-removed`,
    });
    this.issues.set(input.issueNumber, updated);
    return { issue: structuredClone(updated) };
  }
}

function setup(options: {
  adapter?: FakeGitHubAdapter;
  currentConnection?: GitHubProviderConnection;
  currentBinding?: GitHubProjectRepositoryBinding;
} = {}) {
  const currentAttachment = attachment();
  const currentConnection = options.currentConnection ?? connection();
  const currentBinding = options.currentBinding ?? binding(currentAttachment);
  const adapter = options.adapter ?? new FakeGitHubAdapter();
  let id = 0;
  const service = new GitHubIssueProviderService({
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
        capabilityGrantId: "grant_github_issue_write",
      }),
    },
    adapter,
    receipts: new InMemoryGitHubProviderReceiptStore(),
    now: () => fixedNow,
    idFactory: () => `ghop_test_${++id}`,
  });
  return { service, adapter, currentAttachment };
}

describe("GitHub issue provider execution core", () => {
  test("creates once, replays the original receipt, and rejects changed key reuse", async () => {
    const { service, adapter } = setup();
    const input = {
      ...request,
      title: "Execute GitHub issues through Stensibly",
      body: "Provider credentials remain server-side.",
      labels: ["area:github", "triage:ready"],
      assignees: ["TeamLeaderLeo"],
      idempotencyKey: "create-github-issue-1",
    };

    const created = await service.createIssue(input);
    expect(created).toMatchObject({
      state: "succeeded",
      operation: "github_create_issue",
      repositoryFullName: "teamleaderleo/stensibly",
      providerRequestId: "provider-create-600",
      verification: { state: "passed" },
    });
    expect(created.result).toMatchObject({
      reference: { externalId: "github:teamleaderleo/stensibly#600" },
      title: input.title,
      labels: ["area:github", "triage:ready"],
      assignees: ["teamleaderleo"],
      containsIssueBody: false,
    });
    expect(JSON.stringify(created)).not.toContain(input.body);
    expect(adapter.createCalls).toBe(1);

    const replay = await service.createIssue(input);
    expect(replay).toEqual(created);
    expect(adapter.createCalls).toBe(1);

    await expect(service.createIssue({
      ...input,
      title: "Changed request under the same key",
    })).rejects.toBeInstanceOf(GitHubProviderIdempotencyConflictError);
    expect(adapter.createCalls).toBe(1);
  });

  test("records a stale guarded update with the current provider revision", async () => {
    const { service, adapter } = setup();
    adapter.issues.set(525, issue(525, {
      title: "Current provider title",
      sourceRevision: "github-current-525",
    }));

    const receipt = await service.updateIssue({
      ...request,
      issueNumber: 525,
      expectedSourceRevision: "github-stale-525",
      title: "Attempted stale title",
      idempotencyKey: "update-github-issue-525-1",
    });

    expect(receipt).toMatchObject({
      state: "stale",
      error: { code: "stale_provider_version", retry: "do_not_retry" },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
      result: { sourceRevision: "github-current-525", title: "Current provider title" },
    });
    expect(adapter.updateCalls).toBe(0);
  });

  test("preserves an ambiguous create and blocks blind replay", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.failReadbackAfterCreate = true;
    const { service } = setup({ adapter });
    const input = {
      ...request,
      title: "Ambiguous provider result",
      idempotencyKey: "create-github-issue-ambiguous-1",
    };

    await expect(service.createIssue(input)).rejects.toBeInstanceOf(
      GitHubProviderPendingReconciliationError,
    );
    expect(adapter.createCalls).toBe(1);
    await expect(service.createIssue(input)).rejects.toBeInstanceOf(
      GitHubProviderPendingReconciliationError,
    );
    expect(adapter.createCalls).toBe(1);
  });

  test("requires current attachment, binding, and installation repository access", async () => {
    const { service } = setup({
      currentConnection: connection({ repositoryFullNames: [] }),
    });

    await expect(service.listIssues({
      ...request,
      limit: 10,
    })).rejects.toBeInstanceOf(GitHubProviderBindingError);
  });

  test("performs exact set readback for labels and assignees", async () => {
    const { service, adapter } = setup();
    adapter.issues.set(525, issue(525, {
      labels: ["area:github"],
      assignees: ["teamleaderleo"],
    }));

    const labels = await service.addIssueLabels({
      ...request,
      issueNumber: 525,
      labels: ["triage:ready"],
      idempotencyKey: "labels-525-1",
    });
    expect(labels.result).toMatchObject({ labels: ["area:github", "triage:ready"] });

    const assignees = await service.removeIssueAssignees({
      ...request,
      issueNumber: 525,
      assignees: ["TeamLeaderLeo"],
      idempotencyKey: "assignees-525-1",
    });
    expect(assignees.result).toMatchObject({ assignees: [] });
  });
});
