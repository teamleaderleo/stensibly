import { describe, expect, test } from "bun:test";
import type {
  GitHubIssueComment,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import type { GitHubIssueContext } from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const externalId = "github:teamleaderleo/stensibly#958";
const sourceRevision =
  "github-rest:I_kwDOReconcile:2026-08-02T17:27:00.000Z";

describe("GitHub provider context reconciliation", () => {
  test("proposes acceptance from one verified issue create receipt", () => {
    const proposal = compile(issueReceipt());

    expect(proposal).toMatchObject({
      project: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
      receiptId: "ghop_958",
      operation: "github_create_issue",
      externalId,
      currentSourceRevision: null,
      providerSourceRevision: sourceRevision,
      outcome: "propose_context_acceptance",
      nextAction: "submit_context_acceptance",
      authorizesProviderMutation: false,
      authorizesContextAcceptance: false,
      authorizesAuthority: false,
    });
    expect(proposal.providerSnapshot).toEqual(issueResult());
    expect(proposal.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(proposal.proposalFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.providerSnapshot)).toBe(true);
    expect(Object.isFrozen(proposal.providerSnapshot?.reference)).toBe(true);
    expect(Object.isFrozen(proposal.providerSnapshot?.labels)).toBe(true);
  });

  test("recognizes an already accepted provider revision", () => {
    const proposal = compile(issueReceipt(), {
      externalId,
      sourceRevision,
    });

    expect(proposal.outcome).toBe("already_current");
    expect(proposal.nextAction).toBe("none");
    expect(proposal.providerSnapshot).toBeNull();
  });

  test("proposes stale readback as the current provider observation", () => {
    const receipt = issueReceipt({
      operation: "github_update_issue",
      state: "stale",
      error: {
        code: "stale_provider_version",
        message: "GitHub issue source revision changed before the guarded update",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    });
    const proposal = compile(receipt, {
      externalId,
      sourceRevision: "github-rest:I_kwDOReconcile:previous",
    });

    expect(proposal.outcome).toBe("propose_context_acceptance");
    expect(proposal.operation).toBe("github_update_issue");
    expect(proposal.providerSourceRevision).toBe(sourceRevision);
    expect(proposal.providerSnapshot).toEqual(issueResult());
  });

  test("keeps reserved and ambiguous operations visibly unsettled", () => {
    const reserved = compile(issueReceipt({
      state: "reserved",
      providerRequestId: null,
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
    }));
    expect(reserved).toMatchObject({
      outcome: "await_provider_result",
      nextAction: "await_provider_result",
      externalId: null,
      providerSnapshot: null,
    });

    const pending = compile(issueReceipt({
      state: "pending_reconciliation",
      providerRequestId: null,
      result: null,
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T17:27:00.000Z",
        sourceRevision: null,
      },
      error: {
        code: "ambiguous_provider_outcome",
        message: "GitHub provider outcome requires reconciliation",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    }));
    expect(pending).toMatchObject({
      outcome: "pending_provider_reconciliation",
      nextAction: "reconcile_provider_operation",
      externalId: null,
      providerSnapshot: null,
    });
  });

  test("returns no issue-context effect for comments and rejection", () => {
    const comment = compile(commentReceipt());
    expect(comment).toMatchObject({
      operation: "github_add_issue_comment",
      outcome: "no_issue_context_effect",
      nextAction: "none",
      externalId: null,
      providerSnapshot: null,
    });

    const rejected = compile(issueReceipt({
      state: "rejected",
      providerRequestId: null,
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: {
        code: "provider_denied",
        message: "GitHub rejected the operation",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "inspect_authority_or_provider_rejection" },
    }));
    expect(rejected).toMatchObject({
      outcome: "no_issue_context_effect",
      nextAction: "none",
      externalId: null,
      providerSnapshot: null,
    });
  });

  test("fails closed when current and provider issue identities differ", () => {
    const proposal = compile(issueReceipt(), {
      externalId: "github:teamleaderleo/stensibly#959",
      sourceRevision: "github-rest:I_other:revision",
    });

    expect(proposal).toMatchObject({
      externalId,
      outcome: "identity_conflict",
      nextAction: "inspect_issue_identity_conflict",
      providerSourceRevision: sourceRevision,
      providerSnapshot: null,
    });
  });

  test("rejects hostile receipt fields without invoking accessors", () => {
    let reads = 0;
    const hostile = issueReceipt() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, "target", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("github_pat_secret_should_not_escape");
      },
    });

    expect(() => compileGitHubProviderContextReconciliation({
      schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
      receipt: hostile,
      current: null,
    })).toThrow("enumerable data fields");
    expect(reads).toBe(0);
  });

  test("fingerprints deterministically and detaches producer objects", () => {
    const receipt = issueReceipt();
    const current = {
      externalId,
      sourceRevision: "github-rest:I_kwDOReconcile:previous",
    };
    const first = compile(receipt, current);
    const second = compile(structuredClone(receipt), { ...current });

    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(second.proposalFingerprint).toBe(first.proposalFingerprint);

    receipt.result!.labels.push("caller-mutated");
    current.sourceRevision = "caller-mutated";

    expect(first.currentSourceRevision).toBe(
      "github-rest:I_kwDOReconcile:previous",
    );
    expect(first.providerSnapshot?.labels).toEqual(["area:github"]);
  });
});

function compile(
  receipt: GitHubProviderReceipt,
  current: { externalId: string; sourceRevision: string } | null = null,
) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt,
    current,
  });
}

function issueReceipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const result = issueResult();
  return {
    version: 1,
    id: "ghop_958",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_create_issue",
    target: "teamleaderleo/stensibly#new",
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-context-958",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:26:55.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerRequestId: "request-958",
    result,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T17:27:00.000Z",
      sourceRevision: result.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function commentReceipt(): GitHubProviderReceipt {
  const result = commentResult();
  return {
    ...issueReceipt(),
    operation: "github_add_issue_comment",
    target: "teamleaderleo/stensibly#958:comment:new",
    result,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T17:27:00.000Z",
      sourceRevision: result.sourceRevision,
    },
  };
}

function issueResult(): GitHubIssueContext {
  return {
    version: 1,
    provider: "github",
    reference: {
      provider: "github",
      host: "github.com",
      owner: "teamleaderleo",
      repository: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
      number: 958,
      externalId,
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/issues/958",
    },
    title: "Compile verified GitHub issue receipts into context reconciliation proposals",
    bodyRevision: {
      present: false,
      byteLength: 0,
      sha256: hash("0"),
    },
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T17:26:51.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerNodeId: "I_kwDOReconcile",
    sourceRevision,
    contentSha256: hash("c"),
    snapshotSha256: hash("d"),
    containsIssueBody: false,
  };
}

function commentResult(): GitHubIssueComment {
  return {
    id: "123456958",
    issueNumber: 958,
    canonicalUrl:
      "https://github.com/teamleaderleo/stensibly/issues/958#issuecomment-123456958",
    createdAt: "2026-08-02T17:26:58.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    sourceRevision: "github-rest:IC_123456958:2026-08-02T17:27:00.000Z",
    bodyRevision: { byteLength: 12, sha256: hash("e") },
    containsBody: false,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
