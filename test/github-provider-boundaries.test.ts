import { describe, expect, test } from "bun:test";
import type { GitHubIssueContextInput } from "../src/github-issue-context.ts";
import {
  GitHubProviderBindingError,
  InMemoryGitHubProviderReceiptStore,
  buildScopedGitHubIssueContext,
  type GitHubProviderReceipt,
} from "../src/github-issue-provider.ts";
import { buildScopedGitHubIssueComment } from "../src/github-provider-validation.ts";

const fixedNow = "2026-07-31T00:04:00.000Z";

function receipt(overrides: Partial<GitHubProviderReceipt> = {}): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_boundary_1",
    project: "stensibly",
    provider: "github",
    repositoryFullName: "teamleaderleo/stensibly",
    operation: "github_create_issue",
    target: "teamleaderleo/stensibly#new",
    actorId: "agent-a",
    clientId: "client-a",
    connectionId: "ghconn_1",
    installationId: "12345",
    bindingId: "ghbind_1",
    attachmentId: "patt_1",
    attachmentSnapshotSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capabilityGrantId: "grant_1",
    approvalId: null,
    idempotencyKey: "create-1",
    parametersSha256: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    state: "reserved",
    attemptCount: 1,
    createdAt: fixedNow,
    updatedAt: fixedNow,
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

function issue(overrides: Partial<GitHubIssueContextInput> = {}): GitHubIssueContextInput {
  return {
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 525,
    title: "Bake first-party GitHub actions into Stensibly",
    body: "Bounded provider execution.",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: [],
    milestone: null,
    relationships: [],
    createdAt: "2026-07-30T16:17:47Z",
    updatedAt: "2026-07-30T16:17:47Z",
    providerNodeId: "I_525",
    sourceRevision: "github-rev-525",
    ...overrides,
  };
}

describe("GitHub provider boundaries", () => {
  test("treats actor or client reuse of an idempotency key as a conflict", async () => {
    const store = new InMemoryGitHubProviderReceiptStore();
    const first = receipt();
    expect((await store.reserveGitHubProviderReceipt(first)).outcome).toBe("reserved");
    expect((await store.reserveGitHubProviderReceipt({
      ...first,
      id: "ghop_boundary_2",
      actorId: "agent-b",
    })).outcome).toBe("conflict");
    expect((await store.reserveGitHubProviderReceipt({
      ...first,
      id: "ghop_boundary_3",
      clientId: "client-b",
    })).outcome).toBe("conflict");
  });

  test("rejects provider issue results from a repository outside the binding", () => {
    expect(() => buildScopedGitHubIssueContext(issue({
      owner: "other-owner",
      repository: "other-repository",
    }), "teamleaderleo/stensibly")).toThrow(GitHubProviderBindingError);
  });

  test("canonicalizes GitHub timestamps without milliseconds for comments", () => {
    const comment = buildScopedGitHubIssueComment({
      id: "5133483603",
      issueNumber: 525,
      body: "Provider execution core opened.",
      canonicalUrl: "https://github.com/teamleaderleo/stensibly/issues/525#issuecomment-5133483603",
      createdAt: "2026-07-30T16:17:47Z",
      updatedAt: "2026-07-30T16:17:47Z",
      sourceRevision: "github-comment-5133483603",
    }, "teamleaderleo/stensibly", 525);

    expect(comment).toMatchObject({
      createdAt: "2026-07-30T16:17:47.000Z",
      updatedAt: "2026-07-30T16:17:47.000Z",
      containsBody: false,
    });
  });

  test("rejects comment evidence that points outside the bound issue", () => {
    expect(() => buildScopedGitHubIssueComment({
      id: "5133483603",
      issueNumber: 525,
      body: "Provider execution core opened.",
      canonicalUrl: "https://github.com/other-owner/other-repository/issues/525#issuecomment-5133483603",
      createdAt: fixedNow,
      updatedAt: fixedNow,
      sourceRevision: "github-comment-5133483603",
    }, "teamleaderleo/stensibly", 525)).toThrow(GitHubProviderBindingError);
  });
});
