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
const externalId = `github:${repositoryFullName}#973`;
const observedAt = "2026-08-04T19:20:00.000Z";
const previousRevision = "github-rest:I_binding_final_privacy:previous";
const providerRevision = "github-rest:I_binding_final_privacy:provider";

const finalHostileValues = [
  `actorxstn.svc_${"a".repeat(12)}`,
  `actorxstn.tok_${"b".repeat(12)}`,
  "actorxauthorization:token",
] as const;

describe("GitHub context acceptance final binding privacy", () => {
  test.each(finalHostileValues)(
    "rejects final-policy acceptedBy identity %s",
    (acceptedBy) => {
      const candidate = binding();
      candidate.synchronization.acceptedBy = acceptedBy;
      expectFixedRejection(() => compose(candidate), acceptedBy);
    },
  );

  test.each(finalHostileValues)(
    "rejects final-policy observationRef identity %s",
    (observationRef) => {
      const candidate = binding();
      candidate.synchronization.observationRef = observationRef;
      expectFixedRejection(() => compose(candidate), observationRef);
    },
  );

  test("rejects final-policy cursor and degraded reason identities", () => {
    const cursor = `cursorxstn.tok_${"c".repeat(12)}`;
    const degradedReasonCode = "reasonxauthorization:token";

    const cursorBinding = binding();
    cursorBinding.synchronization.cursor = cursor;
    expectFixedRejection(() => compose(cursorBinding), cursor);

    const degradedBinding = binding();
    degradedBinding.synchronization.status = "degraded";
    degradedBinding.synchronization.degradedReasonCode = degradedReasonCode;
    expectFixedRejection(() => compose(degradedBinding), degradedReasonCode);
  });

  test("preserves benign short Stensibly-like binding identities", () => {
    const candidate = binding();
    candidate.synchronization.acceptedBy = "actorxstn.svc_review";
    candidate.synchronization.cursor = "cursorxstn.tok_review";

    expect(compose(candidate)).toMatchObject({
      outcome: "ready_for_context_acceptance",
      nextAction: "accept_context",
      bindingRecordId: candidate.recordId,
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
  const snapshot = issueSnapshot(973, providerRevision);
  return compileGitHubProviderContextReconciliation({
    schemaVersion: GITHUB_PROVIDER_CONTEXT_RECONCILIATION_V1,
    receipt: receipt(snapshot),
    current: {
      externalId,
      sourceRevision: previousRevision,
    },
  });
}

function binding(): HostedGitHubIssueContextBindingInputV1 {
  const workspace = "default";
  const project = "stensibly";
  const observationRef = "github:delivery:binding-final-privacy";
  return {
    version: 1,
    workspace,
    recordId: deterministicRecordId(workspace, project, observationRef),
    project,
    externalId,
    repositoryFullName,
    snapshot: issueSnapshot(973, previousRevision),
    instructionSet: buildAcceptedRepositoryInstructionSet({
      projectAttachmentId: "attach_binding_final_privacy",
      projectAttachmentSnapshotSha256: hash("a"),
      sources: [{
        path: "AGENTS.md",
        revision: "main@accepted",
        contentSha256: hash("b"),
      }],
    }),
    synchronization: {
      status: "synchronized",
      cursor: "github:cursor:binding-final-privacy",
      degradedReasonCode: null,
      observationRef,
      observedAt: "2026-08-04T19:10:00.000Z",
      acceptedBy: "actor_previous",
      acceptedAt: "2026-08-04T19:10:01.000Z",
      outcome: "initial",
      isCurrent: true,
    },
  };
}

function receipt(snapshot: GitHubIssueContext): GitHubProviderReceipt {
  return {
    version: 1,
    id: "ghop_binding_final_privacy",
    project: "stensibly",
    provider: "github",
    repositoryFullName,
    operation: "github_update_issue",
    target: `${repositoryFullName}#973`,
    actorId: "actor_loom",
    clientId: "client_github_only",
    connectionId: "ghconn_binding_final_privacy",
    installationId: "installation_binding_final_privacy",
    bindingId: "ghbind_binding_final_privacy",
    attachmentId: "attach_binding_final_privacy",
    attachmentSnapshotSha256: hash("a"),
    capabilityGrantId: null,
    approvalId: null,
    idempotencyKey: "binding-final-privacy",
    parametersSha256: hash("c"),
    state: "succeeded",
    attemptCount: 1,
    createdAt: "2026-08-04T19:19:55.000Z",
    updatedAt: observedAt,
    providerRequestId: "REQ-BINDING-FINAL-PRIVACY",
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
    title: "Binding final privacy",
    body: null,
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-04T19:00:00.000Z",
    updatedAt: observedAt,
    providerNodeId: `I_binding_final_privacy_${number}`,
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

function expectFixedRejection(run: () => unknown, rejectedText: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RangeError);
  expect((thrown as Error).message).not.toContain(rejectedText);
  expect(JSON.stringify(thrown)).not.toContain(rejectedText);
}

function hash(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
