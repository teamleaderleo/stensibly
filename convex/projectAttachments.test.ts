import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "project-attachment-test-secret";
const workspace = "test";
const project = "scrapbook";
const firstHash = `sha256:${"1".repeat(64)}`;
const secondHash = `sha256:${"2".repeat(64)}`;
const contentHash = `sha256:${"a".repeat(64)}`;

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex project attachments", () => {
  test("stores append-only current records and replays the exact accepted revision", async () => {
    const t = convexTest(schema, modules);
    const first = await accept(t, {
      externalId: "attach_first",
      snapshotSha256: firstHash,
      sourceRevision: "1111111",
      expectedCurrentSnapshotSha256: null,
      authorityWidening: true,
    });
    expect(first).toMatchObject({
      id: "attach_first",
      project,
      snapshotSha256: firstHash,
      sourceRevision: "1111111",
      acceptedBy: "token:operator",
      authorityWidening: true,
    });

    const replay = await accept(t, {
      externalId: "attach_replay_unused",
      snapshotSha256: firstHash,
      sourceRevision: "1111111",
      expectedCurrentSnapshotSha256: firstHash,
      authorityWidening: false,
    });
    expect(replay.id).toBe("attach_first");

    const second = await accept(t, {
      externalId: "attach_second",
      snapshotSha256: secondHash,
      sourceRevision: "2222222",
      expectedCurrentSnapshotSha256: firstHash,
      authorityWidening: false,
    });
    expect(second).toMatchObject({
      id: "attach_second",
      snapshotSha256: secondHash,
      authorityWidening: false,
    });

    expect(await t.query(convexApi.projectAttachments.getCurrent, {
      serviceSecret,
      workspace,
      project,
    })).toEqual(second);

    const rows = await t.run(async (ctx) => await ctx.db
      .query("projectAttachments")
      .collect());
    expect(rows).toHaveLength(2);
  });

  test("rejects stale compare-and-swap imports", async () => {
    const t = convexTest(schema, modules);
    await accept(t, {
      externalId: "attach_first",
      snapshotSha256: firstHash,
      sourceRevision: "1111111",
      expectedCurrentSnapshotSha256: null,
      authorityWidening: true,
    });

    await expect(accept(t, {
      externalId: "attach_stale",
      snapshotSha256: secondHash,
      sourceRevision: "2222222",
      expectedCurrentSnapshotSha256: null,
      authorityWidening: false,
    })).rejects.toThrow("changed while importing");
  });

  test("isolates current attachments by workspace and project", async () => {
    const t = convexTest(schema, modules);
    await accept(t, {
      externalId: "attach_first",
      snapshotSha256: firstHash,
      sourceRevision: "1111111",
      expectedCurrentSnapshotSha256: null,
      authorityWidening: true,
    });

    expect(await t.query(convexApi.projectAttachments.getCurrent, {
      serviceSecret,
      workspace: "other",
      project,
    })).toBeNull();
    expect(await t.query(convexApi.projectAttachments.getCurrent, {
      serviceSecret,
      workspace,
      project: "other",
    })).toBeNull();
  });

  test("rejects snapshot JSON that disagrees with indexed metadata", async () => {
    const t = convexTest(schema, modules);
    await expect(accept(t, {
      externalId: "attach_tampered",
      snapshotSha256: firstHash,
      sourceRevision: "1111111",
      expectedCurrentSnapshotSha256: null,
      authorityWidening: true,
      embeddedProject: "other",
    })).rejects.toThrow("metadata does not match");
  });
});

async function accept(
  t: ReturnType<typeof convexTest>,
  input: {
    externalId: string;
    snapshotSha256: string;
    sourceRevision: string;
    expectedCurrentSnapshotSha256: string | null;
    authorityWidening: boolean;
    embeddedProject?: string;
  },
) {
  const sourcePath = "STENSIBLY.md";
  return await t.mutation(convexApi.projectAttachments.accept, {
    serviceSecret,
    workspace,
    project,
    expectedCurrentSnapshotSha256: input.expectedCurrentSnapshotSha256,
    externalId: input.externalId,
    snapshotJson: JSON.stringify({
      format: "stensibly.project-attachment",
      schemaVersion: 1,
      contract: { project: input.embeddedProject ?? project },
      source: { path: sourcePath, contentSha256: contentHash },
      snapshotSha256: input.snapshotSha256,
    }),
    snapshotSha256: input.snapshotSha256,
    contentSha256: contentHash,
    sourcePath,
    sourceRevision: input.sourceRevision,
    acceptedBy: "token:operator",
    authorityWidening: input.authorityWidening,
  }) as any;
}
