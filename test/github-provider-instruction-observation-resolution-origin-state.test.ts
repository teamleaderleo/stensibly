import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
  type GitHubProviderContextReconciliationProposalV1,
} from "../src/github-provider-context-reconciliation.ts";
import {
  compileGitHubProviderInstructionObservationRequestV1 as compileRequestBase,
} from "../src/github-provider-instruction-observation-request-base.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
  type GitHubProviderInstructionObservationRequestV1,
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
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const attachmentId = "attach_origin_state";
const providerObservedAt = "2026-08-03T09:30:00.000Z";
const instructionObservedAt = "2026-08-03T09:31:00.000Z";
const requestOriginDiagnostic =
  "GitHub provider instruction observation request does not match reconciliation proposal";

describe("GitHub instruction resolution stateless origin admission", () => {
  test("does not turn public compilation into hidden proposal-less origin authority", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const input = requestInput(proposal);
    const canonical = compileRequestBase(input);

    expect(compileGitHubProviderInstructionObservationRequestV1(input)).toEqual(
      canonical,
    );

    expect(() => resolve({
      request: canonical,
      attachment,
      observation: observation(attachment),
    })).toThrow(requestOriginDiagnostic);

    expect(resolve({
      proposal,
      request: canonical,
      attachment,
      observation: observation(attachment),
    })).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      requestFingerprint: canonical.requestFingerprint,
    });
  });

  test("snapshots nested request evidence once before origin and base admission", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const canonical = compileRequestBase(requestInput(proposal));
    const later = refingerprintedRequest(canonical, {
      providerObservedAt: "2026-08-03T09:32:00.000Z",
    });
    const alternating = alternatingRequest(canonical, later);

    const result = resolve({
      proposal,
      request: alternating.value,
      attachment,
      observation: observation(attachment),
    });

    expect(result).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      nextAction: "compose_context_acceptance",
      requestFingerprint: canonical.requestFingerprint,
      instructionObservedAt,
    });
    expect(alternating.snapshots()).toBeGreaterThanOrEqual(2);
  });
});

function resolve(input: {
  proposal?: GitHubProviderContextReconciliationProposalV1;
  request: GitHubProviderInstructionObservationRequestV1;
  attachment: unknown;
  observation: unknown;
}) {
  return resolveGitHubProviderInstructionObservationV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    ...input,
  });
}

function requestInput(
  proposal: GitHubProviderContextReconciliationProposalV1,
) {
  return {
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  };
}

function refingerprintedRequest(
  request: GitHubProviderInstructionObservationRequestV1,
  changes: Partial<GitHubProviderInstructionObservationRequestV1>,
): GitHubProviderInstructionObservationRequestV1 {
  const body = structuredClone(request) as unknown as Record<string, unknown>;
  delete body.requestFingerprint;
  Object.assign(body, changes);
  return {
    ...body,
    requestFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as GitHubProviderInstructionObservationRequestV1;
}

function alternatingRequest(
  first: GitHubProviderInstructionObservationRequestV1,
  later: GitHubProviderInstructionObservationRequestV1,
) {
  let active: object = first;
  let snapshotCount = 0;
  const value = new Proxy({}, {
    getPrototypeOf() {
      return Object.prototype;
    },
    ownKeys() {
      active = snapshotCount === 0 ? first : later;
      snapshotCount += 1;
      return Reflect.ownKeys(active);
    },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Object.getOwnPropertyDescriptor(active, key);
      if (!descriptor) return undefined;
      return {
        value: descriptor.value,
        writable: true,
        enumerable: descriptor.enumerable,
        configurable: true,
      };
    },
  }) as unknown as GitHubProviderInstructionObservationRequestV1;
  return { value, snapshots: () => snapshotCount };
}

function reconciliationProposal(
  attachment: ProjectAttachmentRecord,
): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(attachment, snapshot),
    current: null,
  });
}

function receipt(
  attachment: ProjectAttachmentRecord,
  snapshot: GitHubIssueContext,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_origin_state",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_lark",
    clientId: "client_github_only",
    connectionId: "ghconn_origin_state",
    installationId: "installation_origin_state",
    bindingId: "ghbind_origin_state",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-origin-state",
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-origin-state-provider",
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
    number: 1006,
    title: "Stateless origin control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_origin_state",
    sourceRevision: "github-rest:I_origin_state:provider",
  });
}

function attachmentRecord(): ProjectAttachmentRecord {
  const snapshot = attachmentSnapshot();
  return {
    id: attachmentId,
    project,
    snapshot,
    sourceRevision: "main@accepted",
    acceptedBy: "actor_human",
    authorityWidening: false,
    acceptedAt: "2026-08-03T09:00:00.000Z",
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

function observation(attachment: ProjectAttachmentRecord) {
  return {
    observedAt: instructionObservedAt,
    observedBy: "actor_observer",
    sources: [
      source(
        attachment.snapshot.source.path,
        attachment.sourceRevision,
        attachment.snapshot.source.contentSha256,
      ),
      source("AGENTS.md", "main@agents", hash("b")),
    ],
  };
}

function source(path: string, revision: string, contentSha256: string) {
  return { path, revision, contentSha256 };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
