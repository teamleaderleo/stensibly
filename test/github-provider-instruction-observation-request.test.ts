import { describe, expect, test } from "bun:test";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts.ts";
import {
  buildGitHubIssueContext,
  type GitHubIssueContext,
} from "../src/github-issue-context.ts";
import {
  GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
  compileGitHubProviderInstructionObservationRequestV1,
} from "../src/github-provider-instruction-observation-request.ts";
import {
  GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
  compileGitHubProviderContextReconciliation,
  type GitHubProviderContextReconciliationProposalV1,
} from "../src/github-provider-context-reconciliation.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const workspace = "default";
const project = "stensibly";
const repositoryFullName = "teamleaderleo/stensibly";
const attachmentId = "attach_current";
const attachmentSnapshotSha256 = `sha256:${"a".repeat(64)}`;
const observedAt = "2026-08-02T19:10:00.000Z";

describe("GitHub provider instruction observation requests", () => {
  test("compiles create, update, label, and assignee proposals", () => {
    const cases = [
      proposal("github_create_issue", 978, null),
      proposal(
        "github_update_issue",
        978,
        "github-rest:I_instruction_978:previous",
      ),
      proposal(
        "github_add_issue_labels",
        978,
        "github-rest:I_instruction_978:previous",
      ),
      proposal(
        "github_remove_issue_assignees",
        978,
        "github-rest:I_instruction_978:previous",
      ),
    ];

    for (const candidate of cases) {
      const request = compile(candidate);
      expect(request).toMatchObject({
        version: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
        workspace,
        project,
        repositoryFullName,
        receiptId: candidate.receiptId,
        operation: candidate.operation,
        externalId: candidate.externalId,
        previousSourceRevision: candidate.currentSourceRevision,
        providerSourceRevision: candidate.providerSourceRevision,
        actorId: "actor_lynx",
        attachmentId,
        attachmentSnapshotSha256,
        providerObservedAt: observedAt,
        proposalFingerprint: candidate.proposalFingerprint,
        outcome: "ready_for_repository_instruction_observation",
        nextAction: "load_attachment_and_observe_repository_instructions",
        authorizesProviderRead: false,
        authorizesProviderMutation: false,
        authorizesContextAcceptance: false,
        authorizesApproval: false,
        authorizesAuthority: false,
      });
      expect(request.requestId).toMatch(
        /^github_instruction_observation_[a-f0-9]{64}$/u,
      );
      expect(request.observationRef).toMatch(
        /^github:provider-instruction-observation:[a-f0-9]{64}$/u,
      );
      expect(request.requestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(Object.isFrozen(request)).toBe(true);
      expect(request).not.toHaveProperty("providerSnapshot");
      expect(request).not.toHaveProperty("title");
      expect(request).not.toHaveProperty("body");
    }
  });

  test("keeps every non-actionable proposal distinct from an observation request", () => {
    const proposals = [
      compileGitHubProviderContextReconciliation({
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
      }),
      compileGitHubProviderContextReconciliation({
        schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
        receipt: receipt({
          state: "pending_reconciliation",
          result: null,
          providerRequestId: null,
          verification: {
            state: "failed",
            checkedAt: observedAt,
            sourceRevision: null,
          },
          error: {
            code: "ambiguous_provider_outcome",
            message: "Provider outcome requires reconciliation",
            retry: "reconcile_before_retry",
          },
          recovery: { nextAction: "reconcile_exact_operation" },
        }),
        current: null,
      }),
      commentProposal(),
      proposal(
        "github_update_issue",
        978,
        "github-rest:I_instruction_978:provider",
      ),
    ];

    for (const candidate of proposals) {
      const request = compile(candidate);
      expect(request).toMatchObject({
        outcome: candidate.outcome === "propose_context_acceptance"
          ? "ready_for_repository_instruction_observation"
          : "proposal_not_actionable",
        nextAction: candidate.outcome === "propose_context_acceptance"
          ? "load_attachment_and_observe_repository_instructions"
          : "none",
      });
      if (candidate.outcome !== "propose_context_acceptance") {
        expect(request.requestId).toBeNull();
        expect(request.observationRef).toBeNull();
      }
    }
  });

  test("binds request identity to workspace and attachment generation", () => {
    const candidate = proposal("github_create_issue", 978, null);
    const base = compile(candidate, "default");
    const otherWorkspace = compile(candidate, "other");
    const otherAttachment = compile(proposal(
      "github_create_issue",
      978,
      null,
      {
        attachmentId: "attach_other",
        attachmentSnapshotSha256: `sha256:${"c".repeat(64)}`,
      },
    ));

    expect(otherWorkspace.workspace).toBe("other");
    expect(otherWorkspace.requestId).not.toBe(base.requestId);
    expect(otherWorkspace.observationRef).not.toBe(base.observationRef);
    expect(otherWorkspace.requestFingerprint).not.toBe(base.requestFingerprint);
    expect(otherAttachment.requestId).not.toBe(base.requestId);
    expect(otherAttachment.requestFingerprint).not.toBe(base.requestFingerprint);
  });

  test("rejects a refingerprinted comment as actionable issue context", () => {
    const original = proposal("github_update_issue", 978, null);
    const forged = {
      ...structuredClone(original),
      operation: "github_add_issue_comment" as const,
    };
    const refingerprinted = {
      ...forged,
      proposalFingerprint: fingerprintCanonicalRequest(withoutFingerprint(forged)),
    };

    expect(() => compile(refingerprinted)).toThrow(
      "proposal operation is not actionable",
    );
  });

  test("rejects refingerprinted proposal semantic mismatches", () => {
    const original = proposal("github_update_issue", 978, null);
    const wrongActionBody = {
      ...structuredClone(original),
      nextAction: "none" as const,
    };
    const wrongAction = {
      ...wrongActionBody,
      proposalFingerprint: fingerprintCanonicalRequest(
        withoutFingerprint(wrongActionBody),
      ),
    };
    expect(() => compile(wrongAction)).toThrow(
      "proposal semantics are invalid",
    );

    const wrongRepositoryBody = {
      ...structuredClone(original),
      repositoryFullName: "other/repository",
    };
    const wrongRepository = {
      ...wrongRepositoryBody,
      proposalFingerprint: fingerprintCanonicalRequest(
        withoutFingerprint(wrongRepositoryBody),
      ),
    };
    expect(() => compile(wrongRepository)).toThrow(
      "proposal semantics are invalid",
    );
  });

  test("rejects proposal tampering and hostile descriptors without reading them", () => {
    const candidate = proposal("github_create_issue", 978, null);
    const tampered = structuredClone(candidate) as unknown as Record<string, unknown>;
    tampered.actorId = "actor_other";
    expect(() => compile(
      tampered as unknown as GitHubProviderContextReconciliationProposalV1,
    )).toThrow("proposal fingerprint is invalid");

    let reads = 0;
    const hostile = structuredClone(candidate) as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(hostile, "attachmentId", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("github_pat_hidden_value");
      },
    });
    expect(() => compile(
      hostile as unknown as GitHubProviderContextReconciliationProposalV1,
    )).toThrow("enumerable data properties");
    expect(reads).toBe(0);
  });

  test("is deterministic and excludes provider prose from the request", () => {
    const candidate = proposal("github_create_issue", 978, null);
    const first = compile(candidate);
    const second = compile(structuredClone(candidate));

    expect(second).toEqual(first);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("Fresh instruction issue 978");
    expect(serialized).not.toContain("provider issue body");
  });
});

function compile(
  proposalValue: GitHubProviderContextReconciliationProposalV1,
  workspaceValue = workspace,
) {
  return compileGitHubProviderInstructionObservationRequestV1({
    schemaVersion: GITHUB_PROVIDER_INSTRUCTION_OBSERVATION_REQUEST_V1,
    workspace: workspaceValue,
    proposal: proposalValue,
  });
}

function proposal(
  operation:
    | "github_create_issue"
    | "github_update_issue"
    | "github_add_issue_labels"
    | "github_remove_issue_assignees",
  number: number,
  currentSourceRevision: string | null,
  overrides: Partial<GitHubProviderReceipt> = {},
) {
  const snapshot = issueSnapshot(number);
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt({
      id: `ghop_instruction_${operation}_${number}`,
      operation,
      target: operation === "github_create_issue"
        ? `${repositoryFullName}#new`
        : operation.includes("labels")
          ? `${repositoryFullName}#${number}:labels`
          : operation.includes("assignees")
            ? `${repositoryFullName}#${number}:assignees`
            : `${repositoryFullName}#${number}`,
      idempotencyKey: `instruction-${operation}-${number}`,
      result: snapshot,
      verification: {
        state: "passed",
        checkedAt: observedAt,
        sourceRevision: snapshot.sourceRevision,
      },
      ...overrides,
    }),
    current: currentSourceRevision === null
      ? null
      : {
        externalId: snapshot.reference.externalId,
        sourceRevision: currentSourceRevision,
      },
  });
}

function commentProposal() {
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt({
      operation: "github_add_issue_comment",
      target: `${repositoryFullName}#978:comment:new`,
      result: {
        id: "978001",
        issueNumber: 978,
        canonicalUrl:
          "https://github.com/teamleaderleo/stensibly/issues/978#issuecomment-978001",
        createdAt: observedAt,
        updatedAt: observedAt,
        sourceRevision: "github-rest:IC_978001:rev-1",
        bodyRevision: {
          byteLength: 20,
          sha256: `sha256:${"f".repeat(64)}`,
        },
        containsBody: false,
      },
      verification: {
        state: "passed",
        checkedAt: observedAt,
        sourceRevision: "github-rest:IC_978001:rev-1",
      },
    }),
    current: null,
  });
}

function receipt(
  overrides: Partial<GitHubProviderReceipt> = {},
): GitHubProviderReceipt {
  const snapshot = issueSnapshot(978);
  return {
    version: 1,
    id: "ghop_instruction_978",
    project,
    provider: "github",
    repositoryFullName,
    operation: "github_create_issue",
    target: `${repositoryFullName}#new`,
    actorId: "actor_lynx",
    clientId: "client_github_only",
    connectionId: "ghconn_instruction",
    installationId: "installation_instruction",
    bindingId: "ghbind_instruction",
    attachmentId,
    attachmentSnapshotSha256,
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "instruction-observation-978",
    parametersSha256: `sha256:${"b".repeat(64)}`,
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-02T19:09:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "request-instruction-978",
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

function issueSnapshot(number: number): GitHubIssueContext {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number,
    title: `Fresh instruction issue ${number}`,
    body: "provider issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T19:00:00.000Z",
    updatedAt: observedAt,
    providerNodeId: `I_instruction_${number}`,
    sourceRevision: `github-rest:I_instruction_${number}:provider`,
  });
}

function withoutFingerprint(
  proposal: GitHubProviderContextReconciliationProposalV1,
) {
  const { proposalFingerprint: _proposalFingerprint, ...body } = proposal;
  return body;
}
