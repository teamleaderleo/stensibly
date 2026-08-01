import { describe, expect, test } from "bun:test";
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

class FakeClient implements ConvexCaller {
  readonly mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  mutationResult: unknown;
  queryResults: unknown[] = [];

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.mutations.push({ name: String(reference), args });
    return this.mutationResult;
  }

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: String(reference), args });
    return this.queryResults.shift();
  }
}

describe("Convex GitHub project context service", () => {
  test("accepts canonical context and exposes the existing bounded projection", async () => {
    const client = new FakeClient();
    const subject = fixture();
    const record = storedRecord(subject);
    client.mutationResult = { record, replayed: false };
    client.queryResults = [record, [record]];
    const service = new ConvexGitHubProjectContextService({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
    });

    await expect(service.acceptGitHubIssueContext({
      project: "stensibly",
      ...subject,
    })).resolves.toEqual({
      recordId: record.id,
      externalId: record.externalId,
      outcome: "initial",
      isCurrent: true,
      replayed: false,
    });
    expect(client.mutations[0]?.args).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "default",
      project: "stensibly",
      snapshotJson: canonicalGitHubIssueContextJson(subject.snapshot),
      instructionSetJson: canonicalRepositoryInstructionSetJson(subject.instructionSet),
    });

    const projection = await service.getGitHubProjectContext({
      project: "stensibly",
      externalId: record.externalId,
      historyLimit: 10,
    });
    expect(projection).toMatchObject({
      version: 1,
      workspace: "default",
      project: "stensibly",
      mode: "issue",
      requestedExternalId: record.externalId,
      issues: [{
        externalId: record.externalId,
        title: subject.snapshot.title,
        synchronization: { outcome: "initial" },
        instructions: { id: subject.instructionSet.id },
      }],
      history: [{ externalId: record.externalId, isCurrent: true }],
    });
    expect(projection.issues[0]).not.toHaveProperty("body");
    expect(projection.issues[0]).not.toHaveProperty("snapshotSha256");
    expect(Object.isFrozen(projection.recovery.guidance)).toBe(true);
  });

  test("rejects hostile backend objects without invoking getters", async () => {
    const client = new FakeClient();
    let getterCalls = 0;
    const hostile: Record<string, unknown> = { replayed: false };
    Object.defineProperty(hostile, "record", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private backend prose");
      },
    });
    client.mutationResult = hostile;
    const service = new ConvexGitHubProjectContextService({
      client,
      serviceSecret: "service-secret",
    });
    await expect(service.acceptGitHubIssueContext({
      project: "stensibly",
      ...fixture(),
    })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
    expect(getterCalls).toBe(0);
  });

  test("rejects forged stored metadata and bounds project/history input", async () => {
    const client = new FakeClient();
    const subject = fixture();
    client.queryResults = [[{
      ...storedRecord(subject),
      instructionSetId: "instructions_forged",
    }]];
    const service = new ConvexGitHubProjectContextService({
      client,
      serviceSecret: "service-secret",
    });
    await expect(service.getGitHubProjectContext({
      project: "stensibly",
    })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
    await expect(service.getGitHubProjectContext({
      project: "Stensibly",
    })).rejects.toThrow("project is invalid");
    await expect(service.getGitHubProjectContext({
      project: "stensibly",
      historyLimit: 51,
    })).rejects.toThrow("must be between 1 and 50");
  });
});

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
      target: { owner: "teamleaderleo", repository: "stensibly", number: 492 },
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
    acceptedBy: "plover",
  };
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

function storedRecord(subject: ReturnType<typeof fixture>) {
  return {
    id: deterministicRecordId("default", "stensibly", subject.observationRef),
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
    instructionSetJson: canonicalRepositoryInstructionSetJson(subject.instructionSet),
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
