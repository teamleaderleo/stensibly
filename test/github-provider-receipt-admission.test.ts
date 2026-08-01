import { describe, expect, test } from "bun:test";
import {
  admitGitHubProviderReceipt,
  canonicalGitHubProviderReceiptJson,
  parseGitHubProviderReceiptJson,
} from "../src/github-provider-receipt-admission.ts";

describe("GitHub provider receipt admission", () => {
  test("round-trips one canonical deeply frozen receipt", () => {
    const admitted = admitGitHubProviderReceipt(receipt());
    const json = canonicalGitHubProviderReceiptJson(admitted);
    const parsed = parseGitHubProviderReceiptJson(json);

    expect(parsed).toEqual(admitted);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.verification)).toBe(true);
    expect(Object.isFrozen(parsed.recovery)).toBe(true);
  });

  test("captures data descriptors without invoking caller getters", () => {
    let getterCalled = false;
    const hostile = Object.defineProperty(receipt(), "target", {
      enumerable: true,
      configurable: true,
      get() {
        getterCalled = true;
        return "teamleaderleo/stensibly#928";
      },
    });

    expect(() => admitGitHubProviderReceipt(hostile)).toThrow(
      "enumerable data fields",
    );
    expect(getterCalled).toBe(false);
  });

  test("does not dispatch through a hostile get trap", () => {
    let reads = 0;
    const source = receipt();
    const expected = admitGitHubProviderReceipt(source);
    const hostile = new Proxy(source, {
      get() {
        reads += 1;
        throw new Error("ordinary property access is forbidden");
      },
    });

    expect(admitGitHubProviderReceipt(hostile)).toEqual(expected);
    expect(reads).toBe(0);
  });

  test("rejects impossible and noncanonical UTC timestamps", () => {
    expect(() => admitGitHubProviderReceipt(receipt({
      createdAt: "2026-02-30T00:00:00.000Z",
      updatedAt: "2026-02-30T00:00:00.000Z",
    }))).toThrow("not canonical");
    expect(() => admitGitHubProviderReceipt(receipt({
      createdAt: "2026-08-02T00:00:00.00Z",
    }))).toThrow("createdAt is invalid");
  });

  test("requires a strict issue-body presence boolean", () => {
    expect(() => admitGitHubProviderReceipt(receipt({
      operation: "github_create_issue",
      result: {
        ...issueResult(),
        bodyRevision: {
          present: "false",
          byteLength: 0,
          sha256: hash("0"),
        },
      },
    }))).toThrow("body presence is invalid");
  });

  test("binds result shape to the exact operation family", () => {
    expect(() => admitGitHubProviderReceipt(receipt({
      operation: "github_add_issue_comment",
      result: issueResult(),
    }))).toThrow("comment operation has an issue result");
    expect(() => admitGitHubProviderReceipt(receipt({
      operation: "github_update_issue",
      result: commentResult(),
    }))).toThrow("issue operation has a comment result");
  });

  test("rejects reversed result chronology", () => {
    expect(() => admitGitHubProviderReceipt(receipt({
      operation: "github_add_issue_comment",
      result: {
        ...commentResult(),
        createdAt: "2026-08-02T00:00:02.000Z",
        updatedAt: "2026-08-02T00:00:01.000Z",
      },
    }))).toThrow("comment update precedes creation");
  });

  test("rejects credential-shaped retained text and noncanonical JSON", () => {
    expect(() => admitGitHubProviderReceipt(receipt({
      target: `Bearer ${"a".repeat(32)}`,
    }))).toThrow("credential-shaped text");

    const canonical = canonicalGitHubProviderReceiptJson(
      admitGitHubProviderReceipt(receipt()),
    );
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    const reordered = JSON.stringify({ target: parsed.target, ...parsed });
    expect(reordered).not.toBe(canonical);
    expect(() => parseGitHubProviderReceiptJson(reordered)).toThrow(
      "must be canonical",
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
    actorId: "actor_juniper",
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

function issueResult(): Record<string, unknown> {
  return {
    version: 1,
    provider: "github",
    reference: {
      provider: "github",
      host: "github.com",
      owner: "teamleaderleo",
      repository: "stensibly",
      repositoryFullName: "teamleaderleo/stensibly",
      number: 928,
      externalId: "github:teamleaderleo/stensibly#928",
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/issues/928",
    },
    title: "Persist GitHub provider receipts in hosted Convex",
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
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
    providerNodeId: "I_kwDOReceipt",
    sourceRevision: "github-rest:I_kwDOReceipt:2026-08-02T00:00:01.000Z",
    contentSha256: hash("c"),
    snapshotSha256: hash("d"),
    containsIssueBody: false,
  };
}

function commentResult(): Record<string, unknown> {
  return {
    id: "123456789",
    issueNumber: 928,
    canonicalUrl:
      "https://github.com/teamleaderleo/stensibly/issues/928#issuecomment-123456789",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
    sourceRevision: "github-rest:IC_123456789:2026-08-02T00:00:01.000Z",
    bodyRevision: { byteLength: 12, sha256: hash("e") },
    containsBody: false,
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
