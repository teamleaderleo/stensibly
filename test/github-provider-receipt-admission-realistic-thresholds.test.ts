import { describe, expect, test } from "bun:test";
import { admitGitHubProviderReceipt } from "../src/github-provider-receipt-admission.ts";

describe("GitHub provider receipt realistic credential thresholds", () => {
  test("rejects Slack tokens at the repository-standard 16-character threshold", () => {
    const token = `xoxb-${"a".repeat(16)}`;

    expect(() => admitGitHubProviderReceipt(receipt({
      idempotencyKey: `keyx${token}`,
    }))).toThrow(
      "GitHub provider receipt contains credential-shaped text",
    );
  });

  test("admits bearer-like aliases below the repository-standard 12-character threshold", () => {
    const alias = `revisionxBearer ${"a".repeat(11)}`;
    const admitted = admitGitHubProviderReceipt(receipt({
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: alias,
      },
    }));

    expect(admitted.verification.sourceRevision).toBe(alias);
  });

  test("still rejects bearer tokens at the 12-character threshold", () => {
    const token = `revisionxBearer ${"a".repeat(12)}`;

    expect(() => admitGitHubProviderReceipt(receipt({
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: token,
      },
    }))).toThrow(
      "GitHub provider receipt contains credential-shaped text",
    );
  });
});

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "ghop_threshold_receipt_1",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_add_issue_comment",
    target: "teamleaderleo/stensibly#982:comment:new",
    actorId: "actor_cicada",
    clientId: "client_github_only",
    connectionId: "ghconn_threshold_1",
    installationId: "installation_threshold_1",
    bindingId: "ghbind_threshold_1",
    attachmentId: "attachment_threshold_1",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-receipt-threshold-1",
    parametersSha256: hash("b"),
    state: "reserved",
    attemptCount: 1,
    createdAt: "2026-08-03T08:20:00.000Z",
    updatedAt: "2026-08-03T08:20:00.000Z",
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
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
