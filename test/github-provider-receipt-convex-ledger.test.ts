import { describe, expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  canonicalGitHubProviderReceiptJson,
  admitGitHubProviderReceipt,
} from "../src/github-provider-receipt-admission.ts";
import {
  ConvexGitHubProviderReceiptStore,
  GitHubProviderReceiptStorageError,
} from "../src/github-provider-receipt-convex-ledger.ts";

class FakeClient implements ConvexCaller {
  readonly mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  mutationResult: unknown;
  queryResult: unknown;

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.mutations.push({ name: String(reference), args });
    return this.mutationResult;
  }

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: String(reference), args });
    return this.queryResult;
  }
}

describe("Convex GitHub provider receipt store", () => {
  test("binds exact reservation response and service scope", async () => {
    const client = new FakeClient();
    const subject = receipt();
    client.mutationResult = {
      outcome: "reserved",
      receiptJson: canonicalGitHubProviderReceiptJson(subject),
    };
    const store = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });

    await expect(store.reserveGitHubProviderReceipt(subject)).resolves.toEqual({
      outcome: "reserved",
      receipt: subject,
    });
    expect(client.mutations[0]?.args).toEqual({
      project: "stensibly",
      receiptJson: canonicalGitHubProviderReceiptJson(subject),
      serviceSecret: "service-secret",
      workspace: "default",
    });
  });

  test("rejects replay response substitution within the same project", async () => {
    const client = new FakeClient();
    const subject = receipt();
    const substituted = receipt({
      id: "ghop_original",
      target: "teamleaderleo/stensibly#929:comment:new",
      createdAt: "2026-08-02T00:01:00.000Z",
      updatedAt: "2026-08-02T00:01:00.000Z",
      state: "pending_reconciliation",
      error: {
        code: "provider_dispatch_in_progress_or_interrupted",
        message:
          "GitHub provider dispatch may still be in progress or may have been interrupted",
        retry: "reconcile_before_retry",
      },
      recovery: { nextAction: "reconcile_exact_operation" },
    });
    client.mutationResult = {
      outcome: "replay",
      receiptJson: canonicalGitHubProviderReceiptJson(substituted),
    };
    const store = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret: "service-secret",
    });

    await expect(store.reserveGitHubProviderReceipt(subject)).rejects
      .toBeInstanceOf(GitHubProviderReceiptStorageError);
  });

  test("rejects altered update response instead of trusting same ID and key", async () => {
    const client = new FakeClient();
    const subject = receipt({
      state: "rejected",
      updatedAt: "2026-08-02T00:00:01.000Z",
      error: {
        code: "provider_rejected",
        message: "GitHub rejected the bounded request",
        retry: "do_not_retry",
      },
      recovery: { nextAction: "inspect_authority_or_provider_rejection" },
    });
    client.mutationResult = canonicalGitHubProviderReceiptJson(receipt({
      state: "succeeded",
      updatedAt: "2026-08-02T00:00:01.000Z",
    }));
    const store = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret: "service-secret",
    });

    await expect(store.updateGitHubProviderReceipt(subject)).rejects
      .toBeInstanceOf(GitHubProviderReceiptStorageError);
  });

  test("rejects hostile backend getters without invoking them", async () => {
    const client = new FakeClient();
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { outcome: "reserved" };
    Object.defineProperty(hostile, "receiptJson", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private backend prose");
      },
    });
    client.mutationResult = hostile;
    const store = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret: "service-secret",
    });

    await expect(store.reserveGitHubProviderReceipt(receipt())).rejects
      .toBeInstanceOf(GitHubProviderReceiptStorageError);
    expect(getterCalls).toBe(0);
  });

  test("rejects noncanonical workspace and project scope before backend use", async () => {
    const client = new FakeClient();
    expect(() => new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret: "service-secret",
      workspace: "Default",
    })).toThrow("lowercase slug");

    const store = new ConvexGitHubProviderReceiptStore({
      client,
      serviceSecret: "service-secret",
    });
    await expect(store.getGitHubProviderReceipt(
      "Stensibly",
      "provider-receipt-1",
    )).rejects.toThrow("lowercase slug");
    expect(client.queries).toHaveLength(0);
  });
});

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return admitGitHubProviderReceipt({
    version: 1,
    id: "ghop_receipt_1",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_add_issue_comment",
    target: "teamleaderleo/stensibly#928:comment:new",
    actorId: "actor_juniper",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-receipt-1",
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
  });
}
