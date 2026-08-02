import { describe, expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
} from "../src/github-project-context-admission.ts";
import {
  ConvexGitHubProjectContextBindingReader,
  HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1,
} from "../src/github-project-context-binding-convex-reader.ts";
import {
  ConvexGitHubProjectContextService,
  GitHubProjectContextStorageError,
} from "../src/github-project-context-convex-ledger.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

class FakeClient implements ConvexCaller {
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  queryResults: unknown[] = [];

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: String(reference), args });
    return this.queryResults.shift();
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.mutations.push({ name: String(reference), args });
    throw new Error("Mutation is outside this reader test");
  }
}

describe("private hosted GitHub project-context binding reader", () => {
  test("returns the exact current admitted binding as a frozen private object", async () => {
    const client = new FakeClient();
    const subject = fixture(965);
    const record = storedRecord(subject);
    client.queryResults = [record];
    const reader = bindingReader(client);

    const binding = await reader.getCurrentGitHubIssueContextBinding({
      project: "stensibly",
      externalId: record.externalId,
    });

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]?.args).toEqual({
      serviceSecret: "service-secret",
      workspace: "default",
      project: "stensibly",
      externalId: record.externalId,
    });
    expect(binding).toMatchObject({
      version: HOSTED_GITHUB_ISSUE_CONTEXT_BINDING_V1,
      workspace: "default",
      recordId: record.id,
      project: "stensibly",
      externalId: record.externalId,
      repositoryFullName: "teamleaderleo/stensibly",
      snapshot: {
        reference: { externalId: record.externalId },
        sourceRevision: subject.snapshot.sourceRevision,
      },
      instructionSet: {
        id: subject.instructionSet.id,
        projectAttachmentId: "attach_current",
        projectAttachmentSnapshotSha256:
          subject.instructionSet.projectAttachmentSnapshotSha256,
      },
      synchronization: {
        status: "synchronized",
        cursor: "github:cursor:965",
        degradedReasonCode: null,
        observationRef: "github:delivery:965:accepted",
        observedAt: "2026-08-02T17:40:00.000Z",
        acceptedBy: "actor_lynx",
        acceptedAt: "2026-08-02T17:40:01.000Z",
        outcome: "initial",
        isCurrent: true,
      },
    });
    expect(binding?.snapshot).toEqual(subject.snapshot);
    expect(binding?.instructionSet).toEqual(subject.instructionSet);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding?.snapshot)).toBe(true);
    expect(Object.isFrozen(binding?.snapshot.labels)).toBe(true);
    expect(Object.isFrozen(binding?.instructionSet)).toBe(true);
    expect(Object.isFrozen(binding?.instructionSet.sources)).toBe(true);
    expect(Object.isFrozen(binding?.synchronization)).toBe(true);
  });

  test("returns null only when the hosted current row is absent", async () => {
    const client = new FakeClient();
    client.queryResults = [null];

    await expect(bindingReader(client).getCurrentGitHubIssueContextBinding({
      project: "stensibly",
      externalId: "github:teamleaderleo/stensibly#965",
    })).resolves.toBeNull();
  });

  test("fails closed on project, issue, or current-row substitution", async () => {
    const requested = fixture(965);
    const otherIssue = fixture(966);
    const cases = [
      { ...storedRecord(requested), project: "other" },
      storedRecord(otherIssue),
      { ...storedRecord(requested), isCurrent: false },
    ];

    for (const row of cases) {
      const client = new FakeClient();
      client.queryResults = [row];
      await expect(bindingReader(client).getCurrentGitHubIssueContextBinding({
        project: "stensibly",
        externalId: requested.snapshot.reference.externalId,
      })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
    }
  });

  test("reuses canonical stored snapshot and instruction validation", async () => {
    const subject = fixture(965);
    const forgedRows = [
      { ...storedRecord(subject), instructionSetId: "instructions_forged" },
      { ...storedRecord(subject), snapshotSha256: `sha256:${"f".repeat(64)}` },
      {
        ...storedRecord(subject),
        projectAttachmentSnapshotSha256: `sha256:${"e".repeat(64)}`,
      },
      {
        ...storedRecord(subject),
        acceptedAt: "2026-08-04T17:40:01.000Z",
      },
    ];

    for (const row of forgedRows) {
      const client = new FakeClient();
      client.queryResults = [row];
      await expect(bindingReader(client).getCurrentGitHubIssueContextBinding({
        project: "stensibly",
        externalId: subject.snapshot.reference.externalId,
      })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
    }
  });

  test("rejects hostile backend accessors without invoking them", async () => {
    const subject = fixture(965);
    const hostile: Record<string, unknown> = {
      ...storedRecord(subject),
    };
    let reads = 0;
    Object.defineProperty(hostile, "instructionSetJson", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("private backend text");
      },
    });
    const client = new FakeClient();
    client.queryResults = [hostile];

    await expect(bindingReader(client).getCurrentGitHubIssueContextBinding({
      project: "stensibly",
      externalId: subject.snapshot.reference.externalId,
    })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
    expect(reads).toBe(0);
  });

  test("keeps the existing public projection content-minimised", async () => {
    const client = new FakeClient();
    const subject = fixture(965);
    const record = storedRecord(subject);
    client.queryResults = [record, [record]];
    const service = new ConvexGitHubProjectContextService({
      client,
      serviceSecret: "service-secret",
      workspace: "default",
      now: () => Date.parse("2026-08-02T17:45:00.000Z"),
    });

    const projection = await service.getGitHubProjectContext({
      project: "stensibly",
      externalId: record.externalId,
    });

    expect(projection.issues).toHaveLength(1);
    expect(projection.issues[0]).not.toHaveProperty("snapshot");
    expect(projection.issues[0]).not.toHaveProperty("instructionSet");
    expect(projection.issues[0]?.instructions).toEqual({
      id: subject.instructionSet.id,
      sourcePaths: ["AGENTS.md"],
    });
  });

  test("validates requested identity before making a hosted call", async () => {
    const client = new FakeClient();
    const reader = bindingReader(client);

    await expect(reader.getCurrentGitHubIssueContextBinding({
      project: "Stensibly",
      externalId: "github:teamleaderleo/stensibly#965",
    })).rejects.toThrow("project is invalid");
    await expect(reader.getCurrentGitHubIssueContextBinding({
      project: "stensibly",
      externalId: "github:TeamLeaderLeo/stensibly#965",
    })).rejects.toThrow("must be canonical");
    expect(client.queries).toHaveLength(0);
  });
});

function bindingReader(client: FakeClient) {
  return new ConvexGitHubProjectContextBindingReader({
    client,
    serviceSecret: "service-secret",
    workspace: "default",
    now: () => Date.parse("2026-08-02T17:45:00.000Z"),
  });
}

function fixture(number: number) {
  const snapshot = buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number,
    title: `Private hosted GitHub context binding ${number}`,
    body: "private issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T17:30:00.000Z",
    updatedAt: "2026-08-02T17:39:00.000Z",
    providerNodeId: `I_kwDOBinding${number}`,
    sourceRevision: `github:issue:${number}:rev-1`,
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
    syncCursor: `github:cursor:${number}`,
    degradedReasonCode: null,
    observationRef: `github:delivery:${number}:accepted`,
    observedAt: "2026-08-02T17:40:00.000Z",
    acceptedBy: "actor_lynx",
  };
}

function storedRecord(subject: ReturnType<typeof fixture>) {
  return {
    id: deterministicRecordId(
      "default",
      "stensibly",
      subject.observationRef,
    ),
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
    acceptedAt: "2026-08-02T17:40:01.000Z",
    isCurrent: true,
    outcome: "initial" as const,
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
