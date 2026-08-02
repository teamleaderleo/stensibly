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

const repositoryFullName = "teamleaderleo/stensibly";
const sourceRevision =
  "github-rest:I_kwDOLifecycle:2026-08-02T18:00:00.000Z";

function compile(receipt: GitHubProviderReceipt) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt,
    current: null,
  });
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const result = issueResult();
  return {
    version: 1,
    id: "ghop_lifecycle_1",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_lumen",
    clientId: "client_github_only",
    connectionId: "ghconn_lifecycle",
    installationId: "installation_lifecycle",
    bindingId: "ghbind_lifecycle",
    attachmentId: "attachment_lifecycle",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-context-lifecycle",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:59:55.000Z",
    updatedAt: "2026-08-02T18:00:00.000Z",
    providerRequestId: "request-lifecycle",
    result,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T18:00:00.000Z",
      sourceRevision: result.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function reserved(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return receipt({
    state: "reserved",
    providerRequestId: null,
    result: null,
    verification: {
      state: "not_run",
      checkedAt: null,
      sourceRevision: null,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  });
}

function pending(
  verification: GitHubProviderReceipt["verification"],
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return receipt({
    state: "pending_reconciliation",
    providerRequestId: null,
    result: null,
    verification,
    error: {
      code: "ambiguous_provider_outcome",
      message: "GitHub provider outcome requires reconciliation",
      retry: "reconcile_before_retry",
    },
    recovery: { nextAction: "reconcile_exact_operation" },
    ...overrides,
  });
}

describe("GitHub provider context reconciliation receipt lifecycle", () => {
  test("admits both durable pending forms produced by the repository", () => {
    const interrupted = compile(pending({
      state: "not_run",
      checkedAt: null,
      sourceRevision: null,
    }));
    const ambiguous = compile(pending({
      state: "failed",
      checkedAt: "2026-08-02T18:00:00.000Z",
      sourceRevision: null,
    }));

    for (const proposal of [interrupted, ambiguous]) {
      expect(proposal).toMatchObject({
        outcome: "pending_provider_reconciliation",
        nextAction: "reconcile_provider_operation",
        providerSnapshot: null,
      });
    }
  });

  test("rejects result-bearing reserved, pending, and rejected receipts", () => {
    const result = issueResult();
    const incoherent = [
      reserved({ result }),
      pending({
        state: "failed",
        checkedAt: "2026-08-02T18:00:00.000Z",
        sourceRevision: null,
      }, { result }),
      receipt({
        state: "rejected",
        providerRequestId: null,
        result,
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
        recovery: {
          nextAction: "inspect_authority_or_provider_rejection",
        },
      }),
    ];

    for (const candidate of incoherent) {
      expect(() => compile(candidate)).toThrow("lifecycle is inconsistent");
    }
  });

  test("rejects result-free succeeded and reconciled receipts", () => {
    for (const state of ["succeeded", "reconciled"] as const) {
      expect(() => compile(receipt({
        state,
        result: null,
      }))).toThrow("Settled GitHub provider receipt lifecycle is inconsistent");
    }
  });

  test("binds settled comment target and verification before no-op", () => {
    const result = commentResult();
    const valid = receipt({
      operation: "github_add_issue_comment",
      target: `${repositoryFullName}#958:comment:new`,
      result,
      verification: {
        state: "passed",
        checkedAt: "2026-08-02T18:00:00.000Z",
        sourceRevision: result.sourceRevision,
      },
    });

    expect(compile(valid)).toMatchObject({
      operation: "github_add_issue_comment",
      outcome: "no_issue_context_effect",
      providerSnapshot: null,
    });

    expect(() => compile({
      ...valid,
      target: `${repositoryFullName}#959:comment:new`,
    })).toThrow("comment receipt target does not bind");
    expect(() => compile({
      ...valid,
      verification: {
        ...valid.verification,
        sourceRevision: "github-rest:IC_other:revision",
      },
    })).toThrow("Settled GitHub provider receipt lifecycle is inconsistent");
  });

  test("rejects read-only operations masquerading as write receipts", () => {
    expect(() => compile(receipt({
      operation: "github_get_issue",
      target: `${repositoryFullName}#958`,
    }))).toThrow("does not produce a provider write receipt");
  });

  test("admits stale readback only for guarded issue updates", () => {
    const staleUpdate = receipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      state: "stale",
      providerRequestId: null,
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T18:00:00.000Z",
        sourceRevision,
      },
      error: {
        code: "stale_provider_version",
        message: "GitHub issue source revision changed before the guarded update",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    });

    expect(compile(staleUpdate)).toMatchObject({
      operation: "github_update_issue",
      outcome: "propose_context_acceptance",
      providerSourceRevision: sourceRevision,
    });

    for (const candidate of [
      receipt({
        state: "stale",
        providerRequestId: null,
        verification: staleUpdate.verification,
        error: staleUpdate.error,
        recovery: staleUpdate.recovery,
      }),
      receipt({
        operation: "github_add_issue_labels",
        target: `${repositoryFullName}#958:labels`,
        state: "stale",
        providerRequestId: null,
        verification: staleUpdate.verification,
        error: staleUpdate.error,
        recovery: staleUpdate.recovery,
      }),
      receipt({
        operation: "github_remove_issue_assignees",
        target: `${repositoryFullName}#958:assignees`,
        state: "stale",
        providerRequestId: null,
        verification: staleUpdate.verification,
        error: staleUpdate.error,
        recovery: staleUpdate.recovery,
      }),
    ]) {
      expect(() => compile(candidate)).toThrow(
        "Stale GitHub provider receipt lifecycle is inconsistent",
      );
    }
  });

  test("rejects stale receipts without the exact stale error contract", () => {
    expect(() => compile(receipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      state: "stale",
      providerRequestId: null,
      verification: {
        state: "failed",
        checkedAt: "2026-08-02T18:00:00.000Z",
        sourceRevision,
      },
      error: {
        code: "ambiguous_provider_outcome",
        message: "Wrong stale error identity",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    }))).toThrow("Stale GitHub provider receipt lifecycle is inconsistent");
  });
});

function issueResult(): GitHubIssueContext {
  return {
    version: 1,
    provider: "github",
    reference: {
      provider: "github",
      host: "github.com",
      owner: "teamleaderleo",
      repository: "stensibly",
      repositoryFullName,
      number: 958,
      externalId: `github:${repositoryFullName}#958`,
      canonicalUrl: `https://github.com/${repositoryFullName}/issues/958`,
    },
    title: "Reconcile provider receipt lifecycle evidence",
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
    createdAt: "2026-08-02T17:59:50.000Z",
    updatedAt: "2026-08-02T18:00:00.000Z",
    providerNodeId: "I_kwDOLifecycle",
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
      `https://github.com/${repositoryFullName}/issues/958#issuecomment-123456958`,
    createdAt: "2026-08-02T17:59:58.000Z",
    updatedAt: "2026-08-02T18:00:00.000Z",
    sourceRevision:
      "github-rest:IC_123456958:2026-08-02T18:00:00.000Z",
    bodyRevision: {
      byteLength: 24,
      sha256: hash("e"),
    },
    containsBody: false,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
