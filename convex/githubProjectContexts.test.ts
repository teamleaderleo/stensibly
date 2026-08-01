import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
} from "../src/github-project-context-admission";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import { buildGitHubIssueContext } from "../src/github-issue-context";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-project-context-service-secret";
const acceptRef = makeFunctionReference<"mutation">("githubProjectContexts:accept");
const getCurrentRef = makeFunctionReference<"query">("githubProjectContexts:getCurrent");
const listCurrentRef = makeFunctionReference<"query">("githubProjectContexts:listCurrent");
const listHistoryRef = makeFunctionReference<"query">("githubProjectContexts:listHistory");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("hosted accepted GitHub project context", () => {
  test("accepts one generation, replays exactly, and projects current/history", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const first = input();
    const accepted = await t.mutation(acceptRef, first) as any;
    expect(accepted).toMatchObject({
      replayed: false,
      record: {
        externalId: "github:teamleaderleo/stensibly#747",
        repositoryFullName: "teamleaderleo/stensibly",
        outcome: "initial",
        isCurrent: true,
      },
    });
    expect(await t.mutation(acceptRef, first)).toMatchObject({
      replayed: true,
      record: { id: accepted.record.id },
    });
    expect(await t.query(getCurrentRef, queryArgs({
      externalId: "github:teamleaderleo/stensibly#747",
    }))).toMatchObject({ id: accepted.record.id });
    expect(await t.query(listCurrentRef, queryArgs({ limit: 20 }))).toHaveLength(1);
    expect(await t.query(listHistoryRef, queryArgs({
      externalId: "github:teamleaderleo/stensibly#747",
      limit: 10,
    }))).toHaveLength(1);
  });

  test("checks observation staleness before instruction rebound", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    await t.mutation(acceptRef, input());
    const stale = await t.mutation(acceptRef, input({
      instructionRevision: "main@new",
      observationRef: "github:delivery:747:older",
      observedAt: "2026-07-31T16:09:59.000Z",
    })) as any;
    expect(stale.record).toMatchObject({ outcome: "stale", isCurrent: false });
    const current = await t.query(getCurrentRef, queryArgs({
      externalId: "github:teamleaderleo/stensibly#747",
    })) as any;
    expect(current.observationRef).toBe("github:delivery:747:first");

    const rebound = await t.mutation(acceptRef, input({
      instructionRevision: "main@new",
      observationRef: "github:delivery:747:newer",
      observedAt: "2026-07-31T16:10:01.000Z",
    })) as any;
    expect(rebound.record).toMatchObject({
      outcome: "instruction_rebound",
      isCurrent: true,
    });
    const history = await t.query(listHistoryRef, queryArgs({
      externalId: "github:teamleaderleo/stensibly#747",
      limit: 10,
    })) as any[];
    expect(history.map((row) => row.outcome).sort()).toEqual([
      "initial",
      "instruction_rebound",
      "stale",
    ]);
    expect(history.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(history.find((row) => row.isCurrent)?.outcome)
      .toBe("instruction_rebound");
  });

  test("rejects altered observation and source-revision reuse", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    await t.mutation(acceptRef, input());
    await expect(t.mutation(acceptRef, input({
      syncStatus: "degraded",
      degradedReasonCode: "missed_delivery",
    }))).rejects.toThrow("GITHUB_PROJECT_CONTEXT_OBSERVATION_CONFLICT");

    await expect(t.mutation(acceptRef, input({
      observationRef: "github:delivery:747:altered",
      title: "Altered title under one revision",
    }))).rejects.toThrow("GITHUB_PROJECT_CONTEXT_SOURCE_REVISION_CONFLICT");
  });

  test("re-admits stored JSON before returning it", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    const accepted = await t.mutation(acceptRef, input()) as any;
    await t.run(async (ctx: any) => {
      const projectId = await awaitProjectId(ctx);
      const row = await ctx.db
        .query("githubProjectContexts")
        .withIndex("by_project_observation", (q: any) =>
          q.eq("projectId", projectId).eq("observationRef", "github:delivery:747:first")
        )
        .unique();
      const decoded = JSON.parse(row.snapshotJson);
      decoded.milestone.secret = "private durable prose";
      await ctx.db.patch(row._id, { snapshotJson: JSON.stringify(decoded) });
    });
    await expect(t.query(getCurrentRef, queryArgs({
      externalId: accepted.record.externalId,
    }))).rejects.toThrow();
  });

  test("keeps one current row under concurrent accepted generations", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t);
    await Promise.all([
      t.mutation(acceptRef, input({
        observationRef: "github:delivery:747:a",
        observedAt: "2026-07-31T16:10:01.000Z",
      })),
      t.mutation(acceptRef, input({
        observationRef: "github:delivery:747:b",
        observedAt: "2026-07-31T16:10:02.000Z",
      })),
    ]);
    const current = await t.query(listCurrentRef, queryArgs({ limit: 20 })) as any[];
    expect(current).toHaveLength(1);
    const history = await t.query(listHistoryRef, queryArgs({
      externalId: "github:teamleaderleo/stensibly#747",
      limit: 10,
    })) as any[];
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.isCurrent)).toHaveLength(1);
  });

  test("requires project attachment, repository, workspace, and service binding", async () => {
    const t = convexTest(schema, modules);
    await seedProject(t, "other/repository");
    await expect(t.mutation(acceptRef, input({
      projectAttachmentSnapshotSha256: attachmentSnapshotSha256For(
        "other/repository",
      ),
    }))).rejects.toThrow(
      "is not declared by the accepted project attachment",
    );
    await expect(t.mutation(acceptRef, {
      ...input(),
      serviceSecret: "wrong",
    })).rejects.toThrow("Unauthorized");
  });
});

function input(overrides: {
  instructionRevision?: string;
  observationRef?: string;
  observedAt?: string;
  title?: string;
  syncStatus?: "synchronized" | "degraded";
  degradedReasonCode?: string | null;
  projectAttachmentSnapshotSha256?: string;
} = {}) {
  const snapshot = buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 747,
    title: overrides.title ?? "Rebuild hosted accepted GitHub context",
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
    projectAttachmentSnapshotSha256: overrides.projectAttachmentSnapshotSha256
      ?? attachmentSnapshotSha256For("teamleaderleo/stensibly"),
    sources: [{
      path: "AGENTS.md",
      revision: overrides.instructionRevision ?? "main@current",
      contentSha256: `sha256:${"b".repeat(64)}`,
    }, {
      path: "STENSIBLY.md",
      revision: overrides.instructionRevision ?? "main@current",
      contentSha256: `sha256:${"c".repeat(64)}`,
    }],
  });
  const syncStatus = overrides.syncStatus ?? "synchronized";
  return {
    serviceSecret,
    workspace: "default",
    project: "stensibly",
    snapshotJson: canonicalGitHubIssueContextJson(snapshot),
    instructionSetJson: canonicalRepositoryInstructionSetJson(instructionSet),
    syncStatus,
    syncCursor: "github:cursor:747",
    degradedReasonCode: overrides.degradedReasonCode
      ?? (syncStatus === "degraded" ? "missed_delivery" : null),
    observationRef: overrides.observationRef ?? "github:delivery:747:first",
    observedAt: overrides.observedAt ?? "2026-07-31T16:10:00.000Z",
    acceptedBy: "plover",
  };
}

function attachmentSnapshotSha256For(repository: string): string {
  return fingerprintCanonicalRequest({
    format: "stensibly.project-attachment",
    schemaVersion: 1,
    contract: {
      version: 1,
      project: "stensibly",
      repositories: [repository],
      runnerProfiles: [],
      concurrency: { project: 1, global: 1 },
      autonomousActions: [],
      approvalRequired: [],
      checks: [],
      tags: [],
      relatedProjects: [],
    },
    context: {
      goal: "Test accepted GitHub context",
      boundaries: "No external effects",
      evidenceAndHandoff: "Retain exact test evidence",
      escalation: "Fail closed",
    },
    source: {
      path: "STENSIBLY.md",
      contentSha256: `sha256:${"d".repeat(64)}`,
    },
  });
}

function queryArgs(overrides: Record<string, unknown>) {
  return {
    serviceSecret,
    workspace: "default",
    project: "stensibly",
    ...overrides,
  };
}

async function seedProject(
  t: ReturnType<typeof convexTest>,
  repository = "teamleaderleo/stensibly",
) {
  await t.run(async (ctx: any) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      workspaceId,
      externalId: "project_stensibly",
      slug: "stensibly",
      name: "Stensibly",
      createdAt: now,
      updatedAt: now,
    });
    const attachmentBase = {
      format: "stensibly.project-attachment" as const,
      schemaVersion: 1 as const,
      contract: {
        version: 1 as const,
        project: "stensibly",
        repositories: [repository],
        runnerProfiles: [],
        concurrency: { project: 1, global: 1 },
        autonomousActions: [],
        approvalRequired: [],
        checks: [],
        tags: [],
        relatedProjects: [],
      },
      context: {
        goal: "Test accepted GitHub context",
        boundaries: "No external effects",
        evidenceAndHandoff: "Retain exact test evidence",
        escalation: "Fail closed",
      },
      source: {
        path: "STENSIBLY.md",
        contentSha256: `sha256:${"d".repeat(64)}`,
      },
    };
    const attachmentSnapshotSha256 = fingerprintCanonicalRequest(attachmentBase);
    expect(attachmentSnapshotSha256).toBe(attachmentSnapshotSha256For(repository));
    await ctx.db.insert("projectAttachments", {
      workspaceId,
      projectId,
      externalId: "attach_current",
      snapshotJson: JSON.stringify({
        ...attachmentBase,
        snapshotSha256: attachmentSnapshotSha256,
      }),
      snapshotSha256: attachmentSnapshotSha256,
      contentSha256: attachmentBase.source.contentSha256,
      sourcePath: "STENSIBLY.md",
      sourceRevision: "main@current",
      acceptedBy: "plover",
      authorityWidening: false,
      acceptedAt: now,
    });
  });
}

async function awaitProjectId(ctx: any) {
  const workspace = await ctx.db.query("workspaces").withIndex(
    "by_slug",
    (q: any) => q.eq("slug", "default"),
  ).unique();
  const project = await ctx.db.query("projects").withIndex(
    "by_workspace_slug",
    (q: any) => q.eq("workspaceId", workspace._id).eq("slug", "stensibly"),
  ).unique();
  return project._id;
}
