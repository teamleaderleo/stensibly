import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";

describe("GitHub provider context reconciliation target binding", () => {
  test("accepts coherent create, update, label, and assignee targets", () => {
    const proposals = [
      compile(receipt({
        operation: "github_create_issue",
        target: `${repositoryFullName}#new`,
        resultNumber: 958,
      })),
      compile(receipt({
        operation: "github_update_issue",
        target: `${repositoryFullName}#958`,
        resultNumber: 958,
      })),
      compile(receipt({
        operation: "github_add_issue_labels",
        target: `${repositoryFullName}#958:labels`,
        resultNumber: 958,
      })),
      compile(receipt({
        operation: "github_remove_issue_assignees",
        target: `${repositoryFullName}#958:assignees`,
        resultNumber: 958,
      })),
    ];

    for (const proposal of proposals) {
      expect(proposal.outcome).toBe("propose_context_acceptance");
      expect(proposal.externalId).toBe(`github:${repositoryFullName}#958`);
    }
  });

  test("rejects a create receipt that does not retain the new-issue target", () => {
    expect(() => compile(receipt({
      operation: "github_create_issue",
      target: `${repositoryFullName}#958`,
      resultNumber: 958,
    }))).toThrow("target does not bind the provider result");
  });

  test("rejects same-repository issue substitution under each target grammar", () => {
    const cases = [
      {
        operation: "github_update_issue" as const,
        target: `${repositoryFullName}#958`,
      },
      {
        operation: "github_add_issue_labels" as const,
        target: `${repositoryFullName}#958:labels`,
      },
      {
        operation: "github_remove_issue_assignees" as const,
        target: `${repositoryFullName}#958:assignees`,
      },
    ];

    for (const { operation, target } of cases) {
      expect(() => compile(receipt({
        operation,
        target,
        resultNumber: 959,
      }))).toThrow("target does not bind the provider result");
    }
  });

  test("rejects cross-repository substitution with the same issue number", () => {
    const cases = [
      {
        operation: "github_create_issue" as const,
        target: `${repositoryFullName}#new`,
      },
      {
        operation: "github_update_issue" as const,
        target: `${repositoryFullName}#958`,
      },
      {
        operation: "github_add_issue_labels" as const,
        target: `${repositoryFullName}#958:labels`,
      },
      {
        operation: "github_remove_issue_assignees" as const,
        target: `${repositoryFullName}#958:assignees`,
      },
    ];

    for (const { operation, target } of cases) {
      expect(() => compile(receipt({
        operation,
        target,
        resultNumber: 958,
        resultOwner: "other",
        resultRepository: "repository",
      }))).toThrow("GitHub issue reference repository identity is invalid");
    }
  });

  test("rejects stale cross-repository update readback", () => {
    expect(() => compile(receipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      resultNumber: 958,
      resultOwner: "other",
      resultRepository: "repository",
      state: "stale",
    }))).toThrow("GitHub issue reference repository identity is invalid");
  });

  test("rejects a coherent issue number with a missing or wrong mutation suffix", () => {
    const cases = [
      {
        operation: "github_add_issue_labels" as const,
        target: `${repositoryFullName}#958`,
      },
      {
        operation: "github_remove_issue_assignees" as const,
        target: `${repositoryFullName}#958:labels`,
      },
    ];

    for (const input of cases) {
      expect(() => compile(receipt({
        ...input,
        resultNumber: 958,
      }))).toThrow("target does not bind the provider result");
    }
  });

  test("rejects stale update readback from another issue", () => {
    expect(() => compile(receipt({
      operation: "github_update_issue",
      target: `${repositoryFullName}#958`,
      resultNumber: 959,
      state: "stale",
    }))).toThrow("target does not bind the provider result");
  });
});

function compile(receiptValue: GitHubProviderReceipt) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receiptValue,
    current: null,
  });
}

function receipt(input: {
  operation:
    | "github_create_issue"
    | "github_update_issue"
    | "github_add_issue_labels"
    | "github_remove_issue_assignees";
  target: string;
  resultNumber: number;
  resultOwner?: string;
  resultRepository?: string;
  state?: "succeeded" | "stale";
}): GitHubProviderReceipt {
  const result = issueResult(
    input.resultNumber,
    input.resultOwner ?? "teamleaderleo",
    input.resultRepository ?? "stensibly",
  );
  const stale = input.state === "stale";
  return {
    version: 1,
    id: `ghop_target_${input.resultNumber}`,
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: input.operation,
    target: input.target,
    actorId: "actor_cedar",
    clientId: "client_github_only",
    connectionId: "ghconn_target",
    installationId: "installation_target",
    bindingId: "ghbind_target",
    attachmentId: "attachment_target",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: `target-binding-${input.operation}-${input.resultNumber}`,
    parametersSha256: hash("b"),
    state: stale ? "stale" : "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:26:55.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerRequestId: `request-${input.resultNumber}`,
    result,
    verification: {
      state: stale ? "failed" : "passed",
      checkedAt: "2026-08-02T17:27:00.000Z",
      sourceRevision: result.sourceRevision,
    },
    error: stale
      ? {
        code: "stale_provider_version",
        message: "GitHub issue source revision changed before the guarded update",
        retry: "do_not_retry",
      }
      : null,
    recovery: {
      nextAction: stale ? "refresh_and_retry_with_new_version" : "none",
    },
  };
}

function issueResult(
  number: number,
  owner: string,
  repository: string,
): GitHubIssueContext {
  return structuredClone(buildGitHubIssueContext({
    owner,
    repository,
    number,
    title: `Target binding control ${number}`,
    body: null,
    state: "open",
    labels: ["area:github"],
    assignees: [owner],
    createdAt: "2026-08-02T17:26:51.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerNodeId: `I_kwDOReconcile${number}`,
    sourceRevision:
      `github-rest:I_kwDOReconcile${number}:2026-08-02T17:27:00.000Z`,
  }));
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
