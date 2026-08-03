import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const externalId = `github:${repositoryFullName}#958`;

describe("GitHub provider context reconciliation current-revision privacy", () => {
  test("rejects every accepted-context credential family without echoing it", () => {
    const hostile = [
      `github_pat_${"a".repeat(24)}`,
      `ghp_${"a".repeat(24)}`,
      `stn.tok_${"a".repeat(24)}`,
      `sk-proj-${"a".repeat(24)}`,
      `xoxb-${"a".repeat(24)}`,
      "secret://github/source-revision",
      "env://GITHUB_SOURCE_REVISION",
      "Bearer/opaque-source-revision",
      `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`,
    ];

    for (const sourceRevision of hostile) {
      let thrown: unknown;
      try {
        compile(sourceRevision);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as Error).message).toBe(
        "Current GitHub issue source revision cannot be credential-shaped",
      );
      expect((thrown as Error).message).not.toContain(sourceRevision);
    }
  });

  test("retains benign canonical revision families", () => {
    const benign = [
      "etag:W/abc-123",
      `sha256:${"a".repeat(64)}`,
      "github-rest:I_kwDOBenign:2026-08-02T17:27:00.000Z",
      "revision:release-2026.08.02",
    ];

    for (const sourceRevision of benign) {
      const proposal = compile(sourceRevision);
      expect(proposal.currentSourceRevision).toBe(sourceRevision);
      expect(proposal.outcome).toBe("propose_context_acceptance");
    }
  });
});

function compile(sourceRevision: string) {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(),
    current: { externalId, sourceRevision },
  });
}

function receipt(): GitHubProviderReceipt {
  const result = structuredClone(buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 958,
    title: "Current revision privacy control",
    body: null,
    state: "open",
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    createdAt: "2026-08-02T17:26:51.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerNodeId: "I_kwDOCurrentPrivacy",
    sourceRevision:
      "github-rest:I_kwDOCurrentPrivacy:2026-08-02T17:27:00.000Z",
  }));
  return {
    version: 1,
    id: "ghop_current_privacy",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_cedar",
    clientId: "client_github_only",
    connectionId: "ghconn_current_privacy",
    installationId: "installation_current_privacy",
    bindingId: "ghbind_current_privacy",
    attachmentId: "attachment_current_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "provider-context-current-privacy",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T17:26:55.000Z",
    updatedAt: "2026-08-02T17:27:00.000Z",
    providerRequestId: "request-current-privacy",
    result,
    verification: {
      state: "passed",
      checkedAt: "2026-08-02T17:27:00.000Z",
      sourceRevision: result.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
