import { describe, expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import { ConvexProjectAttachmentLedger } from "../src/project-attachment-convex-ledger.ts";
import { compileProjectContract, renderProjectContract } from "../src/project-contract.ts";

class AttachmentCaller implements ConvexCaller {
  current: Record<string, unknown> | null = null;
  readonly calls: Array<{
    type: "query" | "mutation";
    name: string;
    args: Record<string, unknown>;
  }> = [];

  async query(
    reference: FunctionReference<"query">,
    args: Record<string, unknown>,
  ) {
    this.calls.push({ type: "query", name: getFunctionName(reference), args });
    return this.current;
  }

  async mutation(
    reference: FunctionReference<"mutation">,
    args: Record<string, unknown>,
  ) {
    const name = getFunctionName(reference);
    this.calls.push({ type: "mutation", name, args });
    if (name !== "projectAttachments:accept") throw new Error(`Unexpected mutation ${name}`);
    this.current = {
      id: args.externalId,
      project: args.project,
      snapshotJson: args.snapshotJson,
      snapshotSha256: args.snapshotSha256,
      contentSha256: args.contentSha256,
      sourcePath: args.sourcePath,
      sourceRevision: args.sourceRevision,
      acceptedBy: args.acceptedBy,
      authorityWidening: args.authorityWidening,
      acceptedAt: "2026-07-25T00:00:00.000Z",
    };
    return this.current;
  }
}

describe("Convex project attachment ledger adapter", () => {
  test("maps accepted snapshots and sends compare-and-swap authority metadata", async () => {
    const client = new AttachmentCaller();
    const ledger = new ConvexProjectAttachmentLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });
    const snapshot = attachmentSnapshot();

    const accepted = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot,
      sourceRevision: "abcdef1234567890",
      acceptedBy: "token:operator",
      acceptAuthorityWidening: true,
    });

    expect(accepted).toMatchObject({
      replayed: false,
      diff: null,
      attachment: {
        project: "scrapbook",
        snapshot,
        sourceRevision: "abcdef1234567890",
        acceptedBy: "token:operator",
        authorityWidening: true,
      },
    });
    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "query:projectAttachments:getCurrent",
      "mutation:projectAttachments:accept",
    ]);
    expect(client.calls[0]?.args).toEqual({
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
      project: "scrapbook",
    });
    expect(client.calls[1]?.args).toMatchObject({
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
      project: "scrapbook",
      expectedCurrentSnapshotSha256: null,
      snapshotSha256: snapshot.snapshotSha256,
      contentSha256: snapshot.source.contentSha256,
      sourcePath: "STENSIBLY.md",
      sourceRevision: "abcdef1234567890",
      acceptedBy: "token:operator",
      authorityWidening: true,
    });
  });

  test("replays the exact current revision without a mutation", async () => {
    const client = new AttachmentCaller();
    const snapshot = attachmentSnapshot();
    client.current = rawRecord(snapshot, "attach_existing", "abcdef1234567890");
    const ledger = new ConvexProjectAttachmentLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });

    const replay = await ledger.acceptProjectAttachment({
      project: "scrapbook",
      snapshot,
      sourceRevision: "abcdef1234567890",
      acceptedBy: "token:different-operator",
      acceptAuthorityWidening: false,
    });
    expect(replay).toMatchObject({
      replayed: true,
      diff: null,
      attachment: { id: "attach_existing", acceptedBy: "token:operator" },
    });
    expect(client.calls.map(({ type, name }) => `${type}:${name}`)).toEqual([
      "query:projectAttachments:getCurrent",
    ]);
  });

  test("fails closed when hosted metadata does not match the signed snapshot", async () => {
    const client = new AttachmentCaller();
    const snapshot = attachmentSnapshot();
    client.current = {
      ...rawRecord(snapshot, "attach_tampered", "abcdef1234567890"),
      contentSha256: `sha256:${"0".repeat(64)}`,
    };
    const ledger = new ConvexProjectAttachmentLedger({
      client,
      serviceSecret: "private-service-secret",
      workspace: "shared-work",
    });

    await expect(ledger.getProjectAttachment("scrapbook"))
      .rejects.toThrow("metadata does not match");
  });
});

function attachmentSnapshot() {
  return compileProjectContract(renderProjectContract({
    version: 1,
    project: "scrapbook",
    repositories: ["teamleaderleo/stensibly"],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect", "propose"],
    approvalRequired: ["merge", "deploy"],
    checks: ["bun test"],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Coordinate the project.",
    boundaries: "Keep consequential effects approval-gated.",
    evidenceAndHandoff: "Attach checks and leave a next action.",
    escalation: "Escalate missing authority.",
  }));
}

function rawRecord(snapshot: ReturnType<typeof attachmentSnapshot>, id: string, revision: string) {
  return {
    id,
    project: "scrapbook",
    snapshotJson: JSON.stringify(snapshot),
    snapshotSha256: snapshot.snapshotSha256,
    contentSha256: snapshot.source.contentSha256,
    sourcePath: snapshot.source.path,
    sourceRevision: revision,
    acceptedBy: "token:operator",
    authorityWidening: true,
    acceptedAt: "2026-07-25T00:00:00.000Z",
  };
}
