import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
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

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

test("rejects repository authority from a hash-inconsistent attachment row", async () => {
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
  const attachmentSnapshotSha256 = fingerprintCanonicalRequest(attachmentBase);

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
    const attachmentId = await ctx.db.insert("projectAttachments", {
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

    const corrupted = {
      ...attachmentBase,
      contract: {
        ...attachmentBase.contract,
        repositories: [
          "teamleaderleo/stensibly",
          "outside/repository",
        ],
      },
      snapshotSha256: attachmentSnapshotSha256,
    };
    await ctx.db.patch(attachmentId, {
      snapshotJson: JSON.stringify(corrupted),
    });
  });

  const snapshot = buildGitHubIssueContext({
    owner: "outside",
    repository: "repository",
    number: 1,
    title: "Untrusted repository context",
    body: "private issue body",
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    milestone: null,
    relationships: [],
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T08:05:00.000Z",
    providerNodeId: "I_outside_repository_1",
    sourceRevision: "github:issue:outside/repository:1:rev-1",
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

  await expect(t.mutation(acceptRef, {
    serviceSecret,
    workspace: "default",
    project: "stensibly",
    snapshotJson: canonicalGitHubIssueContextJson(snapshot),
    instructionSetJson: canonicalRepositoryInstructionSetJson(instructionSet),
    syncStatus: "synchronized",
    syncCursor: "github:cursor:outside:1",
    degradedReasonCode: null,
    observationRef: "github:delivery:outside:1",
    observedAt: "2026-08-01T08:10:00.000Z",
    acceptedBy: "cicada",
  })).rejects.toThrow();
});
