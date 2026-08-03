import { describe, expect, test } from "bun:test";
import type { FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
} from "../src/github-project-context-admission.ts";
import { ConvexGitHubProjectContextBindingReader } from "../src/github-project-context-binding-convex-reader.ts";
import { GitHubProjectContextStorageError } from "../src/github-project-context-convex-ledger.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

class FakeClient implements ConvexCaller {
  readonly queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly queryResults: unknown[];

  constructor(queryResults: unknown[]) {
    this.queryResults = [...queryResults];
  }

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.queries.push({ name: String(reference), args });
    return this.queryResults.shift();
  }

  async mutation(): Promise<unknown> {
    throw new Error("Mutation is outside this reader control");
  }
}

const workspace = "default";
const project = "stensibly";
const observationRef = "github:delivery:965:accepted";
const externalId = "github:teamleaderleo/stensibly#965";

describe("private hosted GitHub context binding identity", () => {
  test("returns only the deterministic workspace/project/observation record ID", async () => {
    const record = storedRecord();
    const client = new FakeClient([projectRows(), record]);

    const binding = await reader(client).getCurrentGitHubIssueContextBinding({
      project,
      externalId,
    });

    expect(binding?.recordId).toBe(deterministicRecordId());
    expect(binding?.synchronization.observationRef).toBe(observationRef);
  });

  test("rejects a substituted record ID after every semantic field validates", async () => {
    const forged = {
      ...storedRecord(),
      id: `github_context_${"f".repeat(64)}`,
    };
    const client = new FakeClient([projectRows(), forged]);

    await expect(reader(client).getCurrentGitHubIssueContextBinding({
      project,
      externalId,
    })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
  });

  test("rejects reversed project-scope chronology before reading the binding", async () => {
    const reversed = projectRows().map((entry) => ({
      ...entry,
      createdAt: "2026-08-02T17:31:00.000Z",
      updatedAt: "2026-08-02T17:30:00.000Z",
    }));
    const client = new FakeClient([reversed, storedRecord()]);

    await expect(reader(client).getCurrentGitHubIssueContextBinding({
      project,
      externalId,
    })).rejects.toBeInstanceOf(GitHubProjectContextStorageError);
    expect(client.queries).toHaveLength(1);
  });
});

function reader(client: FakeClient): ConvexGitHubProjectContextBindingReader {
  return new ConvexGitHubProjectContextBindingReader({
    client,
    serviceSecret: "service-secret",
    workspace,
    now: () => Date.parse("2026-08-02T17:45:00.000Z"),
  });
}

function projectRows() {
  return [{
    id: "project_stensibly",
    slug: project,
    name: "Stensibly",
    createdAt: "2026-08-02T17:00:00.000Z",
    updatedAt: "2026-08-02T17:30:00.000Z",
  }];
}

function storedRecord() {
  const snapshot = buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 965,
    title: "Private hosted GitHub context binding 965",
    body: "private issue body",
    state: "open",
    stateReason: null,
    labels: ["area:github"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-02T17:30:00.000Z",
    updatedAt: "2026-08-02T17:39:00.000Z",
    providerNodeId: "I_kwDOBinding965",
    sourceRevision: "github:issue:965:rev-1",
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
    id: deterministicRecordId(),
    project,
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
    syncStatus: "synchronized" as const,
    syncCursor: "github:cursor:965",
    degradedReasonCode: null,
    observationRef,
    observedAt: "2026-08-02T17:40:00.000Z",
    acceptedBy: "actor_lumen",
    acceptedAt: "2026-08-02T17:40:01.000Z",
    isCurrent: true,
    outcome: "initial" as const,
  };
}

function deterministicRecordId(): string {
  const digest = fingerprintCanonicalRequest({
    version: 1,
    workspace,
    project,
    observationRef,
  });
  return `github_context_${digest.slice("sha256:".length)}`;
}
