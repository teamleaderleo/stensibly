import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const externalId = `github:${repositoryFullName}#958`;

describe("GitHub reconciliation current revision realistic privacy", () => {
  test("rejects realistic Stensibly and authorization shapes before proposal retention", () => {
    const payload = "a".repeat(12);
    const hostile = [
      `revisionxstn.tok_${payload}`,
      `revisionxstn.svc_${payload}`,
      "revisionauthorization:token",
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
      expect(JSON.stringify(thrown)).not.toContain(sourceRevision);
    }
  });

  test("preserves a benign short Stensibly-like revision", () => {
    const sourceRevision = "revisionxstn.svc_review";
    const proposal = compile(sourceRevision);

    expect(proposal.currentSourceRevision).toBe(sourceRevision);
    expect(proposal.outcome).toBe("propose_context_acceptance");
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
    title: "Current realistic revision privacy",
    body: null,
    state: "open",
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    createdAt: "2026-08-04T17:30:00.000Z",
    updatedAt: "2026-08-04T17:31:00.000Z",
    providerNodeId: "I_current_realistic_privacy",
    sourceRevision:
      "github-rest:I_current_realistic_privacy:2026-08-04T17:31:00.000Z",
  }));
  return {
    version: 1,
    id: "ghop_current_realistic_privacy",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#958`,
    actorId: "actor_lark",
    clientId: "client_github_only",
    connectionId: "ghconn_current_realistic_privacy",
    installationId: "installation_current_realistic_privacy",
    bindingId: "ghbind_current_realistic_privacy",
    attachmentId: "attachment_current_realistic_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "current-realistic-privacy",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-04T17:30:30.000Z",
    updatedAt: "2026-08-04T17:31:00.000Z",
    providerRequestId: "REQ-CURRENT-REALISTIC-PRIVACY",
    result,
    verification: {
      state: "passed",
      checkedAt: "2026-08-04T17:31:00.000Z",
      sourceRevision: result.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
