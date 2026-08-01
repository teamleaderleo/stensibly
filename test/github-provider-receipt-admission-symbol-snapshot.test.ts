import { describe, expect, test } from "bun:test";
import { admitGitHubProviderReceipt } from "../src/github-provider-receipt-admission.ts";

describe("GitHub provider receipt descriptor snapshot", () => {
  test("rejects a symbol revealed only by the captured descriptor map", () => {
    const hidden = Symbol("hidden-receipt-field");
    const source = receipt();
    Object.defineProperty(source, hidden, {
      configurable: true,
      enumerable: true,
      value: "github_update_issue",
    });
    let ownKeyReads = 0;
    const hostile = new Proxy(source, {
      ownKeys(target) {
        ownKeyReads += 1;
        const keys = Reflect.ownKeys(target);
        return ownKeyReads === 1
          ? keys
          : keys.filter((key) => key !== hidden);
      },
    });

    expect(() => admitGitHubProviderReceipt(hostile)).toThrow("symbol fields");
    expect(ownKeyReads).toBe(1);
  });
});

function receipt(): Record<PropertyKey, unknown> {
  return {
    version: 1,
    id: "ghop_symbol_snapshot",
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
    idempotencyKey: "provider-receipt-symbol-snapshot",
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
  };
}
