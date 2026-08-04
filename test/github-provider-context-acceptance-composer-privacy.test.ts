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
import { buildAcceptedRepositoryInstructionSet } from "../src/github-project-context-admission.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const externalId = `github:${repositoryFullName}#973`;
const observedAt = "2026-08-03T10:00:00.000Z";
const previousRevision = "github-rest:I_acceptance_privacy:previous";
const providerRevision = "github-rest:I_acceptance_privacy:provider";
const credentialRepository =
  `teamleaderleo/projectxgithub_pat_${"a".repeat(20)}`;

describe("GitHub provider context acceptance retained identity privacy", () => {
  test("rejects embedded credentials in proposal identities before binding access", () => {
    const credential = `github_pat_${"a".repeat(20)}`;
    const variants: Array<[
      Partial<GitHubProviderContextReconciliationProposalV1>,
      string,
    ]> = [
      [{ project: `projectx${credential}` }, `projectx${credential}`],
      [{ actorId: `actorxsk-proj-${"a".repeat(20)}` }, `actorxsk-proj-${"a".repeat(20)}`],
      [{ attachmentId: `attachxstn.tok_${"a".repeat(20)}` }, `attachxstn.tok_${"a".repeat(20)}`],
      [{ currentSourceRevision: `revisionxoxb-${"a".repeat(16)}` }, `revisionxoxb-${"a".repeat(16)}`],
      [{ repositoryFullName: credentialRepository }, credentialRepository],
    ];

    for (const [overrides, rejectedText] of variants) {
      const forged = refingerprint(updateProposal(), overrides);
      let bindingReads = 0;
      const hostileBinding: Record<string, unknown> = {};
      Object.defineProperty(hostileBinding, "project", {
        enumerable: true,
        get() {
          bindingReads += 1;
          throw new Error("binding must not be inspected");
        },
      });
      expectFixedRejection(
        () => compose(
          forged,
          hostileBinding as unknown as HostedGitHubIssueContextBindingInputV1,
        ),
        rejectedText,
      );
      expect(bindingReads).toBe(0);
    }
  });

  test("rejects credential-shaped and foreign proposal external IDs", () => {
    const credentialExternalId =
      `github:teamleaderleo/projectxgithub_pat_${"a".repeat(20)}#973`;
    const foreignExternalId = "github:example/project#973";

    expectFixedRejection(
      () => compose(
        refingerprint(updateProposal(), { externalId: credentialExternalId }),
        null,
      ),
      credentialExternalId,
    );
    expectFixedRejection(
      () => compose(
        refingerprint(updateProposal(), { externalId: foreignExternalId }),
        null,
      ),
      foreignExternalId,
      "GitHub context acceptance external ID is outside the bound repository",
    );
  });

  test("rejects embedded credentials and foreign external IDs in bindings", () => {
    const credentialWorkspace =
      `workspacexgithub_pat_${"a".repeat(20)}`;
    const credentialActor = `actorxsk-${"a".repeat(20)}`;
    const credentialExternalId =
      `github:teamleaderleo/projectxgithub_pat_${"a".repeat(20)}#973`;
    const foreignExternalId = "github:example/project#973";

    expectFixedRejection(
      () => compose(updateProposal(), binding({ workspace: credentialWorkspace })),
      credentialWorkspace,
    );

    const actorBinding = binding();
    actorBinding.synchronization.acceptedBy = credentialActor;
    expectFixedRejection(
      () => compose(updateProposal(), actorBinding),
      credentialActor,
    );

    expectFixedRejection(
      () => compose(updateProposal(), binding({ externalId: credentialExternalId })),
      credentialExternalId,
    );
    expectFixedRejection(
      () => compose(updateProposal(), binding({ externalId: foreignExternalId })),
      foreignExternalId,
      "GitHub context acceptance external ID is outside the bound repository",
    );
    expectFixedRejection(
      () => compose(updateProposal(), binding({
        repositoryFullName: credentialRepository,
        externalId: `github:${credentialRepository}#973`,
      })),
      credentialRepository,
    );
  });

  test("preserves benign short token-like aliases", () => {
    const result = compose(
      refingerprint(createProposal(), {
        project: "github_pat_demo",
        actorId: "sk-demo",
      }),
      null,
      "xoxb_demo",
    );

    expect(result).toMatchObject({
      workspace: "xoxb_demo",
      project: "github_pat_demo",
      outcome: "requires_repository_instruction_observation",
      nextAction: "observe_repository_instructions",
      authorizesProviderMutation: false,
      authorizesContextAcceptance: false,
      authorizesAuthority: false,
    });
  });
});

function compose(
  proposal: GitHubProviderContextReconciliationProposalV1,
  bindingValue: HostedGitHubIssueContextBindingInputV1 | null,
  workspace = "default",
) {
  return composeGitHubProviderContextAcceptanceV1({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace,
    proposal,
    binding: bindingValue,
  });
}

function updateProposal(): GitHubProviderContextReconciliationProposalV1 {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(),
    current: {
      externalId,
      sourceRevision: previousRevision,
    },
  });
}

function createProposal(): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot(974, providerRevision);
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt({
      id: "ghop_acceptance_privacy_create",
      operation: "github_create_issue",
      target: `${repositoryFullName}#new`,
      idempotencyKey: "acceptance-privacy-create",
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

function binding(
  overrides: Partial<HostedGitHubIssueContextBindingInputV1> = {},
): HostedGitHubIssueContextBindingInputV1 {
  const observationRef = "github:delivery:acceptance-privacy";
  const workspace = overrides.workspace ?? "default";
  const project = overrides.project ?? "stensibly";
  return {
    version: 1,
    workspace,
    recordId: deterministicRecordId(workspace, project, observationRef),
    project,
    externalId,
    repositoryFullName,
    snapshot: issueSnapshot(973, previousRevision),
    instructionSet: buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_acceptance_privacy",
      projectAttachmentSnapshotSha256: hash("a"),
      sources: [{
        path: "AGENTS.md",
        revision: "main@accepted",
        contentSha256: hash("b"),
      }],
    }),
    synchronization: {
      status: "synchronized",
      cursor: "github:cursor:acceptance-privacy",
      degradedReasonCode: null,
      observationRef,
      observedAt: "2026-08-03T09:50:00.000Z",
      acceptedBy: "actor_previous",
      acceptedAt: "2026-08-03T09:50:01.000Z",
      outcome: "initial",
      isCurrent: true,
    },
    ...overrides,
  };
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const snapshot = issueSnapshot(973, providerRevision);
  return {
    version: 1,
    id: "ghop_acceptance_privacy_update",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#973`,
    actorId: "actor_lumen",
    clientId: "client_github_only",
    connectionId: "ghconn_acceptance_privacy",
    installationId: "installation_acceptance_privacy",
    bindingId: "ghbind_acceptance_privacy",
    attachmentId: "attach_acceptance_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "acceptance-privacy-update",
    parametersSha256: hash("c"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:59:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-ACCEPTANCE-PRIVACY",
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
    title: `Acceptance privacy ${number}`,
    body: null,
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:45:00.000Z",
    updatedAt: observedAt,
    providerNodeId: `I_acceptance_privacy_${number}`,
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
): Omit<GitHubProviderContextReconciliationProposalV1, "proposalFingerprint"> {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}

function deterministicRecordId(
  workspace: string,
  project: string,
  observationRef: string,
): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace,
    project,
    observationRef,
  });
  return `github_context_${digest.slice("sha256:".length)}`;
}

function expectFixedRejection(
  run: () => unknown,
  rejectedText: string,
  expectedMessage?: string,
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  if (expectedMessage !== undefined) {
    expect((thrown as Error).message).toBe(expectedMessage);
  }
  expect((thrown as Error).message).not.toContain(rejectedText);
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
