import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import { buildGitHubIssueContext } from "../src/github-issue-context.ts";
import { ConvexGitHubProjectContextLedger } from "../src/github-project-context-convex-ledger.ts";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint.ts";

const attachmentHash = `sha256:${"a".repeat(64)}`;
const sourceHash = `sha256:${"b".repeat(64)}`;

class GitHubContextCaller implements ConvexCaller {
  readonly calls: Array<{
    type: "query" | "mutation";
    name: string;
    args: Record<string, unknown>;
  }> = [];
  records: any[] = [];

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "query", name, args });
    if (name === "githubProjectContexts:listCurrent") {
      return this.records.filter((record) => record.isCurrent).slice(0, args.limit as number);
    }
    if (name === "githubProjectContexts:getCurrent") {
      return this.records.find((record) =>
        record.externalId === args.externalId && record.isCurrent
      ) ?? null;
    }
    if (name === "githubProjectContexts:listHistory") {
      return this.records
        .filter((record) => record.externalId === args.externalId)
        .slice(-(args.limit as number));
    }
    throw new Error(`Unexpected query ${name}`);
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "mutation", name, args });
    if (name !== "githubProjectContexts:accept") throw new Error(`Unexpected mutation ${name}`);
    const existing = this.records.find((record) => record.observationRef === args.observationRef);
    if (existing) return { record: existing, replayed: true };
    for (const record of this.records) record.isCurrent = false;
    const record = {
      id: `github_context_${this.records.length + 1}`,
      project: args.project,
      externalId: JSON.parse(args.snapshotJson as string).reference.externalId,
      snapshotJson: args.snapshotJson,
      instructionSetJson: args.instructionSetJson,
      syncStatus: args.syncStatus,
      syncCursor: args.syncCursor,
      degradedReasonCode: args.degradedReasonCode,
      observationRef: args.observationRef,
      observedAt: args.observedAt,
      acceptedBy: args.acceptedBy,
      acceptedAt: "2026-07-29T15:00:00.000Z",
      isCurrent: true,
      outcome: this.records.length ? "updated" : "initial",
    };
    this.records.push(record);
    return { record, replayed: false };
  }
}

describe("Convex GitHub project context ledger adapter", () => {
  test("routes trusted acceptance and returns the bounded recovery projection", async () => {
    const client = new GitHubContextCaller();
    const ledger = new ConvexGitHubProjectContextLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });
    const snapshot = issueContext();

    const accepted = await ledger.acceptGitHubIssueContext({
      project: "scrapbook",
      snapshot,
      projectAttachmentId: "attach_current",
      projectAttachmentSnapshotSha256: attachmentHash,
      instructionSources: [
        { path: "STENSIBLY.md", revision: "instructions-r2", contentSha256: sourceHash },
        { path: "AGENTS.md", revision: "instructions-r1", contentSha256: attachmentHash },
      ],
      syncStatus: "degraded",
      degradedReasonCode: "github_connector_unavailable",
      observationRef: "github-observation-564",
      observedAt: "2026-07-29T14:59:00.000Z",
      acceptedBy: "actor:juniper",
    });
    expect(accepted).toMatchObject({
      replayed: false,
      externalId: snapshot.reference.externalId,
      outcome: "initial",
      isCurrent: true,
    });

    const projected = await ledger.getGitHubProjectContext({
      project: "scrapbook",
      externalId: snapshot.reference.externalId,
      historyLimit: 10,
    });
    expect(projected).toMatchObject({
      version: 1,
      workspace: "default",
      project: "scrapbook",
      mode: "issue",
      requestedExternalId: snapshot.reference.externalId,
      issues: [{
        externalId: snapshot.reference.externalId,
        canonicalUrl: snapshot.reference.canonicalUrl,
        title: snapshot.title,
        synchronization: {
          status: "degraded",
          degradedReasonCode: "github_connector_unavailable",
          acceptedBy: "actor:juniper",
        },
        instructions: {
          sourcePaths: ["AGENTS.md", "STENSIBLY.md"],
        },
      }],
    });
    expect(projected.history).toHaveLength(1);
    expect(projected.recovery.directGitHubUrls).toEqual([snapshot.reference.canonicalUrl]);

    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("bodyRevision");
    expect(serialized).not.toContain("snapshotSha256");
    expect(serialized).not.toContain("contentSha256");
    expect(serialized).not.toContain("syncCursor");
    expect(serialized).not.toContain("Private issue body");

    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "mutation:githubProjectContexts:accept",
      "query:githubProjectContexts:getCurrent",
      "query:githubProjectContexts:listHistory",
    ]);
    expect(client.calls[0]?.args).toMatchObject({
      serviceSecret: "private-service-secret",
      workspace: "default",
      project: "scrapbook",
      projectAttachmentId: "attach_current",
      projectAttachmentSnapshotSha256: attachmentHash,
      syncStatus: "degraded",
      degradedReasonCode: "github_connector_unavailable",
    });
    const instructionSet = JSON.parse(client.calls[0]?.args.instructionSetJson as string);
    expect(instructionSet.sources.map((source: any) => source.path)).toEqual([
      "AGENTS.md",
      "STENSIBLY.md",
    ]);
    expect(instructionSet.sha256).toBe(fingerprintCanonicalRequest({
      version: 1,
      projectAttachmentId: "attach_current",
      projectAttachmentSnapshotSha256: attachmentHash,
      sources: instructionSet.sources,
    }));
  });

  test("fails closed when hosted JSON metadata is altered", async () => {
    const client = new GitHubContextCaller();
    const snapshot = issueContext();
    client.records.push({
      id: "github_context_tampered",
      project: "scrapbook",
      externalId: snapshot.reference.externalId,
      snapshotJson: JSON.stringify({ ...snapshot, snapshotSha256: `sha256:${"0".repeat(64)}` }),
      instructionSetJson: JSON.stringify(instructionSet()),
      syncStatus: "synchronized",
      syncCursor: null,
      degradedReasonCode: null,
      observationRef: "github-observation-tampered",
      observedAt: "2026-07-29T14:59:00.000Z",
      acceptedBy: "actor:juniper",
      acceptedAt: "2026-07-29T15:00:00.000Z",
      isCurrent: true,
      outcome: "initial",
    });
    const ledger = new ConvexGitHubProjectContextLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "default",
    });

    await expect(ledger.getGitHubProjectContext({ project: "scrapbook" }))
      .rejects.toThrow("snapshot fingerprint is invalid");
  });
});

function issueContext() {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 564,
    title: "Persist accepted GitHub issue context in hosted Convex",
    body: "Private issue body",
    state: "open",
    labels: ["area:github", "mode:hosted"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [{
      kind: "blocks",
      target: { owner: "teamleaderleo", repository: "stensibly", number: 560 },
    }],
    createdAt: "2026-07-29T13:00:00.000Z",
    updatedAt: "2026-07-29T14:00:00.000Z",
    sourceRevision: "issue-564-r1",
  });
}

function instructionSet() {
  const canonical = {
    version: 1 as const,
    projectAttachmentId: "attach_current",
    projectAttachmentSnapshotSha256: attachmentHash,
    sources: [{ path: "AGENTS.md", revision: "instructions-r1", contentSha256: sourceHash }],
  };
  const sha256 = fingerprintCanonicalRequest(canonical);
  return {
    ...canonical,
    id: `instructions_${sha256.slice("sha256:".length)}`,
    sha256,
  };
}
