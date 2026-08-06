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
} from "../src/github-provider-context-reconciliation.ts";
import { buildAcceptedRepositoryInstructionSet } from "../src/github-project-context-admission.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const repositoryFullName = "teamleaderleo/stensibly";
const externalId = `github:${repositoryFullName}#975`;
const observedAt = "2026-08-05T13:00:00.000Z";
const previousRevision = "github-rest:I_instruction_privacy:previous";
const providerRevision = "github-rest:I_instruction_privacy:provider";
const diagnostic =
  "Hosted GitHub issue context instruction set contains credential-shaped identity";

describe("GitHub context acceptance instruction-set final privacy", () => {
  test("rejects final-policy source paths and revisions before acceptance composition", () => {
    const cases = [
      {
        path: `docs/stn.tok_${"a".repeat(12)}.md`,
        revision: "main@accepted",
      },
      {
        path: `docs/stn.svc_${"b".repeat(12)}.md`,
        revision: "main@accepted",
      },
      {
        path: "AGENTS.md",
        revision: `stn.svc_${"c".repeat(12)}`,
      },
      {
        path: "AGENTS.md",
        revision: "authorization:token",
      },
    ];

    for (const source of cases) {
      const candidate = binding(source.path, source.revision);
      expectFixedRejection(
        () => compose(candidate),
        [source.path, source.revision],
      );
    }
  });

  test("preserves benign short Stensibly-like source identities", () => {
    const candidate = binding(
      "docs/stn.svc_short.md",
      "stn.svc_short",
    );

    expect(compose(candidate)).toMatchObject({
      outcome: "ready_for_context_acceptance",
      nextAction: "accept_context",
      bindingRecordId: candidate.recordId,
      acceptanceSubject: {
        instructionSet: {
          sources: expect.arrayContaining([
            expect.objectContaining({
              path: "docs/stn.svc_short.md",
              revision: "stn.svc_short",
            }),
          ]),
        },
      },
      authorizesProviderMutation: false,
      authorizesContextAcceptance: false,
      authorizesAuthority: false,
    });
  });
});

function compose(bindingValue: HostedGitHubIssueContextBindingInputV1) {
  return composeGitHubProviderContextAcceptanceV1({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_ACCEPTANCE_COMPOSER_V1,
    workspace: "default",
    proposal: proposal(),
    binding: bindingValue,
  });
}

function proposal() {
  const snapshot = issueSnapshot(975, providerRevision);
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId,
      sourceRevision: previousRevision,
    },
  });
}

function binding(
  sourcePath: string,
  sourceRevision: string,
): HostedGitHubIssueContextBindingInputV1 {
  const workspace = "default";
  const project = "stensibly";
  const observationRef = "github:delivery:instruction-final-privacy";
  return {
    version: 1,
    workspace,
    recordId: deterministicRecordId(workspace, project, observationRef),
    project,
    externalId,
    repositoryFullName,
    snapshot: issueSnapshot(975, previousRevision),
    instructionSet: buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_instruction_final_privacy",
      projectAttachmentSnapshotSha256: hash("a"),
      sources: [{
        path: sourcePath,
        revision: sourceRevision,
        contentSha256: hash("b"),
      }],
    }),
    synchronization: {
      status: "synchronized",
      cursor: "github:cursor:instruction-final-privacy",
      degradedReasonCode: null,
      observationRef,
      observedAt: "2026-08-05T12:50:00.000Z",
      acceptedBy: "actor_previous",
      acceptedAt: "2026-08-05T12:50:01.000Z",
      outcome: "initial",
      isCurrent: true,
    },
  };
}

function receipt(snapshot: GitHubIssueContext): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_instruction_final_privacy",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#975`,
    actorId: "actor_juniper",
    clientId: "client_github_only",
    connectionId: "ghconn_instruction_final_privacy",
    installationId: "installation_instruction_final_privacy",
    bindingId: "ghbind_instruction_final_privacy",
    attachmentId: "attach_instruction_final_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-final-privacy",
    parametersSha256: hash("c"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-05T12:59:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-INSTRUCTION-FINAL-PRIVACY",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: observedAt,
      sourceRevision: snapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function issueSnapshot(number: number, sourceRevision: string): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number,
    title: "Instruction-set final privacy",
    body: null,
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-05T12:30:00.000Z",
    updatedAt: observedAt,
    providerNodeId: `I_instruction_final_privacy_${number}`,
    sourceRevision,
  });
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
  rejectedValues: readonly string[],
): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).toBe(diagnostic);
  for (const rejectedValue of rejectedValues) {
    expect((thrown as Error).message).not.toContain(rejectedValue);
    expect(JSON.stringify(thrown)).not.toContain(rejectedValue);
  }
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
