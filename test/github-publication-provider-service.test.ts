import { describe, expect, test } from "bun:test";
import {
  InMemoryGitHubProviderReceiptStore,
} from "../src/github-provider-receipts.ts";
import type {
  GitHubBranchResult,
  GitHubProviderReceipt,
  GitHubProviderReceiptStore,
  GitHubPublicationProviderAdapter,
  GitHubPullRequestResult,
} from "../src/github-provider-contracts.ts";
import {
  GitHubProviderRejectedError,
  githubPublicationProviderRejectionCodes,
  type GitHubPublicationProviderRejectionCode,
} from "../src/github-provider-contracts.ts";
import { GitHubPublicationProviderService } from "../src/github-publication-provider-service.ts";
import {
  canonicalBody,
  githubPullRequestSourceRevision,
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
    const input = {
      ...requestContext(),
      title: "Stale candidate",
      head: "codex/stale",
      base: "main",
      expectedHeadSha: baseSha,
      expectedBaseSha: baseSha,
      idempotencyKey: "publication-pr-stale",
    };
    const result = await service.createPullRequest(input);
    expect(result).toMatchObject({
      state: "stale",
      operation: "github_create_pull_request",
      result: { kind: "branch", name: "codex/stale", commitSha: headSha },
      error: { code: "stale_provider_version", retry: "do_not_retry" },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    });
    expect(adapter.pullRequestWrites).toBe(0);
    expect(await service.createPullRequest(input)).toEqual(result);
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

  test("rejects a forged succeeded branch replay without redispatch", async () => {
    const input = {
      ...requestContext(),
      branch: "codex/replay-branch",
      fromCommitSha: baseSha,
      idempotencyKey: "publication-branch-forged-replay",
    };
    const original = await provider(new FakePublicationAdapter()).createBranch(
      input,
    );
    const forgedResult = branchResult(input.branch, headSha);
    const forged = {
      ...original,
      result: forgedResult,
      verification: {
        ...original.verification,
        sourceRevision: forgedResult.sourceRevision,
      },
    } satisfies GitHubProviderReceipt;
    const replayAdapter = new FakePublicationAdapter();

    await expect(provider(
      replayAdapter,
      new StaticReplayReceiptStore(forged),
    ).createBranch(input)).rejects.toThrow(
      "GitHub publication replay receipt is invalid",
    );
    expect(replayAdapter.branchWrites).toBe(0);
  });

  test("rejects forged PR result and lifecycle combinations without redispatch", async () => {
    const sourceAdapter = new FakePublicationAdapter();
    sourceAdapter.branches.set(
      "codex/replay-pr",
      branchResult("codex/replay-pr", headSha),
    );
    const input = {
      ...requestContext(),
      title: "Replay-bound candidate",
      body: "Exact replay body",
      head: "codex/replay-pr",
      base: "main",
      expectedHeadSha: headSha,
      expectedBaseSha: baseSha,
      draft: true,
      idempotencyKey: "publication-pr-forged-replay",
    };
    const original = await provider(sourceAdapter).createPullRequest(input);
    const originalResult = original.result as GitHubPullRequestResult;
    const forgedResults = [
      changedPullRequestResult(originalResult, {
        title: "Substituted candidate",
      }),
      changedPullRequestResult(originalResult, { head: "codex/substituted" }),
      changedPullRequestResult(originalResult, { base: "release" }),
      changedPullRequestResult(originalResult, { headSha: "c".repeat(40) }),
      changedPullRequestResult(originalResult, { baseSha: "d".repeat(40) }),
      changedPullRequestResult(originalResult, {
        bodyRevision: {
          ...originalResult.bodyRevision,
          sha256: sha256("substituted body"),
        },
      }),
    ].map((changedResult) => ({
      ...original,
      result: changedResult,
      verification: {
        ...original.verification,
        sourceRevision: changedResult.sourceRevision,
      },
    } satisfies GitHubProviderReceipt));
    const incoherentPending = {
      ...original,
      state: "pending_reconciliation",
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: {
        code: "ambiguous_provider_outcome",
        message: "GitHub publication outcome requires exact reconciliation",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    } satisfies GitHubProviderReceipt;
    const incoherentRejected = {
      ...original,
      state: "rejected",
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: {
        code: "github_provider_request_rejected",
        message: "GitHub rejected create pull request",
        retry: "do_not_retry",
      },
      recovery: {
        nextAction: "inspect_authority_or_provider_rejection",
      },
    } satisfies GitHubProviderReceipt;
    const unknownRejected = {
      ...incoherentRejected,
      providerRequestId: null,
      error: {
        ...incoherentRejected.error,
        code: "github_unreviewed_rejection",
      },
    } satisfies GitHubProviderReceipt;
    const expectedBranch = branchResult(input.head, input.expectedHeadSha);
    const falseStale = {
      ...original,
      state: "stale",
      providerRequestId: null,
      result: expectedBranch,
      verification: {
        state: "failed",
        checkedAt: fixedNow,
        sourceRevision: expectedBranch.sourceRevision,
      },
      error: {
        code: "stale_provider_version",
        message: "GitHub pull request head changed before guarded publication",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    } satisfies GitHubProviderReceipt;

    for (const forged of [
      ...forgedResults,
      incoherentPending,
      incoherentRejected,
      unknownRejected,
      falseStale,
    ]) {
      const replayAdapter = new FakePublicationAdapter();
      await expect(provider(
        replayAdapter,
        new StaticReplayReceiptStore(forged),
      ).createPullRequest(input)).rejects.toThrow(
        "GitHub publication replay receipt is invalid",
      );
      expect(replayAdapter.pullRequestWrites).toBe(0);
    }
  });

  test("replays durable credential, permission, and authority rejections exactly", async () => {
    const representativeCodes = [
      "github_credential_mint_failed",
      "github_installation_permission_insufficient",
      "github_repository_authority_unavailable",
    ] as const satisfies readonly GitHubPublicationProviderRejectionCode[];
    for (const code of representativeCodes) {
      expect(githubPublicationProviderRejectionCodes).toContain(code);
      const adapter = new FakePublicationAdapter();
      adapter.branchRejection = {
        code,
        message: `Fixed ${code} test rejection`,
      };
      const service = provider(adapter);
      const input = {
        ...requestContext(),
        branch: `codex/rejected-${code.replace(/^github_/u, "")}`,
        fromCommitSha: baseSha,
        idempotencyKey: `publication-rejected-${code}`,
      };

      const rejected = await service.createBranch(input);
      expect(rejected).toMatchObject({
        state: "rejected",
        providerRequestId: null,
        result: null,
        verification: { state: "not_run" },
        error: { code, retry: "do_not_retry" },
        recovery: {
          nextAction: "inspect_authority_or_provider_rejection",
        },
      });
      expect(await service.createBranch(input)).toEqual(rejected);
      expect(adapter.branchReads).toBe(1);
      expect(adapter.branchWrites).toBe(0);
    }
  });
});

function provider(
  adapter: GitHubPublicationProviderAdapter,
  receipts: GitHubProviderReceiptStore = new InMemoryGitHubProviderReceiptStore(),
) {
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
    receipts,
    now: () => fixedNow,
    idFactory: () => `ghop_publication_${++receipt}`,
  });
}

function changedPullRequestResult(
  result: GitHubPullRequestResult,
  changes: Partial<Omit<GitHubPullRequestResult, "sourceRevision">>,
): GitHubPullRequestResult {
  const { sourceRevision: _sourceRevision, ...retainedResult } = result;
  const retained = {
    ...retainedResult,
    ...changes,
  } satisfies Omit<GitHubPullRequestResult, "sourceRevision">;
  return {
    ...retained,
    sourceRevision: githubPullRequestSourceRevision(retained),
  };
}

class StaticReplayReceiptStore implements GitHubProviderReceiptStore {
  readonly #receipt: GitHubProviderReceipt;

  constructor(receipt: GitHubProviderReceipt) {
    this.#receipt = structuredClone(receipt);
  }

  async reserveGitHubProviderReceipt() {
    return {
      outcome: "replay" as const,
      receipt: structuredClone(this.#receipt),
    };
  }

  async updateGitHubProviderReceipt(): Promise<GitHubProviderReceipt> {
    throw new Error("forged replay must not update or dispatch");
  }

  async getGitHubProviderReceipt(): Promise<GitHubProviderReceipt> {
    return structuredClone(this.#receipt);
  }
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
  branchReads = 0;
  pullRequestWrites = 0;
  ambiguousBranch = false;
  failPullRequestReadback = false;
  branchRejection: {
    code: GitHubPublicationProviderRejectionCode;
    message: string;
  } | null = null;

  async getBranch(input: { branch: string }): Promise<GitHubBranchResult | null> {
    this.branchReads += 1;
    if (this.branchRejection) {
      throw new GitHubProviderRejectedError(
        this.branchRejection.code,
        this.branchRejection.message,
      );
    }
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
    sourceRevision: githubPullRequestSourceRevision(common),
  };
}
