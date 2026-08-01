import { expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
} from "../src/github-project-context-admission.ts";
import {
  ConvexGitHubProjectContextService,
  GitHubProjectContextStorageError,
} from "../src/github-project-context-convex-ledger.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

class AcceptanceResultClient implements ConvexCaller {
  constructor(readonly mutationResult: unknown) {}

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
    throw new Error("query is outside this acceptance control");
  }
}

test("rejects a backend acceptance with an unbound durable record ID", async () => {
  const subject = fixture();
  const service = serviceFor(subject, {
    id: "github_context_forged",
  });

  await expect(service.acceptGitHubIssueContext({
    project: "stensibly",
    ...subject,
  })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
});

test("rejects durable acceptance metadata dated far in the future", async () => {
  const subject = fixture();
  const service = serviceFor(subject, {
    acceptedAt: "2099-01-01T00:00:00.000Z",
  });

  await expect(service.acceptGitHubIssueContext({
    project: "stensibly",
    ...subject,
  })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
});

function serviceFor(
  subject: ReturnType<typeof fixture>,
  overrides: Partial<ReturnType<typeof storedRecord>>,
): ConvexGitHubProjectContextService {
  const client = new AcceptanceResultClient({
    replayed: false,
    record: { ...storedRecord(subject), ...overrides },
  });
  return new ConvexGitHubProjectContextService({
    client,
    serviceSecret: "service-secret",
    workspace: "default",
  });
}

function storedRecord(subject: ReturnType<typeof fixture>) {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace: "default",
    project: "stensibly",
    observationRef: subject.observationRef,
  });
  return {
    id: `github_context_${digest.slice("sha256:".length)}`,
    project: "stensibly",
    externalId: subject.snapshot.reference.externalId,
    repositoryFullName: subject.snapshot.reference.repositoryFullName,
    sourceRevision: subject.snapshot.sourceRevision,
    snapshotSha256: subject.snapshot.snapshotSha256,
    contentSha256: subject.snapshot.contentSha256,
    providerUpdatedAt: subject.snapshot.updatedAt,
    snapshotJson: canonicalGitHubIssueContextJson(subject.snapshot),
    projectAttachmentId: subject.instructionSet.projectAttachmentId,
    projectAttachmentSnapshotSha256:
      subject.instructionSet.projectAttachmentSnapshotSha256,
    instructionSetId: subject.instructionSet.id,
    instructionSetSha256: subject.instructionSet.sha256,
    instructionSetJson: canonicalRepositoryInstructionSetJson(
      subject.instructionSet,
    ),
    syncStatus: subject.syncStatus,
    syncCursor: subject.syncCursor,
    degradedReasonCode: subject.degradedReasonCode,
    observationRef: subject.observationRef,
    observedAt: subject.observedAt,
    acceptedBy: subject.acceptedBy,
    acceptedAt: "2026-07-31T16:10:01.000Z",
    isCurrent: true,
    outcome: "initial" as const,
  };
}

function fixture() {
  const snapshot = buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 747,
    title: "Rebuild hosted accepted GitHub context",
    body: "private issue body",
    state: "open",
    stateReason: null,
    labels: ["area:coordination", "triage:ready"],
    assignees: ["teamleaderleo"],
    milestone: { number: 12, title: "GitHub recovery" },
    relationships: [{
      kind: "parent",
      target: {
        owner: "teamleaderleo",
        repository: "stensibly",
        number: 492,
      },
    }],
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
  return {
    snapshot,
    instructionSet,
    syncStatus: "synchronized" as const,
    syncCursor: "github:cursor:747",
    degradedReasonCode: null,
    observationRef: "github:delivery:747:first",
    observedAt: "2026-07-31T16:10:00.000Z",
    acceptedBy: "ember",
  };
}
