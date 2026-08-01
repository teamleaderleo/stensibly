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

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

test("rejects a corrupted current row before classifying a new source revision", async () => {
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
    updatedAt: string,
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
      updatedAt,
      providerNodeId: "I_teamleaderleo_stensibly_747",
      sourceRevision,
    })),
    instructionSetJson: canonicalRepositoryInstructionSetJson(instructionSet),
    syncStatus: "synchronized",
    syncCursor: `github:cursor:${sourceRevision}`,
    degradedReasonCode: null,
    observationRef,
    observedAt: "2026-08-01T08:10:00.000Z",
    acceptedBy: "cicada",
  });

  await expect(accept(
    "github:issue:747:rev-1",
    "2026-08-01T08:05:00.000Z",
    "github:delivery:747:rev-1",
  )).resolves.toMatchObject({ replayed: false });

  await t.run(async (ctx: any) => {
    const rows = await ctx.db.query("githubProjectContexts").collect();
    expect(rows).toHaveLength(1);
    await ctx.db.patch(rows[0]._id, {
      providerUpdatedAt: Date.parse("2099-01-01T00:00:00.000Z"),
    });
  });

  await expect(accept(
    "github:issue:747:rev-2",
    "2026-08-01T08:06:00.000Z",
    "github:delivery:747:rev-2",
  )).rejects.toThrow();

  await t.run(async (ctx: any) => {
    const rows = await ctx.db.query("githubProjectContexts").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0].isCurrent).toBe(true);
  });
});
