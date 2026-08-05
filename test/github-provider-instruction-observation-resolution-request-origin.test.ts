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
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const attachmentId = "attach_request_origin";
const providerObservedAt = "2026-08-03T09:30:00.000Z";
const requestMismatchDiagnostic =
  "GitHub provider instruction observation request does not match reconciliation proposal";

describe("GitHub instruction resolution canonical request origin", () => {
  test("admits the exact request rebuilt from the supplied reconciliation proposal", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const request = requestFromProposal(proposal);

    const result = resolve(proposal, request, attachment, observation(attachment));

    expect(result).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      nextAction: "compose_context_acceptance",
      requestId: request.requestId,
      observationRef: request.observationRef,
      proposalFingerprint: proposal.proposalFingerprint,
    });
  });

  test("rejects a self-consistent actor substitution before attachment access", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const request = refingerprintedRequest(requestFromProposal(proposal), {
      actorId: "actor_other",
    });
    const hostile = hostileInput();

    expect(() => resolve(proposal, request, hostile.value, hostile.value)).toThrow(
      requestMismatchDiagnostic,
    );
    expect(hostile.reads()).toBe(0);
  });

  test("rejects a self-consistent provider chronology substitution before attachment access", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const request = refingerprintedRequest(requestFromProposal(proposal), {
      providerObservedAt: "2026-08-03T09:30:30.000Z",
    });
    const hostile = hostileInput();

    expect(() => resolve(proposal, request, hostile.value, hostile.value)).toThrow(
      requestMismatchDiagnostic,
    );
    expect(hostile.reads()).toBe(0);
  });

  test("rejects a request paired with a different admitted proposal", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const otherProposal = refingerprintedProposal(proposal, {
      actorId: "actor_other",
    });
    const request = requestFromProposal(proposal);
    const hostile = hostileInput();

    expect(() => resolve(otherProposal, request, hostile.value, hostile.value)).toThrow(
      requestMismatchDiagnostic,
    );
    expect(hostile.reads()).toBe(0);
  });
});

function resolve(
  proposal: GitHubProviderContextReconciliationProposalV1,
  request: ReturnType<typeof requestFromProposal>,
  attachment: unknown,
  observed: unknown,
) {
  type CurrentInput = Parameters<
    typeof resolveGitHubProviderInstructionObservationV1
  >[0];
  const input = {
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    proposal,
    request,
    attachment,
    observation: observed,
  };
  return resolveGitHubProviderInstructionObservationV1(
    input as unknown as CurrentInput,
  );
}

function requestFromProposal(
  proposal: GitHubProviderContextReconciliationProposalV1,
) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  });
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

function refingerprintedRequest(
  request: ReturnType<typeof requestFromProposal>,
  changes: Partial<ReturnType<typeof requestFromProposal>>,
): ReturnType<typeof requestFromProposal> {
  const body = structuredClone(request) as unknown as Record<string, unknown>;
  delete body.requestFingerprint;
  Object.assign(body, changes);
  return {
    ...body,
    requestFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as ReturnType<typeof requestFromProposal>;
}

function refingerprintedProposal(
  proposal: GitHubProviderContextReconciliationProposalV1,
  changes: Partial<GitHubProviderContextReconciliationProposalV1>,
): GitHubProviderContextReconciliationProposalV1 {
  const body = structuredClone(proposal) as unknown as Record<string, unknown>;
  delete body.proposalFingerprint;
  Object.assign(body, changes);
  return {
    ...body,
    proposalFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as GitHubProviderContextReconciliationProposalV1;
}

function receipt(
  attachment: ProjectAttachmentRecord,
  snapshot: GitHubIssueContext,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_request_origin",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_request_origin",
    installationId: "installation_request_origin",
    bindingId: "ghbind_request_origin",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "request-origin",
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-origin-provider",
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
    title: "Canonical request origin control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_request_origin",
    sourceRevision: "github-rest:I_request_origin:provider",
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
    observedAt: "2026-08-03T09:31:00.000Z",
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

function hostileInput() {
  let readCount = 0;
  const value: Record<string, unknown> = {};
  Object.defineProperty(value, "id", {
    enumerable: true,
    get() {
      readCount += 1;
      throw new Error("hostile input getter");
    },
  });
  return { value, reads: () => readCount };
}

function source(path: string, revision: string, contentSha256: string) {
  return { path, revision, contentSha256 };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
