import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import {
  buildAcceptedRepositoryInstructionSet,
  canonicalGitHubIssueContextJson,
  canonicalRepositoryInstructionSetJson,
} from "../src/github-project-context-admission";
import { buildGitHubIssueContext } from "../src/github-issue-context";
import { fingerprintExactText } from "../src/idempotency-request-fingerprint";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-project-context-service-secret";
const acceptRef = makeFunctionReference<"mutation">("githubProjectContexts:accept");
const getCurrentRef = makeFunctionReference<"query">("githubProjectContexts:getCurrent");
const listCurrentRef = makeFunctionReference<"query">("githubProjectContexts:listCurrent");

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

test("rejects a stored row outside the resolved durable workspace and project pair", async () => {
  const fixture = await setupFixture();

  await expect(fixture.accept(
    "github:issue:747:rev-1",
    "github:delivery:747:rev-1",
  )).resolves.toMatchObject({ replayed: false });

  await fixture.t.run(async (ctx: any) => {
    const rows = await ctx.db.query("githubProjectContexts").collect();
    expect(rows).toHaveLength(1);
    await ctx.db.patch(rows[0]._id, {
      workspaceId: fixture.foreignWorkspaceId,
    });
  });

  await expect(fixture.t.query(getCurrentRef, queryArgs({
    externalId: "github:teamleaderleo/stensibly#747",
  }))).rejects.toThrow();
  await expect(fixture.t.query(listCurrentRef, queryArgs({ limit: 20 }))).rejects.toThrow();
  await expect(fixture.accept(
    "github:issue:747:rev-2",
    "github:delivery:747:rev-2",
  )).rejects.toThrow();

  await fixture.t.run(async (ctx: any) => {
    const rows = await ctx.db.query("githubProjectContexts").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(fixture.foreignWorkspaceId);
    expect(rows[0].isCurrent).toBe(true);
  });
});

test("rejects an accepted attachment outside the resolved durable workspace", async () => {
  const fixture = await setupFixture();

  await fixture.t.run(async (ctx: any) => {
    await ctx.db.patch(fixture.attachmentId, {
      workspaceId: fixture.foreignWorkspaceId,
    });
  });

  await expect(fixture.accept(
    "github:issue:747:rev-1",
    "github:delivery:747:rev-1",
  )).rejects.toThrow();

  await fixture.t.run(async (ctx: any) => {
    const rows = await ctx.db.query("githubProjectContexts").collect();
    expect(rows).toHaveLength(0);
    const attachment = await ctx.db.get("projectAttachments", fixture.attachmentId);
    expect(attachment?.workspaceId).toBe(fixture.foreignWorkspaceId);
  });
});

async function setupFixture() {
  const t = convexTest(schema, modules);
  const attachmentBase = {
    format: "stensibly.project-attachment" as const,
    schemaVersion: 1 as const,
    contract: {
      version: 1 as const,
      project: "stensibly",
      repositories: ["teamleaderleo/stensibly"],
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
  const attachmentSnapshotSha256 = fingerprintExactText(
    JSON.stringify(attachmentBase),
  );

  let foreignWorkspaceId: any;
  let attachmentId: any;
  await t.run(async (ctx: any) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_default",
      slug: "default",
      name: "Default",
      createdAt: now,
      updatedAt: now,
    });
    foreignWorkspaceId = await ctx.db.insert("workspaces", {
      externalId: "ws_foreign",
      slug: "foreign",
      name: "Foreign",
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
    attachmentId = await ctx.db.insert("projectAttachments", {
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
      acceptedBy: "ember",
      authorityWidening: false,
      acceptedAt: now,
    });
  });

  const instructionSet = buildAcceptedRepositoryInstructionSet({
    projectAttachmentId: "attach_current",
    projectAttachmentSnapshotSha256: attachmentSnapshotSha256,
    sources: [{
      path: "AGENTS.md",
      revision: "main@current",
      contentSha256: `sha256:${"b".repeat(64)}`,
    }],
  });
  const accept = async (
    sourceRevision: string,
    observationRef: string,
  ) => t.mutation(acceptRef, {
    serviceSecret,
    workspace: "default",
    project: "stensibly",
    snapshotJson: canonicalGitHubIssueContextJson(buildGitHubIssueContext({
      owner: "teamleaderleo",
      repository: "stensibly",
      number: 747,
      title: "Rebuild hosted accepted GitHub context",
      body: "private issue body",
      state: "open",
      stateReason: null,
      labels: [],
      assignees: [],
      milestone: null,
      relationships: [],
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: sourceRevision.endsWith("2")
        ? "2026-08-01T08:06:00.000Z"
        : "2026-08-01T08:05:00.000Z",
      providerNodeId: "I_teamleaderleo_stensibly_747",
      sourceRevision,
    })),
    instructionSetJson: canonicalRepositoryInstructionSetJson(instructionSet),
    syncStatus: "synchronized",
    syncCursor: `github:cursor:${sourceRevision}`,
    degradedReasonCode: null,
    observationRef,
    observedAt: "2026-08-01T08:10:00.000Z",
    acceptedBy: "ember",
  });

  return {
    t,
    accept,
    foreignWorkspaceId,
    attachmentId,
  };
}

function queryArgs(overrides: Record<string, unknown>) {
  return {
    serviceSecret,
    workspace: "default",
    project: "stensibly",
    ...overrides,
  };
}
