import { describe, expect, test } from "bun:test";
import type {
  GitHubIssueComment,
  GitHubIssueProviderOperation,
  GitHubProviderReceipt,
} from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const checkedAt = "2026-08-02T18:00:00.000Z";

describe("GitHub provider context reconciliation lifecycle", () => {
  test("couples each pending verification tuple to its producer error code", () => {
    const interruptedWithAmbiguousCode = pendingReceipt({
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: {
        code: "ambiguous_provider_outcome",
        message: "GitHub provider result requires reconciliation",
        retry: "reconcile_before_retry",
      },
    });
    const ambiguousWithInterruptedCode = pendingReceipt({
      verification: {
        state: "failed",
        checkedAt,
        sourceRevision: null,
      },
      error: {
        code: "provider_dispatch_in_progress_or_interrupted",
        message:
          "GitHub provider dispatch may still be in progress or may have been interrupted",
        retry: "reconcile_before_retry",
      },
    });

    expect(() => compile(interruptedWithAmbiguousCode)).toThrow(
      "Pending GitHub provider receipt lifecycle is inconsistent",
    );
    expect(() => compile(ambiguousWithInterruptedCode)).toThrow(
      "Pending GitHub provider receipt lifecycle is inconsistent",
    );
  });

  test("rejects pending receipts with the wrong retry or recovery instruction", () => {
    expect(() => compile(pendingReceipt({
      error: {
        code: "ambiguous_provider_outcome",
        message: "GitHub provider result requires reconciliation",
        retry: "do_not_retry",
      },
    }))).toThrow("Pending GitHub provider receipt lifecycle is inconsistent");

    expect(() => compile(pendingReceipt({
      recovery: { nextAction: "none" },
    }))).toThrow("Pending GitHub provider receipt lifecycle is inconsistent");
  });

  test("admits operation targets before every unsettled outcome", () => {
    const valid = [
      [
        unsettledReceipt(
          "github_create_issue",
          `${repositoryFullName}#new`,
          "reserved",
        ),
        "await_provider_result",
      ],
      [
        unsettledReceipt(
          "github_update_issue",
          `${repositoryFullName}#958`,
          "pending_reconciliation",
        ),
        "pending_provider_reconciliation",
      ],
      [
        unsettledReceipt(
          "github_add_issue_labels",
          `${repositoryFullName}#958:labels`,
          "rejected",
        ),
        "no_issue_context_effect",
      ],
      [
        unsettledReceipt(
          "github_remove_issue_assignees",
          `${repositoryFullName}#958:assignees`,
          "reserved",
        ),
        "await_provider_result",
      ],
      [
        unsettledReceipt(
          "github_add_issue_comment",
          `${repositoryFullName}#958:comment:new`,
          "pending_reconciliation",
        ),
        "pending_provider_reconciliation",
      ],
    ] as const;
    for (const [receipt, outcome] of valid) {
      expect(compile(receipt).outcome).toBe(outcome);
    }

    const invalid = [
      unsettledReceipt(
        "github_create_issue",
        `${repositoryFullName}#958`,
        "reserved",
      ),
      unsettledReceipt(
        "github_update_issue",
        "other/repository#958",
        "pending_reconciliation",
      ),
      unsettledReceipt(
        "github_add_issue_labels",
        `${repositoryFullName}#958`,
        "rejected",
      ),
      unsettledReceipt(
        "github_remove_issue_assignees",
        `${repositoryFullName}#new`,
        "reserved",
      ),
      unsettledReceipt(
        "github_add_issue_comment",
        `${repositoryFullName}#958:comment:new:extra`,
        "pending_reconciliation",
      ),
      unsettledReceipt(
        "github_update_issue",
        `${repositoryFullName}#0`,
        "reserved",
      ),
      unsettledReceipt(
        "github_update_issue",
        `${repositoryFullName}#0958`,
        "rejected",
      ),
    ];
    for (const receipt of invalid) {
      expect(() => compile(receipt)).toThrow(
        "GitHub provider receipt target is invalid for its operation",
      );
    }
  });

  test("requires reserved and rejected receipts to retain their exact recovery posture", () => {
    expect(() => compile(issueReceipt({
      state: "reserved",
      providerRequestId: null,
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: {
        code: "unexpected",
        message: "Reserved receipts cannot retain an error",
        retry: "do_not_retry",
      },
    }))).toThrow("Reserved GitHub provider receipt lifecycle is inconsistent");

    expect(() => compile(issueReceipt({
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
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "inspect_authority_or_provider_rejection" },
    }))).toThrow("Rejected GitHub provider receipt lifecycle is inconsistent");
  });

  test("requires settled and reconciled receipts to clear error and recovery state", () => {
    for (const state of ["succeeded", "reconciled"] as const) {
      expect(() => compile(issueReceipt({
        state,
        error: {
          code: "stale_error",
          message: "Settled receipts cannot retain an error",
          retry: "do_not_retry",
        },
      }))).toThrow("Settled GitHub provider receipt lifecycle is inconsistent");

      expect(() => compile(issueReceipt({
        state,
        recovery: { nextAction: "reconcile_exact_operation" },
      }))).toThrow("Settled GitHub provider receipt lifecycle is inconsistent");
    }
  });

  test("requires the exact stale update error and recovery contract", () => {
    const result = issueResult();
    const base = issueReceipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      state: "stale",
      providerRequestId: null,
      result,
      verification: {
        state: "failed",
        checkedAt,
        sourceRevision: result.sourceRevision,
      },
      error: {
        code: "stale_provider_version",
        message: "GitHub issue source revision changed before the guarded update",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "refresh_and_retry_with_new_version" },
    });

    expect(compile(base).outcome).toBe("propose_context_acceptance");
    expect(() => compile({
      ...base,
      error: { ...base.error!, code: "ambiguous_provider_outcome" },
    })).toThrow("Stale GitHub provider receipt lifecycle is inconsistent");
    expect(() => compile({
      ...base,
      recovery: { nextAction: "none" },
    })).toThrow("Stale GitHub provider receipt lifecycle is inconsistent");
  });

  test("binds a settled comment receipt to its exact issue target", () => {
    const valid = commentReceipt();
    expect(compile(valid)).toMatchObject({
      operation: "github_add_issue_comment",
      outcome: "no_issue_context_effect",
      providerSnapshot: null,
    });

    expect(() => compile({
      ...valid,
      target: `${repositoryFullName}#959:comment:new`,
    })).toThrow("comment receipt target does not bind the provider result");
  });

  test("rejects read-only operations masquerading as provider write receipts", () => {
    for (const operation of [
      "github_get_issue",
      "github_list_issues",
      "github_search_issues",
    ] as const) {
      expect(() => compile(issueReceipt({ operation }))).toThrow(
        "does not produce a provider write receipt",
      );
    }
  });
});

function compile(receipt: GitHubProviderReceipt) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt,
    current: null,
  });
}

function unsettledReceipt(
  operation: GitHubIssueProviderOperation,
  target: string,
  state: "reserved" | "pending_reconciliation" | "rejected",
): GitHubProviderReceipt {
  if (state === "reserved") {
    return issueReceipt({
      operation,
      target,
      state,
      providerRequestId: null,
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
      error: null,
      recovery: { nextAction: "none" },
    });
  }
  if (state === "pending_reconciliation") {
    return pendingReceipt({ operation, target });
  }
  return issueReceipt({
    operation,
    target,
    state,
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
  });
}

function pendingReceipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return issueReceipt({
    state: "pending_reconciliation",
    providerRequestId: null,
    result: null,
    verification: {
      state: "failed",
      checkedAt,
      sourceRevision: null,
    },
    error: {
      code: "ambiguous_provider_outcome",
      message: "GitHub provider result requires reconciliation",
      retry: "reconcile_before_retry",
    },
    recovery: { nextAction: "reconcile_exact_operation" },
    ...overrides,
  });
}

function issueReceipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const result = issueResult();
  return {
    version: 1,
    id: "ghop_lifecycle",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_cedar",
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
    updatedAt: checkedAt,
    providerRequestId: "request-lifecycle",
    result,
    verification: {
      state: "passed",
      checkedAt,
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
    target: `${repositoryFullName}#958:comment:new`,
    result,
    verification: {
      state: "passed",
      checkedAt,
      sourceRevision: result.sourceRevision,
    },
  };
}

function issueResult(): GitHubIssueContext {
  return structuredClone(buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 958,
    title: "Provider context reconciliation lifecycle controls",
    body: null,
    state: "open",
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    createdAt: "2026-08-02T17:59:51.000Z",
    updatedAt: checkedAt,
    providerNodeId: "I_kwDOLifecycle",
    sourceRevision: "github-rest:I_kwDOLifecycle:2026-08-02T18:00:00.000Z",
  }));
}

function commentResult(): GitHubIssueComment {
  return {
    id: "123456958",
    issueNumber: 958,
    canonicalUrl:
      `https://github.com/${repositoryFullName}/issues/958#issuecomment-123456958`,
    createdAt: "2026-08-02T17:59:58.000Z",
    updatedAt: checkedAt,
    sourceRevision: "github-rest:IC_123456958:2026-08-02T18:00:00.000Z",
    bodyRevision: { byteLength: 12, sha256: hash("e") },
    containsBody: false,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
