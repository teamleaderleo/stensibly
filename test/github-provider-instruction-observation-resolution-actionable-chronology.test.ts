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
const attachmentId = "attach_actionable_chronology";
const providerObservedAt = "2026-08-03T09:30:00.000Z";
const previousRevision = "github-rest:I_actionable_chronology:previous";
const providerRevision = "github-rest:I_actionable_chronology:provider";

describe("GitHub instruction resolution actionable request chronology", () => {
  test("rejects create requests carrying a prior accepted revision before attachment access", () => {
    const attachment = attachmentRecord();
    const forged = refingerprintedRequest(
      observationRequest("github_create_issue", attachment),
      { previousSourceRevision: previousRevision },
    );
    const hostile = hostileInput();

    expect(() => resolveRaw(forged, hostile.value, hostile.value)).toThrow(
      "GitHub provider instruction observation request chronology is invalid",
    );
    expect(hostile.reads()).toBe(0);
  });

  test("rejects update requests whose prior revision already equals provider readback before attachment access", () => {
    const attachment = attachmentRecord();
    const forged = refingerprintedRequest(
      observationRequest("github_update_issue", attachment),
      { previousSourceRevision: providerRevision },
    );
    const hostile = hostileInput();

    expect(() => resolveRaw(forged, hostile.value, hostile.value)).toThrow(
      "GitHub provider instruction observation request chronology is invalid",
    );
    expect(hostile.reads()).toBe(0);
  });

  test("preserves canonical create and update chronology", () => {
    const attachment = attachmentRecord();

    const created = resolve(
      observationRequest("github_create_issue", attachment),
      attachment,
    );
    expect(created.outcome).toBe("ready_for_context_acceptance_binding");

    const updated = resolve(
      observationRequest("github_update_issue", attachment),
      attachment,
    );
    expect(updated.outcome).toBe("ready_for_context_acceptance_binding");
  });
});

function resolve(
  request: ReturnType<typeof observationRequest>,
  attachment: ProjectAttachmentRecord,
) {
  return resolveRaw(request, attachment, observation(attachment));
}

function resolveRaw(
  request: ReturnType<typeof observationRequest>,
  attachment: unknown,
  observed: unknown,
) {
  return resolveGitHubProviderInstructionObservationV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_RESOLUTION_V1,
    request,
    attachment,
    observation: observed as ReturnType<typeof observation>,
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

function observationRequest(
  operation: "github_create_issue" | "github_update_issue",
  attachment: ProjectAttachmentRecord,
) {
  const snapshot = issueSnapshot();
  const proposal = compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(operation, attachment, snapshot),
    current: operation === "github_create_issue"
      ? null
      : {
        externalId: snapshot.reference.externalId,
        sourceRevision: previousRevision,
      },
  });
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace,
    proposal,
  });
}

function receipt(
  operation: "github_create_issue" | "github_update_issue",
  attachment: ProjectAttachmentRecord,
  snapshot: GitHubIssueContext,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: `ghop_actionable_chronology_${operation}`,
    project,
    provider: "github",
    repositoryFullName,
    operation,
    target: operation === "github_create_issue"
      ? `${repositoryFullName}#new`
      : `${repositoryFullName}#1006`,
    actorId: "actor_morrow",
    clientId: "client_github_only",
    connectionId: "ghconn_actionable_chronology",
    installationId: "installation_actionable_chronology",
    bindingId: "ghbind_actionable_chronology",
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: `actionable-chronology-${operation}`,
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: "request-actionable-chronology",
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
    title: "Actionable chronology control",
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: providerObservedAt,
    providerNodeId: "I_actionable_chronology",
    sourceRevision: providerRevision,
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
