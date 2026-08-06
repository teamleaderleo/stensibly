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
import {
  buildAcceptedRepositoryInstructionSet,
} from "../src/github-project-context-admission.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const workspace = "default";
const repositoryFullName = "teamleaderleo/stensibly";
const project = "stensibly";
const issueNumber = 973;
const externalId = `github:${repositoryFullName}#${issueNumber}`;
const attachmentId = "attach_current";
const attachmentSnapshotSha256 = `sha256:${"a".repeat(64)}`;
const verificationCheckedAt = "2026-08-02T18:30:00.000Z";

const previousSnapshot = issueSnapshot(
  issueNumber,
  "github-rest:I_context_973:previous",
  "2026-08-02T18:20:00.000Z",
  "Previous accepted title",
);
const providerSnapshot = issueSnapshot(
  issueNumber,
  "github-rest:I_context_973:provider",
  verificationCheckedAt,
  "Verified provider title",
);
const instructionSet = buildAcceptedRepositoryInstructionSet({
  projectAttachmentId: attachmentId,
  projectAttachmentSnapshotSha256: attachmentSnapshotSha256,
  sources: [{
    path: "AGENTS.md",
    revision: "main@accepted",
    contentSha256: `sha256:${"b".repeat(64)}`,
  }],
});

describe("GitHub provider context acceptance composer", () => {
  test("composes an exact synchronized acceptance subject for an existing issue", () => {
    const result = compose(updateProposal(), binding());

    expect(result).toMatchObject({
      version: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
      workspace,
      project,
      repositoryFullName,
      receiptId: "ghop_context_update_973",
      externalId,
      bindingRecordId: deterministicRecordId(
        workspace,
        project,
        "github:delivery:973:accepted",
      ),
      outcome: "ready_for_context_acceptance",
      nextAction: "accept_context",
      authorizesProviderMutation: false,
      authorizesContextAcceptance: false,
      authorizesAuthority: false,
    });
    expect(result.acceptanceSubject).toEqual({
      snapshot: providerSnapshot,
      instructionSet,
      syncStatus: "synchronized",
      syncCursor: null,
      degradedReasonCode: null,
      observationRef: expectedObservationRef(
        workspace,
        result.proposalFingerprint,
      ),
      observedAt: verificationCheckedAt,
      acceptedBy: "actor_lynx",
    });
    expect(result.compositionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.acceptanceSubject)).toBe(true);
    expect(Object.isFrozen(result.acceptanceSubject?.snapshot.labels)).toBe(true);
    expect(Object.isFrozen(result.acceptanceSubject?.instructionSet.sources)).toBe(true);
  });

  test("routes a newly created issue to fresh repository instruction observation", () => {
    const proposal = createProposal(974);
    const result = compose(proposal, null);

    expect(result).toMatchObject({
      workspace,
      externalId: `github:${repositoryFullName}#974`,
      bindingRecordId: null,
      outcome: "requires_repository_instruction_observation",
      nextAction: "observe_repository_instructions",
      acceptanceSubject: null,
    });
  });

  test("uses the same missing-binding fallback for an unobserved existing issue", () => {
    const result = compose(updateProposal(), null);

    expect(result).toMatchObject({
      outcome: "requires_repository_instruction_observation",
      nextAction: "observe_repository_instructions",
      bindingRecordId: null,
      acceptanceSubject: null,
    });
  });

  test("separates attachment generation drift from issue binding drift", () => {
    const attachmentConflict = compose(updateProposal(), binding({
      instructionSet: buildAcceptedRepositoryInstructionSet({
        projectAttachmentId: "attach_other",
        projectAttachmentSnapshotSha256: `sha256:${"c".repeat(64)}`,
        sources: [{
          path: "AGENTS.md",
          revision: "main@other",
          contentSha256: `sha256:${"d".repeat(64)}`,
        }],
      }),
    }));
    expect(attachmentConflict).toMatchObject({
      outcome: "attachment_generation_conflict",
      nextAction: "inspect_attachment_generation",
      acceptanceSubject: null,
    });

    const revisionConflict = compose(updateProposal(), binding({
      snapshot: issueSnapshot(
        issueNumber,
        "github-rest:I_context_973:different",
        "2026-08-02T18:21:00.000Z",
        "Different accepted revision",
      ),
    }));
    expect(revisionConflict).toMatchObject({
      outcome: "binding_identity_conflict",
      nextAction: "inspect_binding_identity",
      acceptanceSubject: null,
    });
  });

  test("rejects workspace, project, repository, and issue substitution", () => {
    const variants = [
      binding({ workspace: "other" }),
      binding({ project: "other" }),
      binding({
        repositoryFullName: "teamleaderleo/other",
        externalId: "github:teamleaderleo/other#973",
        snapshot: issueSnapshot(
          issueNumber,
          previousSnapshot.sourceRevision,
          previousSnapshot.updatedAt,
          previousSnapshot.title,
          "other",
        ),
      }),
      binding({
        externalId: `github:${repositoryFullName}#975`,
        snapshot: issueSnapshot(
          975,
          "github-rest:I_context_975:previous",
          previousSnapshot.updatedAt,
          "Other issue",
        ),
      }),
    ];

    for (const candidate of variants) {
      expect(compose(updateProposal(), candidate)).toMatchObject({
        outcome: "binding_identity_conflict",
        nextAction: "inspect_binding_identity",
        acceptanceSubject: null,
      });
    }
  });

  test("makes ready composition identity workspace-specific", () => {
    const proposal = updateProposal();
    const defaultResult = compose(proposal, binding(), "default");
    const otherResult = compose(
      proposal,
      binding({ workspace: "other" }),
      "other",
    );

    expect(defaultResult.outcome).toBe("ready_for_context_acceptance");
    expect(otherResult.outcome).toBe("ready_for_context_acceptance");
    expect(otherResult.workspace).toBe("other");
    expect(otherResult.compositionFingerprint).not.toBe(
      defaultResult.compositionFingerprint,
    );
    expect(otherResult.acceptanceSubject?.observationRef).not.toBe(
      defaultResult.acceptanceSubject?.observationRef,
    );
  });

  test("rejects forged current binding record identity and stale outcome", () => {
    expect(() => compose(updateProposal(), binding({
      recordId: "github_context_forged",
    }))).toThrow("binding metadata is invalid");

    const stale = binding();
    stale.synchronization.outcome = "stale";
    expect(() => compose(updateProposal(), stale)).toThrow(
      "binding metadata is invalid",
    );
  });

  test("rejects a refingerprinted comment proposal as non-actionable context", () => {
    const proposal = structuredClone(updateProposal()) as GitHubProviderContextReconciliationProposalV1;
    const forged = {
      ...proposal,
      operation: "github_add_issue_comment" as const,
    };
    const refingerprinted = {
      ...forged,
      proposalFingerprint: fingerprintCanonicalRequest(forgedBody(forged)),
    };

    expect(() => compose(refingerprinted, binding())).toThrow(
      "proposal semantics are invalid",
    );
  });

  test("rejects refingerprinted proposal outcome and repository mismatches", () => {
    const reserved = compileGitHubProviderContextReconciliation({
      schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
      receipt: receipt({
        state: "reserved",
        result: null,
        providerRequestId: null,
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
      }),
      current: null,
    });
    const wrongActionBody = {
      ...structuredClone(reserved),
      nextAction: "none" as const,
    };
    const wrongAction = {
      ...wrongActionBody,
      proposalFingerprint: fingerprintCanonicalRequest(
        forgedBody(
          wrongActionBody as GitHubProviderContextReconciliationProposalV1,
        ),
      ),
    };
    expect(() => compose(
      wrongAction as GitHubProviderContextReconciliationProposalV1,
      null,
    )).toThrow("proposal semantics are invalid");

    const actionable = structuredClone(updateProposal());
    const wrongRepositoryBody = {
      ...actionable,
      repositoryFullName: "teamleaderleo/other",
    };
    const wrongRepository = {
      ...wrongRepositoryBody,
      proposalFingerprint: fingerprintCanonicalRequest(
        forgedBody(
          wrongRepositoryBody as GitHubProviderContextReconciliationProposalV1,
        ),
      ),
    };
    expect(() => compose(
      wrongRepository as GitHubProviderContextReconciliationProposalV1,
      null,
    )).toThrow("proposal semantics are invalid");
  });

  test("returns proposal_not_actionable without inspecting an irrelevant binding", () => {
    const proposal = compileGitHubProviderContextReconciliation({
      schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
      receipt: receipt({
        state: "reserved",
        result: null,
        providerRequestId: null,
        verification: {
          state: "not_run",
          checkedAt: null,
          sourceRevision: null,
        },
      }),
      current: {
        externalId,
        sourceRevision: previousSnapshot.sourceRevision,
      },
    });
    let reads = 0;
    const hostileBinding: Record<string, unknown> = {};
    Object.defineProperty(hostileBinding, "project", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("irrelevant binding getter");
      },
    });

    const result = compose(
      proposal,
      hostileBinding as unknown as HostedGitHubIssueContextBindingInputV1,
    );
    expect(result).toMatchObject({
      outcome: "proposal_not_actionable",
      nextAction: "none",
      acceptanceSubject: null,
      bindingRecordId: null,
    });
    expect(reads).toBe(0);
  });

  test("rejects proposal tampering and remains deterministic", () => {
    const proposal = updateProposal();
    const first = compose(proposal, binding());
    const second = compose(structuredClone(proposal), structuredClone(binding()));
    expect(second.compositionFingerprint).toBe(first.compositionFingerprint);
    expect(second.acceptanceSubject).toEqual(first.acceptanceSubject);

    const tampered = structuredClone(proposal) as unknown as Record<string, unknown>;
    tampered.actorId = "actor_other";
    expect(() => compose(
      tampered as unknown as ReturnType<typeof updateProposal>,
      binding(),
    )).toThrow("proposal fingerprint is invalid");
  });
});

function compose(
  proposal: GitHubProviderContextReconciliationProposalV1,
  bindingValue: HostedGitHubIssueContextBindingInputV1 | null,
  workspaceValue = workspace,
) {
  return composeGitHubProviderContextAcceptanceV1({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace: workspaceValue,
    proposal,
    binding: bindingValue,
  });
}

function updateProposal() {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(),
    current: {
      externalId,
      sourceRevision: previousSnapshot.sourceRevision,
    },
  });
}

function createProposal(number: number) {
  const snapshot = issueSnapshot(
    number,
    `github-rest:I_context_${number}:created`,
    verificationCheckedAt,
    "Created issue",
  );
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt({
      id: `ghop_context_create_${number}`,
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
      idempotencyKey: `context-create-${number}`,
      result: snapshot,
      verification: {
        state: "passed",
        checkedAt: verificationCheckedAt,
        sourceRevision: snapshot.sourceRevision,
      },
    }),
    current: null,
  });
}

function binding(
  overrides: Partial<HostedGitHubIssueContextBindingInputV1> = {},
): HostedGitHubIssueContextBindingInputV1 {
  const value: HostedGitHubIssueContextBindingInputV1 = {
    version: 1,
    workspace,
    recordId: "",
    project,
    externalId,
    repositoryFullName,
    snapshot: previousSnapshot,
    instructionSet,
    synchronization: {
      status: "synchronized",
      cursor: "github:cursor:973",
      degradedReasonCode: null,
      observationRef: "github:delivery:973:accepted",
      observedAt: "2026-08-02T18:21:00.000Z",
      acceptedBy: "actor_previous",
      acceptedAt: "2026-08-02T18:21:01.000Z",
      outcome: "initial",
      isCurrent: true,
    },
    ...overrides,
  };
  if (overrides.recordId === undefined) {
    value.recordId = deterministicRecordId(
      value.workspace,
      value.project,
      value.synchronization.observationRef,
    );
  }
  return value;
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_context_update_973",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#${issueNumber}`,
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_context",
    installationId: "installation_context",
    bindingId: "ghbind_context",
    attachmentId,
    attachmentSnapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "context-update-973",
    parametersSha256: `sha256:${"e".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T18:29:55.000Z",
    updatedAt: verificationCheckedAt,
    providerRequestId: "request-context-973",
    result: providerSnapshot,
    verification: {
      state: "passed",
      checkedAt: verificationCheckedAt,
      sourceRevision: providerSnapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
    ...overrides,
  };
}

function issueSnapshot(
  number: number,
  sourceRevision: string,
  updatedAt: string,
  title: string,
  repository = "stensibly",
): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository,
    number,
    title,
    body: null,
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T18:00:00.000Z",
    updatedAt,
    providerNodeId: `I_context_${number}`,
    sourceRevision,
  });
}

function expectedObservationRef(
  workspaceValue: string,
  proposalFingerprint: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace: workspaceValue,
    proposalFingerprint,
  });
  return `github:provider-reconciliation:${digest.slice("sha256:".length)}`;
}

function deterministicRecordId(
  workspaceValue: string,
  projectValue: string,
  observationRef: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace: workspaceValue,
    project: projectValue,
    observationRef,
  });
  return `github_context_${digest.slice("sha256:".length)}`;
}

function forgedBody(
  proposal: GitHubProviderContextReconciliationProposalV1,
) {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}
