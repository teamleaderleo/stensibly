import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
  composeGitHubProviderContextAcceptanceV1,
  type HostedGitHubIssueContextBindingInputV1,
} from "../src/github-provider-context-acceptance-composer.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
  type GitHubProviderContextReconciliationProposalV1,
} from "../src/github-provider-context-reconciliation.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const observedAt = "2026-08-03T08:30:00.000Z";

describe("GitHub provider context acceptance proposal chronology", () => {
  test("rejects create proposals with a prior revision before binding access", () => {
    const original = createProposal();
    expect(original).toMatchObject({
      operation: "github_create_issue",
      currentSourceRevision: null,
      outcome: "propose_context_acceptance",
    });

    const forged = refingerprint(original, {
      currentSourceRevision: "github-rest:pre-existing-row",
    });
    let reads = 0;
    const hostileBinding: Record<string, unknown> = {};
    Object.defineProperty(hostileBinding, "project", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("binding must not be inspected");
      },
    });

    for (const binding of [
      null,
      hostileBinding as unknown as HostedGitHubIssueContextBindingInputV1,
    ]) {
      expect(() => compose(forged, binding)).toThrow(
        "GitHub reconciliation proposal semantics are invalid",
      );
    }
    expect(reads).toBe(0);
  });

  test("rejects actionable proposals whose current revision already equals provider readback", () => {
    const original = updateProposal();
    expect(original).toMatchObject({
      operation: "github_update_issue",
      currentSourceRevision: "github-rest:I_context_973:previous",
      providerSourceRevision: "github-rest:I_context_973:provider",
      outcome: "propose_context_acceptance",
    });

    const forged = refingerprint(original, {
      currentSourceRevision: original.providerSourceRevision,
    });

    expect(() => compose(forged, null)).toThrow(
      "GitHub reconciliation proposal semantics are invalid",
    );
  });
});

function compose(
  proposal: GitHubProviderContextReconciliationProposalV1,
  binding: HostedGitHubIssueContextBindingInputV1 | null,
) {
  return composeGitHubProviderContextAcceptanceV1({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace: "default",
    proposal,
    binding,
  });
}

function createProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot(
    974,
    "github-rest:I_context_974:provider",
  );
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt({
      id: "ghop_context_create_974",
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
      idempotencyKey: "context-create-974",
      result: snapshot,
      verification: {
        state: "passed",
        checkedAt: observedAt,
        sourceRevision: snapshot.sourceRevision,
      },
    }),
    current: null,
  });
}

function updateProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot(
    973,
    "github-rest:I_context_973:provider",
  );
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt({
      result: snapshot,
      verification: {
        state: "passed",
        checkedAt: observedAt,
        sourceRevision: snapshot.sourceRevision,
      },
    }),
    current: {
      externalId: `github:${repositoryFullName}#973`,
      sourceRevision: "github-rest:I_context_973:previous",
    },
  });
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const snapshot = issueSnapshot(
    973,
    "github-rest:I_context_973:provider",
  );
  return {
    version: 1,
    id: "ghop_context_update_973",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#973`,
    actorId: "actor_cicada",
    clientId: "client_github_only",
    connectionId: "ghconn_context_chronology",
    installationId: "installation_context_chronology",
    bindingId: "ghbind_context_chronology",
    attachmentId: "attach_current",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "context-update-973",
    parametersSha256: hash("b"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T08:29:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "request-context-chronology",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: observedAt,
      sourceRevision: snapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function issueSnapshot(
  number: number,
  sourceRevision: string,
): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number,
    title: `Context chronology ${number}`,
    body: null,
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T08:29:50.000Z",
    updatedAt: observedAt,
    providerNodeId: `I_context_${number}`,
    sourceRevision,
  });
}

function refingerprint(
  proposal: GitHubProviderContextReconciliationProposalV1,
  overrides: Partial<GitHubProviderContextReconciliationProposalV1>,
): GitHubProviderContextReconciliationProposalV1 {
  const body = {
    ...structuredClone(proposal),
    ...overrides,
  };
  return {
    ...body,
    proposalFingerprint: fingerprintCanonicalRequest(
      withoutProposalFingerprint(body),
    ),
  };
}

function withoutProposalFingerprint(
  proposal: GitHubProviderContextReconciliationProposalV1,
): Omit<
  GitHubProviderContextReconciliationProposalV1,
  "proposalFingerprint"
> {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
