import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import { InMemoryGitHubProviderReceiptStore } from "../src/github-provider-receipts.ts";

describe("GitHub provider receipt request identity", () => {
  test("replays an exact request while preserving the original receipt identity", async () => {
    const store = new InMemoryGitHubProviderReceiptStore();
    const original = receipt();

    expect(await store.reserveGitHubProviderReceipt(original)).toEqual({
      outcome: "reserved",
      receipt: original,
    });

    const replay = await store.reserveGitHubProviderReceipt(receipt({
      id: "ghop_retry_candidate",
      createdAt: "2026-08-02T00:01:00.000Z",
      updatedAt: "2026-08-02T00:01:00.000Z",
    }));

    expect(replay.outcome).toBe("replay");
    expect(replay.receipt).toMatchObject({
      id: original.id,
      createdAt: original.createdAt,
      state: "pending_reconciliation",
      error: {
        code: "provider_dispatch_in_progress_or_interrupted",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    });
  });

  test("conflicts when an authorization- or effect-defining identity changes", async () => {
    const variants: Array<[string, Partial<GitHubProviderReceipt>]> = [
      ["repository", { repositoryFullName: "teamleaderleo/other" }],
      ["operation", { operation: "github_update_issue" }],
      ["target", { target: "teamleaderleo/stensibly#930" }],
      ["actor", { actorId: "actor_other" }],
      ["client", { clientId: "client_other" }],
      ["connection", { connectionId: "ghconn_other" }],
      ["installation", { installationId: "installation_other" }],
      ["binding", { bindingId: "ghbind_other" }],
      ["attachment", { attachmentId: "attachment_other" }],
      ["attachment snapshot", {
        attachmentSnapshotSha256: `sha256:${"c".repeat(64)}`,
      }],
      ["capability grant", { capabilityGrantId: "grant_other" }],
      ["approval", { approvalId: "approval_other" }],
      ["parameters", { parametersSha256: `sha256:${"d".repeat(64)}` }],
    ];

    for (const [name, changes] of variants) {
      const store = new InMemoryGitHubProviderReceiptStore();
      const original = receipt();
      await store.reserveGitHubProviderReceipt(original);

      const conflict = await store.reserveGitHubProviderReceipt(receipt({
        id: `ghop_retry_${name.replaceAll(" ", "_")}`,
        createdAt: "2026-08-02T00:01:00.000Z",
        updatedAt: "2026-08-02T00:01:00.000Z",
        ...changes,
      }));

      expect(conflict.outcome).toBe("conflict");
      expect(conflict.receipt).toEqual(original);
    }
  });

  test("rejects lifecycle updates that drift from the original reservation", async () => {
    const variants: Array<Partial<GitHubProviderReceipt>> = [
      { id: "ghop_other" },
      { createdAt: "2026-08-02T00:00:01.000Z" },
      { target: "teamleaderleo/stensibly#930" },
      { connectionId: "ghconn_other" },
      { installationId: "installation_other" },
      { bindingId: "ghbind_other" },
      { attachmentId: "attachment_other" },
      { attachmentSnapshotSha256: `sha256:${"c".repeat(64)}` },
      { capabilityGrantId: "grant_other" },
      { approvalId: "approval_other" },
      { parametersSha256: `sha256:${"d".repeat(64)}` },
    ];

    for (const changes of variants) {
      const store = new InMemoryGitHubProviderReceiptStore();
      const original = receipt();
      await store.reserveGitHubProviderReceipt(original);

      await expect(
        store.updateGitHubProviderReceipt(succeededReceipt(original, changes)),
      ).rejects.toThrow(
        "GitHub provider receipt update does not match the reservation",
      );
      expect(await store.getGitHubProviderReceipt(
        original.project,
        original.idempotencyKey,
      )).toEqual(original);
    }
  });

  test("accepts lifecycle updates and isolates stored receipts from caller mutation", async () => {
    const store = new InMemoryGitHubProviderReceiptStore();
    const original = receipt();
    const reservation = await store.reserveGitHubProviderReceipt(original);

    reservation.receipt.target = "caller-mutated-target";
    original.target = "caller-mutated-original";
    expect(await store.getGitHubProviderReceipt(
      "stensibly",
      "github-create-issue-929",
    )).toMatchObject({ target: "teamleaderleo/stensibly#929", state: "reserved" });

    const updated = succeededReceipt(receipt());
    const stored = await store.updateGitHubProviderReceipt(updated);
    stored.providerRequestId = "caller-mutated-request";

    expect(await store.getGitHubProviderReceipt(
      updated.project,
      updated.idempotencyKey,
    )).toEqual(updated);
  });
});

function succeededReceipt(
  original: GitHubProviderReceipt,
  changes: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return {
    ...original,
    state: "succeeded",
    updatedAt: "2026-08-02T00:00:05.000Z",
    providerRequestId: "github-request-929",
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T00:00:05.000Z",
      sourceRevision: "github-rest:I_issue_929:rev-1",
    },
    ...changes,
  };
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_929",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_create_issue",
    target: "teamleaderleo/stensibly#929",
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: "grant_1",
    approvalId: "approval_1",
    idempotencyKey: "github-create-issue-929",
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "reserved",
    attemptCount: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
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
