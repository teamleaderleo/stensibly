import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
} from "../src/github-provider-context-reconciliation.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
  resolveGitHubProviderInstructionObservationV1,
} from "../src/github-provider-instruction-observation-resolution.ts";
import {
  compileProjectContract,
  renderProjectContract,
  type ProjectAttachmentSnapshot,
} from "../src/project-contract.ts";
import type { ProjectAttachmentRecord } from "../src/project-attachment-ledger.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const providerObservedAt = "2026-08-05T12:00:00.000Z";
const instructionObservedAt = "2026-08-05T12:01:00.000Z";
const diagnostic =
  "GitHub provider instruction observation resolution contains credential-shaped identity";

describe("GitHub instruction resolution retained credential policy", () => {
  test("rejects final retained credential families before returning a resolution", () => {
    const cases: Array<(input: ReturnType<typeof validInput>) => void> = [
      (input) => {
        input.observation.observedBy = "stn.svc_abcdefghijkl";
      },
      (input) => {
        input.observation.sources[1]!.path =
          "docs/stn.tok_abcdefghijkl.md";
      },
      (input) => {
        input.observation.sources[1]!.revision =
          "stn.svc_abcdefghijkl";
      },
      (input) => {
        input.observation.sources[1]!.revision = "authorization:token";
      },
    ];

    for (const mutate of cases) {
      const input = validInput();
      mutate(input);
      expect(() => resolveGitHubProviderInstructionObservationV1(input))
        .toThrow(diagnostic);
    }
  });

  test("preserves benign short Stensibly-like aliases", () => {
    const input = validInput();
    input.observation.observedBy = "stn.svc_short";
    input.observation.sources[1]!.path = "docs/stn.svc_short.md";
    input.observation.sources[1]!.revision = "stn.svc_short";

    expect(resolveGitHubProviderInstructionObservationV1(input)).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      observedBy: "stn.svc_short",
      instructionSet: {
        sources: expect.arrayContaining([
          expect.objectContaining({
            path: "docs/stn.svc_short.md",
            revision: "stn.svc_short",
          }),
        ]),
      },
    });
  });
});

function validInput() {
  const attachment = attachmentRecord();
  const proposal = compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(attachment),
    current: null,
  });
  const request = compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  });
  return {
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    proposal,
    request,
    attachment,
    observation: {
      observedAt: instructionObservedAt,
      observedBy: "actor_observer",
      sources: [
        {
          path: attachment.snapshot.source.path,
          revision: attachment.sourceRevision,
          contentSha256: attachment.snapshot.source.contentSha256,
        },
        {
          path: "AGENTS.md",
          revision: "main@agents",
          contentSha256: hash("b"),
        },
      ],
    },
  };
}

function receipt(attachment: ProjectAttachmentRecord): GitHubProviderReceipt {
  const snapshot = issueSnapshot();
  return {
    version: 1,
    id: "ghop_retained_policy",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_juniper",
    clientId: "client_github_only",
    connectionId: "ghconn_retained_policy",
    installationId: "installation_retained_policy",
    bindingId: "ghbind_retained_policy",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-retained-policy",
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-05T11:59:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-retained-policy-provider",
    result: snapshot,
    verification: {
      state: "passed",
      checkedAt: providerObservedAt,
      sourceRevision: snapshot.sourceRevision,
    },
    error: null,
    recovery: { nextAction: "none" },
  };
}

function issueSnapshot(): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 1013,
    title: "Retained credential policy",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-05T11:30:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_retained_policy",
    sourceRevision: "github-rest:I_retained_policy:provider",
  });
}

function attachmentRecord(): ProjectAttachmentRecord {
  const snapshot = attachmentSnapshot();
  return {
    id: "attach_retained_policy",
    project,
    snapshot,
    sourceRevision: "main@accepted",
    acceptedBy: "actor_human",
    authorityWidening: false,
    acceptedAt: "2026-08-05T11:00:00.000Z",
  };
}

function attachmentSnapshot(): ProjectAttachmentSnapshot {
  return compileProjectContract(renderProjectContract({
    version: 1,
    project,
    repositories: [repositoryFullName],
    runnerProfiles: ["chatgpt"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect"],
    approvalRequired: ["merge"],
    checks: ["typecheck"],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Private attachment goal prose",
    boundaries: "Private attachment boundary prose",
    evidenceAndHandoff: "Private attachment evidence prose",
    escalation: "Private attachment escalation prose",
  }));
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
