import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
} from "../src/github-project-context-admission.ts";
import { ConvexGitHubProjectContextService } from "../src/github-project-context-convex-ledger.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

class MutationClient implements ConvexCaller {
  mutationResult: unknown;

  async mutation(
    _reference: FunctionReference<"mutation">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.mutationResult;
  }

  async query(
    _reference: FunctionReference<"query">,
    _args: Record<string, unknown>,
  ): Promise<unknown> {
    throw new Error("unused query");
  }
}

test("accepts a stored observation inside the mutation clock-skew allowance", async () => {
  const snapshot = buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 747,
    title: "Rebuild hosted accepted GitHub context",
    body: "private issue body",
    state: "open",
    stateReason: null,
    labels: ["area:coordination"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-07-31T14:58:08.000Z",
    updatedAt: "2026-07-31T16:03:53.000Z",
    providerNodeId: "I_kwDOThZq1s7c",
    sourceRevision: "github:issue:747:rev-1",
  });
  const instructionSet = buildAcceptedRepositoryInstructionSet({
    projectAttachmentId: "attach_current",
    projectAttachmentSnapshotSha256: `sha256:${"a".repeat(64)}`,
    sources: [{
      path: "AGENTS.md",
      revision: "main@current",
      contentSha256: `sha256:${"b".repeat(64)}`,
    }],
  });
  const subject = {
    snapshot,
    instructionSet,
    syncStatus: "synchronized" as const,
    syncCursor: "github:cursor:747",
    degradedReasonCode: null,
    observationRef: "github:delivery:747:clock-skew",
    observedAt: "2026-07-31T16:10:00.000Z",
    acceptedBy: "plover",
  };
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace: "default",
    project: "stensibly",
    observationRef: subject.observationRef,
  });
  const record = {
    id: `github_context_${digest.slice("sha256:".length)}`,
    project: "stensibly",
    externalId: snapshot.reference.externalId,
    repositoryFullName: snapshot.reference.repositoryFullName,
    sourceRevision: snapshot.sourceRevision,
    snapshotSha256: snapshot.snapshotSha256,
    contentSha256: snapshot.contentSha256,
    providerUpdatedAt: snapshot.updatedAt,
    snapshotJson: canonicalGitHubIssueContextJson(snapshot),
    projectAttachmentId: instructionSet.projectAttachmentId,
    projectAttachmentSnapshotSha256:
      instructionSet.projectAttachmentSnapshotSha256,
    instructionSetId: instructionSet.id,
    instructionSetSha256: instructionSet.sha256,
    instructionSetJson: canonicalRepositoryInstructionSetJson(instructionSet),
    syncStatus: subject.syncStatus,
    syncCursor: subject.syncCursor,
    degradedReasonCode: subject.degradedReasonCode,
    observationRef: subject.observationRef,
    observedAt: subject.observedAt,
    acceptedBy: subject.acceptedBy,
    acceptedAt: "2026-07-31T16:09:00.000Z",
    isCurrent: true,
    outcome: "initial" as const,
  };
  const client = new MutationClient();
  client.mutationResult = { record, replayed: false };
  const service = new ConvexGitHubProjectContextService({
    client,
    serviceSecret: "service-secret",
    workspace: "default",
  });

  await expect(service.acceptGitHubIssueContext({
    project: "stensibly",
    ...subject,
  })).resolves.toMatchObject({
    recordId: record.id,
    replayed: false,
  });
});
