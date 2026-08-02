import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const attachmentSnapshotSha256 = `sha256:${"a".repeat(64)}`;
const parametersSha256 = `sha256:${"b".repeat(64)}`;

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const result = buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 958,
    title: "Compile verified GitHub issue receipts into context reconciliation proposals",
    body: null,
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T17:26:51.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerNodeId: "I_kwDOReconcileBinding",
    sourceRevision:
      "github-rest:I_kwDOReconcileBinding:2026-08-02T17:27:00.000Z",
  });
  return {
    version: 1,
    id: "ghop_958_binding",
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
    attachmentId: "attachment_accepted_1",
    attachmentSnapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-context-958-binding",
    parametersSha256,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:26:55.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerRequestId: "request-958-binding",
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

function compile(value: GitHubProviderReceipt) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: value,
    current: null,
  });
}

describe("GitHub provider context reconciliation proposal binding", () => {
  test("retains the exact actor, attachment, and verification time", () => {
    const proposal = compile(receipt());

    expect(proposal).toMatchObject({
      actorId: "actor_lynx",
      attachmentId: "attachment_accepted_1",
      attachmentSnapshotSha256,
      verificationCheckedAt: "2026-08-02T17:27:00.000Z",
      outcome: "propose_context_acceptance",
      nextAction: "submit_context_acceptance",
    });
    expect(Object.isFrozen(proposal)).toBe(true);
  });

  test("changes proposal identity when actor or attachment binding changes", () => {
    const original = compile(receipt());
    const actorChanged = compile(receipt({ actorId: "actor_other" }));
    const attachmentChanged = compile(receipt({
      attachmentId: "attachment_accepted_2",
      attachmentSnapshotSha256: `sha256:${"c".repeat(64)}`,
    }));

    expect(actorChanged.actorId).toBe("actor_other");
    expect(attachmentChanged.attachmentId).toBe("attachment_accepted_2");
    expect(actorChanged.proposalFingerprint).not.toBe(
      original.proposalFingerprint,
    );
    expect(attachmentChanged.proposalFingerprint).not.toBe(
      original.proposalFingerprint,
    );
  });

  test("keeps unsettled receipts bound without inventing verification time", () => {
    const proposal = compile(receipt({
      state: "reserved",
      providerRequestId: null,
      result: null,
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: null,
      },
    }));

    expect(proposal).toMatchObject({
      actorId: "actor_lynx",
      attachmentId: "attachment_accepted_1",
      verificationCheckedAt: null,
      outcome: "await_provider_result",
    });
  });
});
