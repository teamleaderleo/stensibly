import { describe, expect, test } from "bun:test";
import { admitGitHubProviderReceipt } from "../src/github-provider-receipt-admission.ts";

describe("GitHub provider receipt embedded credential admission", () => {
  test("rejects realistic credential families anywhere in retained receipt text", () => {
    const long = "a".repeat(24);
    const jwt = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;
    const cases: Array<Record<string, unknown>> = [
      { id: `ghopxgithub_pat_${long}` },
      { actorId: `actorxghp_${long}` },
      { clientId: `clientxsk-${long}` },
      { providerRequestId: `requestxstn.tok_${long}` },
      { idempotencyKey: `keyxxoxb-${long}` },
      {
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: `revisionxBearer ${long}`,
        },
      },
      { attachmentId: "attachmentxsecret://github/key" },
      { connectionId: `connectionx${jwt}` },
      { target: "targetxauthorization:token" },
      { target: "targetx-----BEGIN PRIVATE KEY-----" },
    ];

    for (const overrides of cases) {
      let observed: unknown;
      try {
        admitGitHubProviderReceipt(receipt(overrides));
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(RangeError);
      expect((observed as Error).message).toBe(
        "GitHub provider receipt contains credential-shaped text",
      );
      expect((observed as Error).message).not.toContain(long);
    }
  });

  test("preserves benign short token-like receipt identities", () => {
    const admitted = admitGitHubProviderReceipt(receipt({
      id: "ghop_github_pat_review",
      actorId: "actor_ghp_review",
      clientId: "client_sk-review",
      providerRequestId: "request_stn.tok_review",
      idempotencyKey: "key_xoxb-review",
      connectionId: "connection_eyJ.short.token",
      verification: {
        state: "not_run",
        checkedAt: null,
        sourceRevision: "revision_Bearer-review",
      },
    }));

    expect(admitted.id).toBe("ghop_github_pat_review");
    expect(admitted.actorId).toBe("actor_ghp_review");
    expect(admitted.clientId).toBe("client_sk-review");
    expect(admitted.providerRequestId).toBe("request_stn.tok_review");
    expect(admitted.idempotencyKey).toBe("key_xoxb-review");
    expect(admitted.connectionId).toBe("connection_eyJ.short.token");
    expect(admitted.verification.sourceRevision).toBe(
      "revision_Bearer-review",
    );
  });
});

function receipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    id: "ghop_receipt_1",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_add_issue_comment",
    target: "teamleaderleo/stensibly#928:comment:new",
    actorId: "actor_plover",
    clientId: "client_github_only",
    connectionId: "ghconn_1",
    installationId: "installation_1",
    bindingId: "ghbind_1",
    attachmentId: "attachment_1",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-receipt-1",
    parametersSha256: hash("b"),
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

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
