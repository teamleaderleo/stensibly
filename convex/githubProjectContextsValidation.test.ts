import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildGitHubIssueContext } from "../src/github-issue-context";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import { compileProjectContract, renderProjectContract } from "../src/project-contract";
import { convexApi } from "./refs";
import schema from "./schema";
import { modules } from "./test.setup";

const serviceSecret = "github-context-validation-secret";
const workspace = "test";
const project = "scrapbook";

beforeEach(() => {
  vi.stubEnv("STENSIBLY_SERVICE_SECRET", serviceSecret);
});

describe("Convex GitHub context validation", () => {
  test("rejects a self-consistent snapshot containing a raw issue body", async () => {
    const t = convexTest(schema, modules);
    const attachment = await acceptAttachment(t);
    const canonical = issueContext();
    const {
      snapshotSha256: _snapshotSha256,
      contentSha256: _contentSha256,
      sourceRevision,
      ...canonicalContent
    } = canonical;
    const content = {
      ...canonicalContent,
      body: "raw provider body must never enter hosted storage",
    };
    const contentSha256 = fingerprintCanonicalRequest(content);
    const snapshot = {
      ...content,
      sourceRevision,
      contentSha256,
      snapshotSha256: fingerprintCanonicalRequest({ ...content, sourceRevision, contentSha256 }),
    };

    await expect(accept(t, attachment, snapshot, "raw-body-observation"))
      .rejects.toThrow("only canonical bounded fields");
    const rows = await t.run(async (ctx) => await ctx.db.query("githubIssueContexts").collect());
    expect(rows).toEqual([]);
  });

  test("rejects self-consistent non-canonical GitHub owners and timestamps", async () => {
    const t = convexTest(schema, modules);
    const attachment = await acceptAttachment(t);
    const invalidOwner = rehash({
      ...issueContext(),
      reference: {
        ...issueContext().reference,
        owner: "invalid_owner",
        repositoryFullName: "invalid_owner/stensibly",
        externalId: "github:invalid_owner/stensibly#564",
        canonicalUrl: "https://github.com/invalid_owner/stensibly/issues/564",
      },
    });
    await expect(accept(t, attachment, invalidOwner, "invalid-owner-observation"))
      .rejects.toThrow("GitHub owner identity is invalid");

    const invalidTime = rehash({
      ...issueContext(),
      updatedAt: "July 29, 2026 14:00 UTC",
    });
    await expect(accept(t, attachment, invalidTime, "invalid-time-observation"))
      .rejects.toThrow("must be an ISO timestamp");
  });

  test("derives a stable bounded record ID from the scoped observation", async () => {
    const t = convexTest(schema, modules);
    const attachment = await acceptAttachment(t);
    const snapshot = issueContext();
    const first = await accept(t, attachment, snapshot, "stable-observation");
    const replay = await accept(t, attachment, snapshot, "stable-observation");

    expect(first.record.id).toMatch(/^github_context_[a-f0-9]{64}$/);
    expect(replay).toEqual({ ...first, replayed: true });
    const rows = await t.run(async (ctx) => await ctx.db.query("githubIssueContexts").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe(first.record.id);
  });
});

function issueContext() {
  return buildGitHubIssueContext({
    owner: "teamleaderleo",
    repository: "stensibly",
    number: 564,
    title: "Hosted GitHub issue context validation",
    body: "This body is hashed and omitted by the canonical builder.",
    state: "open",
    labels: ["mode:hosted"],
    assignees: ["teamleaderleo"],
    relationships: [],
    createdAt: "2026-07-29T13:00:00.000Z",
    updatedAt: "2026-07-29T14:00:00.000Z",
    sourceRevision: "issue-564-validation-r1",
  });
}

function rehash(value: object): Record<string, unknown> {
  const raw = value as Record<string, unknown>;
  const {
    snapshotSha256: _snapshotSha256,
    contentSha256: _contentSha256,
    sourceRevision,
    ...content
  } = raw;
  const contentSha256 = fingerprintCanonicalRequest(content);
  return {
    ...content,
    sourceRevision,
    contentSha256,
    snapshotSha256: fingerprintCanonicalRequest({ ...content, sourceRevision, contentSha256 }),
  };
}

async function acceptAttachment(t: ReturnType<typeof convexTest>) {
  const snapshot = compileProjectContract(renderProjectContract({
    version: 1,
    project,
    repositories: ["teamleaderleo/stensibly"],
    runnerProfiles: ["codex-default"],
    concurrency: { project: 1, global: 1 },
    autonomousActions: ["inspect"],
    approvalRequired: ["merge"],
    checks: ["bun test"],
    tags: [],
    relatedProjects: [],
  }, {
    goal: "Validate bounded hosted context.",
    boundaries: "Reject raw provider content.",
    evidenceAndHandoff: "Preserve only canonical fingerprints.",
    escalation: "Fail closed on non-canonical snapshots.",
  }));
  return await t.mutation(convexApi.projectAttachments.accept, {
    serviceSecret,
    workspace,
    project,
    expectedCurrentSnapshotSha256: null,
    externalId: "attach_validation",
    snapshotJson: JSON.stringify(snapshot),
    snapshotSha256: snapshot.snapshotSha256,
    contentSha256: snapshot.source.contentSha256,
    sourcePath: snapshot.source.path,
    sourceRevision: "attachment-validation-r1",
    acceptedBy: "token:operator",
    authorityWidening: false,
  }) as any;
}

async function accept(
  t: ReturnType<typeof convexTest>,
  attachment: any,
  snapshot: unknown,
  observationRef: string,
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
    syncStatus: "synchronized",
    syncCursor: null,
    degradedReasonCode: null,
    observationRef,
    observedAt: "2026-07-29T14:05:00.000Z",
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
      revision: "instructions-validation-r1",
      contentSha256: `sha256:${"c".repeat(64)}`,
    }],
  };
  const sha256 = fingerprintCanonicalRequest(canonical);
  return {
    ...canonical,
    id: `instructions_${sha256.slice("sha256:".length)}`,
    sha256,
  };
}
