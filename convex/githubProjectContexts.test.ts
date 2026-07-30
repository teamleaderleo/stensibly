import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildGitHubIssueContext } from "../src/github-issue-context";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import { compileProjectContract, renderProjectContract } from "../src/project-contract";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-context-test-secret";
const workspace = "test";
const project = "scrapbook";
const attachmentId = "attach_github_context";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex GitHub project context", () => {
  test("replays exactly and keeps newer provider and synchronization evidence current", async () => {
    const t = convexTest(schema, modules);
    const attachment = await acceptAttachment(t);
    const first = issueContext({
      sourceRevision: "issue-r1",
      updatedAt: "2026-07-29T10:00:00.000Z",
      title: "First accepted issue context",
    });
    const initial = await accept(t, attachment, first, {
      observationRef: "github-observation-1",
      observedAt: "2026-07-29T10:05:00.000Z",
    });
    expect(initial).toMatchObject({
      replayed: false,
      record: { outcome: "initial", isCurrent: true },
    });

    const replay = await accept(t, attachment, first, {
      observationRef: "github-observation-1",
      observedAt: "2026-07-29T10:05:00.000Z",
    });
    expect(replay).toEqual({ ...initial, replayed: true });

    const newer = issueContext({
      sourceRevision: "issue-r2",
      updatedAt: "2026-07-29T11:00:00.000Z",
      title: "Newer accepted issue context",
    });
    const updated = await accept(t, attachment, newer, {
      observationRef: "github-observation-2",
      observedAt: "2026-07-29T11:05:00.000Z",
    });
    expect(updated.record).toMatchObject({ outcome: "updated", isCurrent: true });

    const olderProvider = issueContext({
      sourceRevision: "issue-r0",
      updatedAt: "2026-07-29T09:00:00.000Z",
      title: "Delayed older provider context",
    });
    const staleProvider = await accept(t, attachment, olderProvider, {
      observationRef: "github-observation-stale-provider",
      observedAt: "2026-07-29T11:06:00.000Z",
    });
    expect(staleProvider.record).toMatchObject({ outcome: "stale", isCurrent: false });

    const staleSynchronization = await accept(t, attachment, newer, {
      observationRef: "github-observation-stale-sync",
      observedAt: "2026-07-29T11:04:00.000Z",
      syncStatus: "degraded",
      degradedReasonCode: "provider_unavailable",
    });
    expect(staleSynchronization.record).toMatchObject({ outcome: "stale", isCurrent: false });

    const degraded = await accept(t, attachment, newer, {
      observationRef: "github-observation-degraded",
      observedAt: "2026-07-29T11:06:00.000Z",
      syncStatus: "degraded",
      degradedReasonCode: "provider_unavailable",
    });
    expect(degraded.record).toMatchObject({
      outcome: "synchronization_updated",
      isCurrent: true,
      syncStatus: "degraded",
    });

    const recovered = await accept(t, attachment, newer, {
      observationRef: "github-observation-recovered",
      observedAt: "2026-07-29T11:07:00.000Z",
    });
    expect(recovered.record).toMatchObject({
      outcome: "synchronization_updated",
      isCurrent: true,
      syncStatus: "synchronized",
    });

    const current = await t.query(convexApi.githubProjectContexts.getCurrent, {
      serviceSecret,
      workspace,
      project,
      externalId: newer.reference.externalId,
    }) as any;
    expect(current).toMatchObject({
      id: recovered.record.id,
      externalId: newer.reference.externalId,
      isCurrent: true,
      syncStatus: "synchronized",
    });

    const history = await t.query(convexApi.githubProjectContexts.listHistory, {
      serviceSecret,
      workspace,
      project,
      externalId: newer.reference.externalId,
      limit: 50,
    }) as any[];
    expect(history.map((record) => record.outcome)).toEqual([
      "initial",
      "updated",
      "stale",
      "stale",
      "synchronization_updated",
      "synchronization_updated",
    ]);
    expect(history.filter((record) => record.isCurrent)).toHaveLength(1);

    const rows = await t.run(async (ctx) => await ctx.db.query("githubIssueContexts").collect());
    expect(rows).toHaveLength(6);
    expect(rows.filter((record) => record.isCurrent)).toHaveLength(1);
  });

  test("fails closed on altered replay and same-revision changed content", async () => {
    const t = convexTest(schema, modules);
    const attachment = await acceptAttachment(t);
    const first = issueContext({
      sourceRevision: "same-revision",
      updatedAt: "2026-07-29T10:00:00.000Z",
      title: "Original title",
    });
    await accept(t, attachment, first, {
      observationRef: "github-observation-conflict",
      observedAt: "2026-07-29T10:05:00.000Z",
    });

    await expect(accept(t, attachment, first, {
      observationRef: "github-observation-conflict",
      observedAt: "2026-07-29T10:06:00.000Z",
    })).rejects.toThrow("reused with altered content");

    const alteredRevision = issueContext({
      sourceRevision: "same-revision",
      updatedAt: "2026-07-29T10:00:00.000Z",
      title: "Altered title under the same revision",
    });
    await expect(accept(t, attachment, alteredRevision, {
      observationRef: "github-observation-altered-revision",
      observedAt: "2026-07-29T10:07:00.000Z",
    })).rejects.toThrow("source revision same-revision was reused with altered content");

    const rows = await t.run(async (ctx) => await ctx.db.query("githubIssueContexts").collect());
    expect(rows).toHaveLength(1);
  });

  test("isolates workspace and project reads and applies bounded history", async () => {
    const t = convexTest(schema, modules);
    const attachment = await acceptAttachment(t);
    const snapshot = issueContext({
      sourceRevision: "bounded-history",
      updatedAt: "2026-07-29T10:00:00.000Z",
      title: "Bounded history",
    });
    for (let index = 0; index < 4; index += 1) {
      await accept(t, attachment, snapshot, {
        observationRef: `github-observation-history-${index}`,
        observedAt: `2026-07-29T10:0${index + 1}:00.000Z`,
        ...(index % 2 === 1
          ? { syncStatus: "degraded" as const, degradedReasonCode: "provider_unavailable" }
          : {}),
      });
    }

    expect(await t.query(convexApi.githubProjectContexts.listCurrent, {
      serviceSecret,
      workspace: "other",
      project,
      limit: 20,
    })).toEqual([]);
    expect(await t.query(convexApi.githubProjectContexts.listCurrent, {
      serviceSecret,
      workspace,
      project: "other",
      limit: 20,
    })).toEqual([]);

    const history = await t.query(convexApi.githubProjectContexts.listHistory, {
      serviceSecret,
      workspace,
      project,
      externalId: snapshot.reference.externalId,
      limit: 2,
    }) as any[];
    expect(history).toHaveLength(2);
    expect(history.map((record) => record.observationRef)).toEqual([
      "github-observation-history-2",
      "github-observation-history-3",
    ]);
  });
});

async function acceptAttachment(t: ReturnType<typeof convexTest>) {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project,
    repositories: ["teamleaderleo/stensibly"],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect", "propose"],
    approvalRequired: ["merge", "deploy"],
    checks: ["bun test"],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Coordinate accepted GitHub issue context.",
    boundaries: "Keep provider content separate from execution authority.",
    evidenceAndHandoff: "Preserve bounded accepted evidence.",
    escalation: "Escalate missing repository binding.",
  }));
  return await t.mutation(convexApi.projectAttachments.accept, {
    serviceSecret,
    workspace,
    project,
    expectedCurrentSnapshotSha256: null,
    externalId: attachmentId,
    snapshotJson: JSON.stringify(snapshot),
    snapshotSha256: snapshot.snapshotSha256,
    contentSha256: snapshot.source.contentSha256,
    sourcePath: snapshot.source.path,
    sourceRevision: "attachment-r1",
    acceptedBy: "token:operator",
    authorityWidening: false,
  }) as any;
}

function issueContext(input: {
  sourceRevision: string;
  updatedAt: string;
  title: string;
}) {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 564,
    title: input.title,
    body: "This body is hashed but not retained.",
    state: "open",
    labels: ["area:github", "mode:hosted"],
    assignees: ["teamleaderleo"],
    milestone: null,
    relationships: [],
    createdAt: "2026-07-29T09:00:00.000Z",
    updatedAt: input.updatedAt,
    providerNodeId: "I_kwDO_context",
    sourceRevision: input.sourceRevision,
  });
}

async function accept(
  t: ReturnType<typeof convexTest>,
  attachment: any,
  snapshot: ReturnType<typeof issueContext>,
  options: {
    observationRef: string;
    observedAt: string;
    syncStatus?: "synchronized" | "degraded";
    degradedReasonCode?: string | null;
  },
) {
  const instructionSet = instructionSetFor(attachment);
  return await t.mutation(convexApi.githubProjectContexts.accept, {
    serviceSecret,
    workspace,
    project,
    snapshotJson: JSON.stringify(snapshot),
    projectAttachmentId: attachment.id,
    projectAttachmentSnapshotSha256: attachment.snapshotSha256,
    instructionSetJson: JSON.stringify(instructionSet),
    syncStatus: options.syncStatus ?? "synchronized",
    syncCursor: null,
    degradedReasonCode: options.degradedReasonCode ?? null,
    observationRef: options.observationRef,
    observedAt: options.observedAt,
    acceptedBy: "token:operator",
  }) as any;
}

function instructionSetFor(attachment: any) {
  const canonical = {
    version: 1 as const,
    projectAttachmentId: attachment.id as string,
    projectAttachmentSnapshotSha256: attachment.snapshotSha256 as string,
    sources: [{
      path: "AGENTS.md",
      revision: "instructions-r1",
      contentSha256: `sha256:${"b".repeat(64)}`,
    }],
  };
  const sha256 = fingerprintCanonicalRequest(canonical);
  return {
    ...canonical,
    id: `instructions_${sha256.slice("sha256:".length)}`,
    sha256,
  };
}
