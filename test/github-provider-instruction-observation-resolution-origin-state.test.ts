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

  test("does not let registry pressure alter proposal-less resolution", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const canonical = compileRequestBase(requestInput(proposal));

    compileGitHubProviderInstructionObservationRequestV1(
      requestInput(proposal),
    );
    expect(proposalLessDisposition(canonical, attachment)).toBe("rejected");

    for (let index = 0; index < 257; index += 1) {
      compileGitHubProviderInstructionObservationRequestV1({
        schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
        workspace: `workspace_${index}`,
        proposal,
      });
    }

    expect(proposalLessDisposition(canonical, attachment)).toBe("rejected");
  });

  test("a rejected mismatch cannot change a later valid resolution", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const otherProposal = reconciliationProposal(
      attachment,
      "other",
      "actor_other",
    );
    const canonical = compileRequestBase(requestInput(proposal));

    expect(() => resolve({
      proposal: otherProposal,
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

  test("snapshots nested request evidence exactly once", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const canonical = compileRequestBase(requestInput(proposal));
    const later = refingerprintedRequest(canonical, {
      providerObservedAt: "2026-08-03T09:32:00.000Z",
    });
    const alternating = alternatingRecord(canonical, later);

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
    expectSingleSnapshot(alternating, canonical);
  });

  test("snapshots accepted attachment evidence exactly once", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const canonical = compileRequestBase(requestInput(proposal));
    const later = {
      ...structuredClone(attachment),
      acceptedAt: "2026-08-03T09:32:00.000Z",
    };
    const alternating = alternatingRecord(attachment, later);

    const result = resolve({
      proposal,
      request: canonical,
      attachment: alternating.value,
      observation: observation(attachment),
    });

    expect(result).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      nextAction: "compose_context_acceptance",
      requestFingerprint: canonical.requestFingerprint,
      instructionObservedAt,
    });
    expectSingleSnapshot(alternating, attachment);
  });

  test("snapshots instruction observation evidence exactly once", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const canonical = compileRequestBase(requestInput(proposal));
    const canonicalObservation = observation(attachment);
    const later = {
      ...structuredClone(canonicalObservation),
      observedAt: "2026-08-03T08:59:00.000Z",
    };
    const alternating = alternatingRecord(canonicalObservation, later);

    const result = resolve({
      proposal,
      request: canonical,
      attachment,
      observation: alternating.value,
    });

    expect(result).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      nextAction: "compose_context_acceptance",
      requestFingerprint: canonical.requestFingerprint,
      instructionObservedAt,
    });
    expectSingleSnapshot(alternating, canonicalObservation);
  });

  test("snapshots reconciliation proposal evidence exactly once", () => {
    const attachment = attachmentRecord();
    const proposal = reconciliationProposal(attachment);
    const later = reconciliationProposal(
      attachment,
      "later",
      "actor_later",
    );
    const canonical = compileRequestBase(requestInput(proposal));
    const alternating = alternatingRecord(proposal, later);

    const result = resolve({
      proposal: alternating.value,
      request: canonical,
      attachment,
      observation: observation(attachment),
    });

    expect(result).toMatchObject({
      outcome: "ready_for_context_acceptance_binding",
      requestFingerprint: canonical.requestFingerprint,
    });
    expectSingleSnapshot(alternating, proposal);
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

function proposalLessDisposition(
  request: GitHubProviderInstructionObservationRequestV1,
  attachment: ProjectAttachmentRecord,
): "rejected" | "resolved" {
  try {
    resolve({
      request,
      attachment,
      observation: observation(attachment),
    });
    return "resolved";
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    expect((error as Error).message).toBe(requestOriginDiagnostic);
    return "rejected";
  }
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

function alternatingRecord<T extends object>(first: T, later: T) {
  let active: object = first;
  let snapshotCount = 0;
  let prototypeReadCount = 0;
  let descriptorReadCount = 0;
  const value = new Proxy({}, {
    getPrototypeOf() {
      prototypeReadCount += 1;
      return Object.prototype;
    },
    ownKeys() {
      active = snapshotCount === 0 ? first : later;
      snapshotCount += 1;
      return Reflect.ownKeys(active);
    },
    getOwnPropertyDescriptor(_target, key) {
      descriptorReadCount += 1;
      const descriptor = Object.getOwnPropertyDescriptor(active, key);
      if (!descriptor) return undefined;
      return {
        value: descriptor.value,
        writable: true,
        enumerable: descriptor.enumerable,
        configurable: true,
      };
    },
  }) as unknown as T;
  return {
    value,
    snapshots: () => snapshotCount,
    prototypeReads: () => prototypeReadCount,
    descriptorReads: () => descriptorReadCount,
  };
}

function expectSingleSnapshot<T extends object>(
  alternating: ReturnType<typeof alternatingRecord<T>>,
  canonical: T,
): void {
  expect(alternating.snapshots()).toBe(1);
  expect(alternating.prototypeReads()).toBe(1);
  expect(alternating.descriptorReads()).toBe(Reflect.ownKeys(canonical).length);
}

function reconciliationProposal(
  attachment: ProjectAttachmentRecord,
  suffix = "origin_state",
  actorId = "actor_lark",
): GitHubProviderContextReconciliationProposalV1 {
  const snapshot = issueSnapshot();
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(attachment, snapshot, suffix, actorId),
    current: null,
  });
}

function receipt(
  attachment: ProjectAttachmentRecord,
  snapshot: GitHubIssueContext,
  suffix: string,
  actorId: string,
): GitHubProviderReceipt {
  return {
    version: 1,
    id: `ghop_${suffix}`,
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId,
    clientId: "client_github_only",
    connectionId: `ghconn_${suffix}`,
    installationId: `installation_${suffix}`,
    bindingId: `ghbind_${suffix}`,
    attachmentId: attachment.id,
    attachmentSnapshotSha256: attachment.snapshot.snapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: `instruction-${suffix}`,
    parametersSha256: hash("a"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-03T09:29:55.000Z",
    updatedAt: providerObservedAt,
    providerRequestId: `request-${suffix}-provider`,
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
