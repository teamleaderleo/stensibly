import { describe, expect, test } from "bun:test";
import {
  InMemoryGitHubProviderReceiptStore,
} from "../src/github-provider-receipts.ts";
import type {
  GitHubBranchResult,
  GitHubPublicationProviderAdapter,
  GitHubPullRequestResult,
} from "../src/github-provider-contracts.ts";
import { GitHubPublicationProviderService } from "../src/github-publication-provider-service.ts";
import {
  canonicalBody,
  sha256,
  stableJson,
} from "../src/github-provider-validation.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import {
  compileProjectContract,
  renderProjectContract,
} from "../src/project-contract.ts";

const project = "stensibly";
const repository = "teamleaderleo/stensibly";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const fixedNow = "2026-08-09T00:00:00.000Z";

const snapshot = compileProjectContract(renderProjectContract({
  version: 1,
  project,
  repositories: [repository],
  runnerProfiles: ["codex-default"],
  concurrency: { project: 8, global: 8 },
  autonomousActions: ["create_branch", "provider_write"],
  approvalRequired: [],
  checks: [],
  tags: ["github"],
  relatedProjects: [],
}, {
  goal: "Publish exact GitHub branch and pull-request candidates.",
  boundaries: "One attached repository with durable provider receipts.",
  evidenceAndHandoff: "Retain exact provider readback without content bodies.",
  escalation: "Reconcile ambiguous mutations before retry.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_publication_test",
  project,
  snapshot,
  sourceRevision: "main@publication-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: fixedNow,
};

describe("GitHub publication provider service", () => {
  test("creates an exact branch and pull request once with durable bounded receipts", async () => {
    const adapter = new FakePublicationAdapter();
    const service = provider(adapter);
    const context = requestContext();

    const branch = await service.createBranch({
      ...context,
      branch: "codex/publication-test",
      fromCommitSha: baseSha,
      idempotencyKey: "publication-branch-1",
    });
    expect(branch).toMatchObject({
      operation: "github_create_branch",
      state: "succeeded",
      actorId: context.actorId,
      clientId: context.clientId,
      bindingId: "ghbind_publication",
      attachmentId: attachment.id,
      providerRequestId: "BRANCH:CREATE",
      verification: { state: "passed", sourceRevision: baseSha },
      result: {
        kind: "branch",
        name: "codex/publication-test",
        commitSha: baseSha,
      },
    });
    expect(adapter.branchWrites).toBe(1);

    expect(await service.createBranch({
      ...context,
      branch: "codex/publication-test",
      fromCommitSha: baseSha,
      idempotencyKey: "publication-branch-1",
    })).toEqual(branch);
    expect(adapter.branchWrites).toBe(1);
    await expect(service.createBranch({
      ...context,
      branch: "codex/publication-test",
      fromCommitSha: headSha,
      idempotencyKey: "publication-branch-1",
    })).rejects.toThrow("idempotency key was reused");
    expect(adapter.branchWrites).toBe(1);

    const pullRequest = await service.createPullRequest({
      ...context,
      title: "Publish guarded candidate",
      body: "Sensitive implementation detail retained only as a digest.",
      head: "codex/publication-test",
      base: "main",
      expectedHeadSha: baseSha,
      expectedBaseSha: baseSha,
      draft: true,
      idempotencyKey: "publication-pr-1",
    });
    expect(pullRequest).toMatchObject({
      operation: "github_create_pull_request",
      state: "succeeded",
      providerRequestId: "PR:CREATE",
      verification: { state: "passed" },
      result: {
        kind: "pull_request",
        number: 42,
        head: "codex/publication-test",
        headSha: baseSha,
        base: "main",
        baseSha,
        draft: true,
        containsBody: false,
      },
    });
    expect(stableJson(pullRequest)).not.toContain("Sensitive implementation detail");
    expect(adapter.pullRequestWrites).toBe(1);
    expect(await service.createPullRequest({
      ...context,
      title: "Publish guarded candidate",
      body: "Sensitive implementation detail retained only as a digest.",
      head: "codex/publication-test",
      base: "main",
      expectedHeadSha: baseSha,
      expectedBaseSha: baseSha,
      draft: true,
      idempotencyKey: "publication-pr-1",
    })).toEqual(pullRequest);
    expect(adapter.pullRequestWrites).toBe(1);
  });

  test("returns a stale receipt before PR dispatch when either branch revision moved", async () => {
    const adapter = new FakePublicationAdapter();
    adapter.branches.set("codex/stale", branchResult("codex/stale", headSha));
    const service = provider(adapter);
    const result = await service.createPullRequest({
      ...requestContext(),
      title: "Stale candidate",
      head: "codex/stale",
      base: "main",
      expectedHeadSha: baseSha,
      expectedBaseSha: baseSha,
      idempotencyKey: "publication-pr-stale",
    });
    expect(result).toMatchObject({
      state: "stale",
      operation: "github_create_pull_request",
      result: { kind: "branch", name: "codex/stale", commitSha: headSha },
      error: { code: "stale_provider_version", retry: "do_not_retry" },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    });
    expect(adapter.pullRequestWrites).toBe(0);
  });

  test("holds an ambiguous branch mutation and never redispatches its exact replay", async () => {
    const adapter = new FakePublicationAdapter();
    adapter.ambiguousBranch = true;
    const service = provider(adapter);
    const input = {
      ...requestContext(),
      branch: "codex/ambiguous",
      fromCommitSha: baseSha,
      idempotencyKey: "publication-branch-ambiguous",
    };
    await expect(service.createBranch(input)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
      receipt: {
        state: "pending_reconciliation",
        error: { retry: "reconcile_before_retry" },
      },
    });
    expect(adapter.branchWrites).toBe(1);
    await expect(service.createBranch(input)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
    });
    expect(adapter.branchWrites).toBe(1);
  });

  test("retains bounded mutation identity when PR readback needs reconciliation", async () => {
    const adapter = new FakePublicationAdapter();
    adapter.branches.set(
      "codex/unverified-pr",
      branchResult("codex/unverified-pr", headSha),
    );
    adapter.failPullRequestReadback = true;
    const service = provider(adapter);
    const input = {
      ...requestContext(),
      title: "Unverified candidate",
      body: "Body text must not survive in the receipt.",
      head: "codex/unverified-pr",
      base: "main",
      expectedHeadSha: headSha,
      expectedBaseSha: baseSha,
      idempotencyKey: "publication-pr-unverified",
    };
    await expect(service.createPullRequest(input)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
      receipt: {
        state: "pending_reconciliation",
        providerRequestId: "PR:CREATE",
        result: {
          kind: "pull_request",
          number: 42,
          containsBody: false,
        },
        verification: { state: "failed" },
        error: { retry: "reconcile_before_retry" },
      },
    });
    const receipt = await service.createPullRequest(input).catch((error) =>
      (error as { receipt: unknown }).receipt
    );
    expect(stableJson(receipt)).not.toContain("Body text must not survive");
    expect(adapter.pullRequestWrites).toBe(1);
  });
});

function provider(adapter: GitHubPublicationProviderAdapter) {
  let receipt = 0;
  return new GitHubPublicationProviderService({
    projects: {
      getProjectAttachment: async (requestedProject) =>
        requestedProject === project ? attachment : null,
    },
    bindings: {
      getGitHubProjectRepositoryBinding: async (
        requestedProject,
        requestedRepository,
      ) => requestedProject === project && requestedRepository === repository
        ? {
          id: "ghbind_publication",
          project,
          repositoryFullName: repository,
          connectionId: "ghconn_publication",
          attachmentId: attachment.id,
          attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
          status: "active" as const,
          acceptedAt: fixedNow,
        }
        : null,
      getGitHubProviderConnection: async (id) => id === "ghconn_publication"
        ? {
          id,
          provider: "github" as const,
          installationId: "152263678",
          accountLogin: "teamleaderleo",
          credentialRef: "env://GITHUB_PRIVATE_KEY",
          status: "active" as const,
          repositoryFullNames: [repository],
          observedAt: fixedNow,
        }
        : null,
    },
    authority: {
      authorizeGitHubOperation: async () => ({
        allowed: true,
        capabilityGrantId: "grant_publication",
      }),
    },
    adapter,
    receipts: new InMemoryGitHubProviderReceiptStore(),
    now: () => fixedNow,
    idFactory: () => `ghop_publication_${++receipt}`,
  });
}

function requestContext() {
  return {
    project,
    repository,
    actorId: "api-token:oauth_grant_publication",
    clientId: "mcp:api-token:oauth_grant_publication",
  };
}

class FakePublicationAdapter implements GitHubPublicationProviderAdapter {
  readonly branches = new Map<string, GitHubBranchResult>([
    ["main", branchResult("main", baseSha)],
  ]);
  readonly pullRequests = new Map<number, GitHubPullRequestResult>();
  branchWrites = 0;
  pullRequestWrites = 0;
  ambiguousBranch = false;
  failPullRequestReadback = false;

  async getBranch(input: { branch: string }): Promise<GitHubBranchResult | null> {
    return structuredClone(this.branches.get(input.branch) ?? null);
  }

  async createBranch(input: {
    branch: string;
    fromCommitSha: string;
  }): Promise<{ branch: GitHubBranchResult; providerRequestId?: string }> {
    this.branchWrites += 1;
    if (this.ambiguousBranch) throw new Error("response lost after dispatch");
    const branch = branchResult(input.branch, input.fromCommitSha);
    this.branches.set(input.branch, branch);
    return { branch: structuredClone(branch), providerRequestId: "BRANCH:CREATE" };
  }

  async getPullRequest(input: {
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestResult> {
    const result = this.pullRequests.get(input.pullRequestNumber);
    if (!result) throw new Error("missing test pull request");
    if (this.failPullRequestReadback) {
      throw new Error("readback transport failed after accepted mutation");
    }
    return structuredClone(result);
  }

  async createPullRequest(input: {
    title: string;
    body?: string;
    head: string;
    base: string;
    draft: boolean;
  }): Promise<{
    pullRequest: GitHubPullRequestResult;
    providerRequestId?: string;
  }> {
    this.pullRequestWrites += 1;
    const head = this.branches.get(input.head)!;
    const base = this.branches.get(input.base)!;
    const pullRequest = pullRequestResult({
      title: input.title,
      body: input.body ?? "",
      head: input.head,
      headSha: head.commitSha,
      base: input.base,
      baseSha: base.commitSha,
      draft: input.draft,
    });
    this.pullRequests.set(pullRequest.number, pullRequest);
    return {
      pullRequest: structuredClone(pullRequest),
      providerRequestId: "PR:CREATE",
    };
  }
}

function branchResult(name: string, commitSha: string): GitHubBranchResult {
  return {
    kind: "branch",
    name,
    ref: `refs/heads/${name}`,
    commitSha,
    canonicalUrl: `https://github.com/${repository}/tree/${encodeURIComponent(name)}`,
    sourceRevision: commitSha,
  };
}

function pullRequestResult(input: {
  title: string;
  body: string;
  head: string;
  headSha: string;
  base: string;
  baseSha: string;
  draft: boolean;
}): GitHubPullRequestResult {
  const body = canonicalBody(input.body);
  const common = {
    kind: "pull_request" as const,
    number: 42,
    providerNodeId: "PR_kwDO_publication",
    title: input.title,
    head: input.head,
    headSha: input.headSha,
    base: input.base,
    baseSha: input.baseSha,
    draft: input.draft,
    state: "open" as const,
    canonicalUrl: `https://github.com/${repository}/pull/42`,
    createdAt: fixedNow,
    updatedAt: fixedNow,
    bodyRevision: {
      byteLength: new TextEncoder().encode(body).byteLength,
      sha256: sha256(body),
    },
    containsBody: false as const,
  };
  return {
    ...common,
    sourceRevision: sha256(stableJson(common)),
  };
}
