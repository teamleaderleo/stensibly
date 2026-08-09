import { describe, expect, test } from "bun:test";
import type {
  GitHubBranchResult,
  GitHubProviderReceiptStore,
  GitHubPublicationProviderAdapter,
  GitHubPullRequestResult,
} from "../src/github-provider-contracts.ts";
import { InMemoryGitHubProviderReceiptStore } from "../src/github-provider-receipts.ts";
import { GitHubPublicationProviderService } from "../src/github-publication-provider-service.ts";
import {
  GitHubPublicationReadbackIdentityError,
  GitHubPublicationReadbackReconciler,
} from "../src/github-publication-readback-reconciliation.ts";
import {
  canonicalBody,
  githubPullRequestSourceRevision,
  sha256,
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
const fixedNow = "2026-08-10T00:00:00.000Z";

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
  goal: "Reconcile exact GitHub publication effects from canonical reads.",
  boundaries: "Readback can settle uncertainty and never dispatch a replacement write.",
  evidenceAndHandoff: "Retain bounded provider identity and exact source revisions.",
  escalation: "Keep ambiguous observations pending for later reconciliation.",
}));

const attachment: ProjectAttachmentRecord = {
  id: "attach_publication_readback",
  project,
  snapshot,
  sourceRevision: "main@publication-readback-test",
  acceptedBy: "test",
  authorityWidening: false,
  acceptedAt: fixedNow,
};

describe("GitHub publication readback reconciliation", () => {
  test("settles an ambiguous branch creation from the exact canonical branch without redispatch", async () => {
    const adapter = new FakePublicationAdapter();
    adapter.ambiguousBranchAfterEffect = true;
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const { publication, reconciliation } = services(adapter, receipts);
    const input = branchInput("branch-exact");

    await expect(publication.createBranch(input)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
      receipt: { state: "pending_reconciliation", result: null },
    });
    expect(adapter.branchWrites).toBe(1);

    const reconciled = await reconciliation.reconcileBranch(input);
    expect(reconciled).toMatchObject({
      state: "reconciled",
      operation: "github_create_branch",
      result: {
        kind: "branch",
        name: input.branch,
        commitSha: baseSha,
      },
      verification: { state: "passed", sourceRevision: baseSha },
      error: null,
      recovery: { nextAction: "none" },
    });
    expect(reconciled.attemptCount).toBe(1);
    expect(adapter.branchWrites).toBe(1);
    expect(await publication.createBranch(input)).toEqual(reconciled);
    expect(adapter.branchWrites).toBe(1);
  });

  test("keeps absent and moved branch observations pending", async () => {
    for (const mode of ["absent", "moved"] as const) {
      const adapter = new FakePublicationAdapter();
      adapter.ambiguousBranchWithoutEffect = mode === "absent";
      adapter.ambiguousBranchAfterEffect = mode === "moved";
      const receipts = new InMemoryGitHubProviderReceiptStore();
      const { publication, reconciliation } = services(adapter, receipts);
      const input = branchInput(`branch-${mode}`);

      await expect(publication.createBranch(input)).rejects.toMatchObject({
        name: "GitHubProviderPendingReconciliationError",
      });
      if (mode === "moved") {
        adapter.branches.set(input.branch, branchResult(input.branch, headSha));
      }
      const before = await receipts.getGitHubProviderReceipt(
        project,
        input.idempotencyKey,
      );
      expect(before).not.toBeNull();
      const pending = await reconciliation.reconcileBranch(input);
      expect(pending).toEqual(before!);
      expect(pending.state).toBe("pending_reconciliation");
      expect(adapter.branchWrites).toBe(1);
    }
  });

  test("settles a PR whose provider identity survived a lost verification read", async () => {
    const adapter = new FakePublicationAdapter();
    adapter.branches.set("kite/readback-pr", branchResult("kite/readback-pr", headSha));
    adapter.failPullRequestReadback = true;
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const { publication, reconciliation } = services(adapter, receipts);
    const input = pullRequestInput("pr-exact");

    await expect(publication.createPullRequest(input)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
      receipt: {
        state: "pending_reconciliation",
        providerRequestId: "PR:CREATE",
        result: { kind: "pull_request", number: 42 },
      },
    });
    expect(adapter.pullRequestWrites).toBe(1);

    adapter.failPullRequestReadback = false;
    const reconciled = await reconciliation.reconcilePullRequest(input);
    expect(reconciled).toMatchObject({
      state: "reconciled",
      operation: "github_create_pull_request",
      providerRequestId: "PR:CREATE",
      result: {
        kind: "pull_request",
        number: 42,
        providerNodeId: "PR_kwDO_readback",
        title: input.title,
        head: input.head,
        headSha,
        base: input.base,
        baseSha,
        draft: true,
        state: "open",
      },
      verification: { state: "passed" },
      error: null,
    });
    expect(reconciled.attemptCount).toBe(1);
    expect(adapter.pullRequestWrites).toBe(1);
    expect(await publication.createPullRequest(input)).toEqual(reconciled);
    expect(adapter.pullRequestWrites).toBe(1);
  });

  test("keeps changed or identity-less PR observations pending", async () => {
    const changedAdapter = new FakePublicationAdapter();
    changedAdapter.branches.set("kite/readback-pr", branchResult("kite/readback-pr", headSha));
    changedAdapter.failPullRequestReadback = true;
    const changedReceipts = new InMemoryGitHubProviderReceiptStore();
    const changedServices = services(changedAdapter, changedReceipts);
    const changedInput = pullRequestInput("pr-changed");
    await expect(changedServices.publication.createPullRequest(changedInput)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
    });
    const original = await changedReceipts.getGitHubProviderReceipt(
      project,
      changedInput.idempotencyKey,
    );
    expect(original).not.toBeNull();
    changedAdapter.failPullRequestReadback = false;
    changedAdapter.pullRequests.set(42, pullRequestResult({
      title: "Changed after ambiguous publication",
      body: changedInput.body ?? "",
      head: changedInput.head,
      headSha,
      base: changedInput.base,
      baseSha,
      draft: true,
    }));
    expect(await changedServices.reconciliation.reconcilePullRequest(changedInput))
      .toEqual(original!);
    expect(changedAdapter.pullRequestWrites).toBe(1);

    const missingAdapter = new FakePublicationAdapter();
    missingAdapter.branches.set("kite/readback-pr", branchResult("kite/readback-pr", headSha));
    missingAdapter.ambiguousPullRequestWithoutResult = true;
    const missingReceipts = new InMemoryGitHubProviderReceiptStore();
    const missingServices = services(missingAdapter, missingReceipts);
    const missingInput = pullRequestInput("pr-no-identity");
    await expect(missingServices.publication.createPullRequest(missingInput)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
      receipt: { state: "pending_reconciliation", result: null },
    });
    const readsBefore = missingAdapter.pullRequestReads;
    const pending = await missingServices.reconciliation.reconcilePullRequest(missingInput);
    expect(pending.state).toBe("pending_reconciliation");
    expect(missingAdapter.pullRequestReads).toBe(readsBefore);
    expect(missingAdapter.pullRequestWrites).toBe(1);
  });

  test("rejects changed identity and revoked authority before provider read", async () => {
    const adapter = new FakePublicationAdapter();
    adapter.ambiguousBranchAfterEffect = true;
    const receipts = new InMemoryGitHubProviderReceiptStore();
    const live = sharedDependencies(adapter, receipts);
    const publication = new GitHubPublicationProviderService(live);
    const reconciliation = new GitHubPublicationReadbackReconciler(live);
    const input = branchInput("identity");

    await expect(publication.createBranch(input)).rejects.toMatchObject({
      name: "GitHubProviderPendingReconciliationError",
    });
    const readsBefore = adapter.branchReads;
    await expect(reconciliation.reconcileBranch({
      ...input,
      fromCommitSha: headSha,
    })).rejects.toBeInstanceOf(GitHubPublicationReadbackIdentityError);
    expect(adapter.branchReads).toBe(readsBefore);

    const denied = new GitHubPublicationReadbackReconciler({
      ...live,
      authority: {
        authorizeGitHubOperation: async () => ({
          allowed: false,
          reason: "readback authority revoked",
        }),
      },
    });
    await expect(denied.reconcileBranch(input)).rejects.toThrow(
      "readback authority revoked",
    );
    expect(adapter.branchReads).toBe(readsBefore);
    expect(adapter.branchWrites).toBe(1);
  });
});

function services(
  adapter: GitHubPublicationProviderAdapter,
  receipts: GitHubProviderReceiptStore,
) {
  const shared = sharedDependencies(adapter, receipts);
  return {
    publication: new GitHubPublicationProviderService(shared),
    reconciliation: new GitHubPublicationReadbackReconciler(shared),
  };
}

function sharedDependencies(
  adapter: GitHubPublicationProviderAdapter,
  receipts: GitHubProviderReceiptStore,
) {
  let receipt = 0;
  return {
    projects: {
      getProjectAttachment: async (requestedProject: string) =>
        requestedProject === project ? attachment : null,
    },
    bindings: {
      getGitHubProjectRepositoryBinding: async (
        requestedProject: string,
        requestedRepository: string,
      ) => requestedProject === project && requestedRepository === repository
        ? {
          id: "ghbind_publication_readback",
          project,
          repositoryFullName: repository,
          connectionId: "ghconn_publication_readback",
          attachmentId: attachment.id,
          attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
          status: "active" as const,
          acceptedAt: fixedNow,
        }
        : null,
      getGitHubProviderConnection: async (id: string) =>
        id === "ghconn_publication_readback"
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
        capabilityGrantId: "grant_publication_readback",
      }),
    },
    adapter,
    receipts,
    now: () => fixedNow,
    idFactory: () => `ghop_publication_readback_${++receipt}`,
  };
}

function requestContext() {
  return {
    project,
    repository,
    actorId: "api-token:oauth_grant_publication_readback",
    clientId: "mcp:api-token:oauth_grant_publication_readback",
  };
}

function branchInput(suffix: string) {
  return {
    ...requestContext(),
    branch: `kite/${suffix}`,
    fromCommitSha: baseSha,
    idempotencyKey: `publication-${suffix}`,
  };
}

function pullRequestInput(suffix: string) {
  return {
    ...requestContext(),
    title: "Recover exact publication by readback",
    body: "The body is supplied again only so its digest can be verified.",
    head: "kite/readback-pr",
    base: "main",
    expectedHeadSha: headSha,
    expectedBaseSha: baseSha,
    draft: true,
    idempotencyKey: `publication-${suffix}`,
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
  pullRequestReads = 0;
  ambiguousBranchAfterEffect = false;
  ambiguousBranchWithoutEffect = false;
  ambiguousPullRequestWithoutResult = false;
  failPullRequestReadback = false;

  async getBranch(input: {
    repositoryFullName: string;
    branch: string;
  }): Promise<GitHubBranchResult | null> {
    expect(input.repositoryFullName).toBe(repository);
    this.branchReads += 1;
    return structuredClone(this.branches.get(input.branch) ?? null);
  }

  async createBranch(input: {
    repositoryFullName: string;
    branch: string;
    fromCommitSha: string;
    idempotencyKey: string;
  }): Promise<{ branch: GitHubBranchResult; providerRequestId?: string }> {
    expect(input.repositoryFullName).toBe(repository);
    this.branchWrites += 1;
    if (this.ambiguousBranchWithoutEffect) {
      throw new Error("transport ended before provider result");
    }
    const branch = branchResult(input.branch, input.fromCommitSha);
    this.branches.set(input.branch, branch);
    if (this.ambiguousBranchAfterEffect) {
      throw new Error("response lost after accepted branch mutation");
    }
    return { branch: structuredClone(branch), providerRequestId: "BRANCH:CREATE" };
  }

  async getPullRequest(input: {
    repositoryFullName: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullRequestResult> {
    expect(input.repositoryFullName).toBe(repository);
    this.pullRequestReads += 1;
    const result = this.pullRequests.get(input.pullRequestNumber);
    if (!result) throw new Error("missing test pull request");
    if (this.failPullRequestReadback) {
      throw new Error("readback transport failed after accepted mutation");
    }
    return structuredClone(result);
  }

  async createPullRequest(input: {
    repositoryFullName: string;
    title: string;
    body?: string;
    head: string;
    base: string;
    draft: boolean;
    idempotencyKey: string;
  }): Promise<{
    pullRequest: GitHubPullRequestResult;
    providerRequestId?: string;
  }> {
    expect(input.repositoryFullName).toBe(repository);
    this.pullRequestWrites += 1;
    if (this.ambiguousPullRequestWithoutResult) {
      throw new Error("transport ended before pull request result");
    }
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
    providerNodeId: "PR_kwDO_readback",
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
      byteLength: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body),
    },
    containsBody: false as const,
  };
  return {
    ...common,
    sourceRevision: githubPullRequestSourceRevision(common),
  };
}
