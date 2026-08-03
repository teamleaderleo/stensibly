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
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const attachmentId = "attach_resolution_request_identity";
const providerObservedAt = "2026-08-03T09:30:00.000Z";
const instructionObservedAt = "2026-08-03T09:31:00.000Z";

describe("GitHub instruction resolution request identity", () => {
  test("retains the exact admitted request fingerprint", () => {
    const attachment = attachmentRecord();
    const request = observationRequest(attachment);
    const result = resolve(request, attachment);

    expect(result).toHaveProperty(
      "requestFingerprint",
      request.requestFingerprint,
    );
  });

  test("separates refingerprinted actor substitutions", () => {
    const attachment = attachmentRecord();
    const request = observationRequest(attachment);
    const altered = refingerprintedRequest(request, {
      actorId: "actor_other",
    });

    const first = resolve(request, attachment);
    const second = resolve(altered, attachment);

    expect(altered.requestId).toBe(request.requestId);
    expect(altered.observationRef).toBe(request.observationRef);
    expect(altered.proposalFingerprint).toBe(request.proposalFingerprint);
    expect(altered.requestFingerprint).not.toBe(request.requestFingerprint);
    expect(second.resolutionFingerprint).not.toBe(first.resolutionFingerprint);
  });

  test("separates refingerprinted provider chronology substitutions", () => {
    const attachment = attachmentRecord();
    const request = observationRequest(attachment);
    const altered = refingerprintedRequest(request, {
      providerObservedAt: "2026-08-03T09:30:30.000Z",
    });

    const first = resolve(request, attachment);
    const second = resolve(altered, attachment);

    expect(altered.requestId).toBe(request.requestId);
    expect(altered.observationRef).toBe(request.observationRef);
    expect(altered.proposalFingerprint).toBe(request.proposalFingerprint);
    expect(altered.requestFingerprint).not.toBe(request.requestFingerprint);
    expect(second.resolutionFingerprint).not.toBe(first.resolutionFingerprint);
  });

  test("remains deterministic for the identical request", () => {
    const attachment = attachmentRecord();
    const request = observationRequest(attachment);
    const first = resolve(request, attachment);
    const second = resolve(
      structuredClone(request),
      structuredClone(attachment),
    );

    expect(second).toEqual(first);
  });
});

function resolve(
  request: ReturnType<typeof observationRequest>,
  attachment: ProjectAttachmentRecord,
) {
  return resolveGitHubProviderInstructionObservationV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    request,
    attachment,
    observation: {
      observedAt: instructionObservedAt,
      observedBy: "actor_observer",
      sources: [
        attachmentSource(attachment),
        source("AGENTS.md", "main@agents", hash("b")),
      ],
    },
  });
}

function refingerprintedRequest(
  request: ReturnType<typeof observationRequest>,
  changes: Partial<ReturnType<typeof observationRequest>>,
): ReturnType<typeof observationRequest> {
  const body = structuredClone(request) as unknown as Record<string, unknown>;
  delete body.requestFingerprint;
  Object.assign(body, changes);
  return {
    ...body,
    requestFingerprint: fingerprintCanonicalRequest(body),
  } as unknown as ReturnType<typeof observationRequest>;
}

function observationRequest(attachment: ProjectAttachmentRecord) {
  const snapshot = issueSnapshot();
  const proposal = compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(attachment, snapshot),
    current: null,
  });
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  });
}

function receipt(
  attachment: ProjectAttachmentRecord,
  snapshot: GitHubIssueContext,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_resolution_request_identity",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_resolution_request_identity",
    installationId: "installation_resolution_request_identity",
    bindingId: "ghbind_resolution_request_identity",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "resolution-request-identity",
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-resolution-identity",
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
    title: "Resolution request identity control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_resolution_request_identity",
    sourceRevision: "github-rest:I_resolution_request_identity:provider",
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

function attachmentSource(attachment: ProjectAttachmentRecord) {
  return source(
    attachment.snapshot.source.path,
    attachment.sourceRevision,
    attachment.snapshot.source.contentSha256,
  );
}

function source(path: string, revision: string, contentSha256: string) {
  return { path, revision, contentSha256 };
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
