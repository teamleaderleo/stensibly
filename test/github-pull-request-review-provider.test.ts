import { describe, expect, test } from "bun:test";
import {
  GitHubPullRequestReviewBindingError,
  GitHubPullRequestReviewPendingReconciliationError,
  GitHubPullRequestReviewProviderService,
  GitHubPullRequestReviewStaleTargetError,
  githubPullRequestReviewTargetSourceRevision,
  prepareGitHubPullRequestReviewProviderBody,
  type GitHubPullRequestReviewAdapter,
  type GitHubPullRequestReviewProviderReview,
  type GitHubPullRequestReviewTarget,
} from "../src/github-pull-request-review-provider.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";
import type {
  GitHubProjectRepositoryBinding,
  GitHubProviderConnection,
} from "../src/github-provider-contracts.ts";

const now = "2026-08-15T06:45:00.000Z";
const head = "1111111111111111111111111111111111111111";
const effect = `stn-gh-review:${"a".repeat(64)}`;
const request = {
  project: "stensibly",
  repository: "teamleaderleo/stensibly",
  actorId: "rook",
  clientId: "mail-bridge",
  capabilityGrantId: "grant_formal_review",
};

function attachment(): ProjectAttachmentRecord {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project: "stensibly",
    repositories: ["teamleaderleo/stensibly"],
    runnerProfiles: [],
    concurrency: { project: 2, global: 4 },
    autonomousActions: ["github_review_write"],
    approvalRequired: [],
    checks: ["bun test test/github-pull-request-review-provider.test.ts"],
    tags: ["dogfood"],
    relatedProjects: [],
  }, {
    goal: "Exercise typed pull request review projection.",
    boundaries: "One accepted repository and exact PR head.",
    evidenceAndHandoff: "Retain exact review identities and fingerprints.",
    escalation: "Reconcile uncertain provider outcomes before retry.",
  }));
  return {
    id: "patt_review_1",
    project: "stensibly",
    snapshot,
    sourceRevision: "2222222222222222222222222222222222222222",
    acceptedBy: "leo",
    authorityWidening: false,
    acceptedAt: now,
  };
}

function binding(current: ProjectAttachmentRecord): GitHubProjectRepositoryBinding {
  return {
    id: "ghbind_review_1",
    project: "stensibly",
    repositoryFullName: "teamleaderleo/stensibly",
    connectionId: "ghconn_review_1",
    attachmentId: current.id,
    attachmentSnapshotSha256: current.snapshot.snapshotSha256,
    status: "active",
    acceptedAt: now,
  };
}

function connection(): GitHubProviderConnection {
  return {
    id: "ghconn_review_1",
    provider: "github",
    installationId: "12345",
    accountLogin: "teamleaderleo",
    credentialRef: "env://STENSIBLY_GITHUB_APP_PRIVATE_KEY",
    status: "active",
    repositoryFullNames: ["teamleaderleo/stensibly"],
    observedAt: now,
  };
}

function target(overrides: Partial<GitHubPullRequestReviewTarget> = {}): GitHubPullRequestReviewTarget {
  const core = {
    repositoryFullName: "teamleaderleo/stensibly",
    pullRequestNumber: 777,
    headSha: head,
    state: "open" as const,
    draft: true,
    updatedAt: now,
    ...overrides,
  };
  return {
    ...core,
    sourceRevision: githubPullRequestReviewTargetSourceRevision(core),
  };
}

class FakeReviewAdapter implements GitHubPullRequestReviewAdapter {
  current = target();
  reviews: GitHubPullRequestReviewProviderReview[] = [];
  createCalls = 0;
  getReviewFails = false;
  ambiguousCreateAfterWrite = false;
  ambiguousCreateWithoutWrite = false;

  async getPullRequest(): Promise<GitHubPullRequestReviewTarget> {
    return structuredClone(this.current);
  }

  async createReview(input: Parameters<GitHubPullRequestReviewAdapter["createReview"]>[0]) {
    this.createCalls += 1;
    if (this.ambiguousCreateWithoutWrite) throw new Error("transport unknown");
    const review: GitHubPullRequestReviewProviderReview = {
      id: String(9000 + this.createCalls),
      repositoryFullName: input.repositoryFullName,
      pullRequestNumber: input.pullRequestNumber,
      commitSha: input.commitSha,
      state: input.action === "APPROVE"
        ? "approved"
        : input.action === "REQUEST_CHANGES"
        ? "changes_requested"
        : "commented",
      body: input.body,
      authorLogin: "teamleaderleo",
      submittedAt: now,
    };
    this.reviews.push(review);
    if (this.ambiguousCreateAfterWrite) throw new Error("response lost");
    return { review: structuredClone(review), providerRequestId: `req-${review.id}` };
  }

  async getReview(input: Parameters<GitHubPullRequestReviewAdapter["getReview"]>[0]) {
    if (this.getReviewFails) throw new Error("readback unavailable");
    const review = this.reviews.find((value) => value.id === input.reviewId);
    if (!review) throw new Error("missing review");
    return structuredClone(review);
  }

  async listReviews() {
    return structuredClone(this.reviews);
  }
}

function service(adapter: FakeReviewAdapter, options: { repositoryInBinding?: boolean } = {}) {
  const currentAttachment = attachment();
  return new GitHubPullRequestReviewProviderService({
    projects: {
      async getProjectAttachment(project) {
        return project === "stensibly" ? currentAttachment : null;
      },
    },
    bindings: {
      async getGitHubProjectRepositoryBinding(project, repositoryFullName) {
        if (
          project !== "stensibly"
          || repositoryFullName !== "teamleaderleo/stensibly"
          || options.repositoryInBinding === false
        ) return null;
        return binding(currentAttachment);
      },
      async getGitHubProviderConnection(id) {
        return id === "ghconn_review_1" ? connection() : null;
      },
    },
    authority: {
      async authorizeGitHubPullRequestReview(input) {
        return input.capabilityGrantId === "grant_formal_review"
          ? { allowed: true, capabilityGrantId: input.capabilityGrantId }
          : { allowed: false, reason: "missing review grant" };
      },
    },
    adapter,
    now: () => now,
    idFactory: () => "ghreview_receipt_1",
  });
}

function submitInput(adapter: FakeReviewAdapter, overrides: Record<string, unknown> = {}) {
  return {
    ...request,
    effectId: effect,
    pullRequestNumber: 777,
    expectedTargetSourceRevision: adapter.current.sourceRevision,
    expectedHeadRevision: head,
    action: "COMMENT" as const,
    body: "Formal review dogfood comment.",
    ...overrides,
  };
}

describe("GitHubPullRequestReviewProviderService", () => {
  test("submits one formal COMMENT review and exact replay creates no second review", async () => {
    const adapter = new FakeReviewAdapter();
    const provider = service(adapter);
    const first = await provider.submitReview(submitInput(adapter));
    expect(first.state).toBe("succeeded");
    expect(first.providerReviewId).toBe("9001");
    expect(first.action).toBe("COMMENT");
    expect(first.verification.state).toBe("passed");
    expect(adapter.createCalls).toBe(1);

    const replay = await provider.submitReview({
      ...submitInput(adapter),
      previousReceipt: first,
    });
    expect(replay.state).toBe("replayed");
    expect(replay.providerReviewId).toBe("9001");
    expect(adapter.createCalls).toBe(1);
  });

  test("provider effect marker makes replay discoverable even without an in-process receipt", async () => {
    const adapter = new FakeReviewAdapter();
    const provider = service(adapter);
    const first = await provider.submitReview(submitInput(adapter));
    expect(first.state).toBe("succeeded");

    const secondProvider = service(adapter);
    const replay = await secondProvider.submitReview(submitInput(adapter));
    expect(replay.state).toBe("replayed");
    expect(replay.providerReviewId).toBe(first.providerReviewId);
    expect(adapter.createCalls).toBe(1);
  });

  test("a different exact effect/body may submit a distinct formal review", async () => {
    const adapter = new FakeReviewAdapter();
    const provider = service(adapter);
    await provider.submitReview(submitInput(adapter));
    const secondEffect = `stn-gh-review:${"b".repeat(64)}`;
    const second = await provider.submitReview(submitInput(adapter, {
      effectId: secondEffect,
      body: "A changed formal review body.",
    }));
    expect(second.providerReviewId).toBe("9002");
    expect(adapter.createCalls).toBe(2);
    expect(second.providerBodySha256).not.toBe(
      prepareGitHubPullRequestReviewProviderBody(effect, "Formal review dogfood comment.")
        .providerBodySha256,
    );
  });

  test("stale head refuses before formal review dispatch", async () => {
    const adapter = new FakeReviewAdapter();
    adapter.current = target({
      headSha: "3333333333333333333333333333333333333333",
    });
    const provider = service(adapter);
    await expect(provider.submitReview(submitInput(adapter, {
      expectedHeadRevision: head,
    }))).rejects.toBeInstanceOf(GitHubPullRequestReviewStaleTargetError);
    expect(adapter.createCalls).toBe(0);
  });

  test("wrong repository binding refuses before provider dispatch", async () => {
    const adapter = new FakeReviewAdapter();
    const provider = service(adapter, { repositoryInBinding: false });
    await expect(provider.submitReview(submitInput(adapter)))
      .rejects.toBeInstanceOf(GitHubPullRequestReviewBindingError);
    expect(adapter.createCalls).toBe(0);
  });

  test("lost mutation response reconciles exact provider review instead of replaying", async () => {
    const adapter = new FakeReviewAdapter();
    adapter.ambiguousCreateAfterWrite = true;
    const provider = service(adapter);
    const receipt = await provider.submitReview(submitInput(adapter));
    expect(receipt.state).toBe("reconciled");
    expect(receipt.providerReviewId).toBe("9001");
    expect(adapter.createCalls).toBe(1);
  });

  test("provider success with uncertain readback enters reconciliation instead of blind replay", async () => {
    const adapter = new FakeReviewAdapter();
    adapter.getReviewFails = true;
    const provider = service(adapter);
    let pending: GitHubPullRequestReviewPendingReconciliationError | null = null;
    try {
      await provider.submitReview(submitInput(adapter));
    } catch (error) {
      if (error instanceof GitHubPullRequestReviewPendingReconciliationError) {
        pending = error;
      } else {
        throw error;
      }
    }
    expect(pending?.receipt.state).toBe("pending_reconciliation");
    expect(pending?.receipt.providerReviewId).toBe("9001");
    expect(pending?.receipt.providerRequestId).toBe("req-9001");
    expect(adapter.createCalls).toBe(1);

    await expect(provider.submitReview({
      ...submitInput(adapter),
      previousReceipt: pending!.receipt,
    })).rejects.toBeInstanceOf(GitHubPullRequestReviewPendingReconciliationError);
    expect(adapter.createCalls).toBe(1);
  });

  test("uncertain outcome with no readback enters reconciliation and a retry stays fenced", async () => {
    const adapter = new FakeReviewAdapter();
    adapter.ambiguousCreateWithoutWrite = true;
    const provider = service(adapter);
    let pending: GitHubPullRequestReviewPendingReconciliationError | null = null;
    try {
      await provider.submitReview(submitInput(adapter));
    } catch (error) {
      if (error instanceof GitHubPullRequestReviewPendingReconciliationError) {
        pending = error;
      } else {
        throw error;
      }
    }
    expect(pending?.receipt.state).toBe("pending_reconciliation");
    expect(adapter.createCalls).toBe(1);

    await expect(provider.submitReview({
      ...submitInput(adapter),
      previousReceipt: pending!.receipt,
    })).rejects.toBeInstanceOf(GitHubPullRequestReviewPendingReconciliationError);
    expect(adapter.createCalls).toBe(1);
  });

  test("REQUEST_CHANGES requires visible review prose", async () => {
    const adapter = new FakeReviewAdapter();
    const provider = service(adapter);
    await expect(provider.submitReview(submitInput(adapter, {
      action: "REQUEST_CHANGES",
      body: "",
    }))).rejects.toThrow("REQUEST_CHANGES GitHub reviews require a visible review body");
    expect(adapter.createCalls).toBe(0);
  });
});
