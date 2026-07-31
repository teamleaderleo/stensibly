import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { ConvexCaller } from "../src/convex-ledger.ts";
import {
  ConvexProjectAttachmentLedger,
  createConvexProjectAttachmentLedgerFromEnv,
} from "../src/project-attachment-convex-ledger.ts";
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

  test("composes private delegated reads after the hosted issue provider only under the exact flag", () => {
    const issueOnly = createConvexProjectAttachmentLedgerFromEnv(
      hostedFactoryEnv(false),
    );
    expect(typeof issueOnly.listIssues).toBe("function");
    expect(typeof issueOnly.searchIssues).toBe("function");
    expect(typeof issueOnly.getIssue).toBe("function");
    expect(issueOnly.callGitHubDelegatedRead).toBeUndefined();

    const delegated = createConvexProjectAttachmentLedgerFromEnv(
      hostedFactoryEnv(true),
    );
    expect(typeof delegated.listIssues).toBe("function");
    expect(typeof delegated.searchIssues).toBe("function");
    expect(typeof delegated.getIssue).toBe("function");
    expect(typeof delegated.callGitHubDelegatedRead).toBe("function");
  });

  test("fails factory creation on partial delegated-read enablement before network activity", () => {
    expect(() => createConvexProjectAttachmentLedgerFromEnv({
      CONVEX_URL: "https://fixture.convex.cloud",
      STENSIBLY_SERVICE_SECRET: "private-service-secret",
      STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: "true",
    })).toThrow("STENSIBLY_GITHUB_APP_ID");
  });
});

const factoryPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

function hostedFactoryEnv(
  delegatedReads: boolean,
): Record<string, string> {
  return {
    CONVEX_URL: "https://fixture.convex.cloud",
    STENSIBLY_SERVICE_SECRET: "private-service-secret",
    STENSIBLY_WORKSPACE: "shared-work",
    STENSIBLY_GITHUB_APP_ID: "12345",
    STENSIBLY_GITHUB_APP_PRIVATE_KEY: factoryPrivateKey,
    STENSIBLY_GITHUB_INSTALLATION_ID: "98765",
    STENSIBLY_GITHUB_PROVIDER_PROJECT: "scrapbook",
    STENSIBLY_GITHUB_PROVIDER_REPOSITORY: "teamleaderleo/stensibly",
    STENSIBLY_GITHUB_PROVIDER_ACCOUNT_LOGIN: "teamleaderleo",
    STENSIBLY_GITHUB_API_BASE_URL: "https://api.github.test",
    STENSIBLY_GITHUB_DELEGATED_READS_ENABLED: delegatedReads
      ? "true"
      : "false",
  };
}

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
