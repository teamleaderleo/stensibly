// @ts-nocheck
import { test } from "bun:test";
import { readFileSync } from "node:fs";

function replaceOnce(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first < 0 || source.indexOf(oldValue, first + 1) >= 0) {
    throw new Error(`${label} marker changed`);
  }
  return source.slice(0, first) + newValue + source.slice(first + oldValue.length);
}

test("emit reviewed hosted context repair bundle", () => {
  const schemaSource = readFileSync("convex/schema.ts", "utf8");
  const schemaMarker = "\n\n  actors: defineTable({\n";
  const table = `

  githubProjectContexts: defineTable({
    workspaceId: v.id("workspaces"),
    projectId: v.id("projects"),
    externalId: v.string(),
    issueExternalId: v.string(),
    repositoryFullName: v.string(),
    sourceRevision: v.string(),
    snapshotSha256: v.string(),
    contentSha256: v.string(),
    providerUpdatedAt: v.number(),
    snapshotJson: v.string(),
    projectAttachmentExternalId: v.string(),
    projectAttachmentSnapshotSha256: v.string(),
    instructionSetId: v.string(),
    instructionSetSha256: v.string(),
    instructionSetJson: v.string(),
    syncStatus: v.union(v.literal("synchronized"), v.literal("degraded")),
    syncCursor: v.optional(v.string()),
    degradedReasonCode: v.optional(v.string()),
    observationRef: v.string(),
    observedAt: v.number(),
    acceptedBy: v.string(),
    acceptedAt: v.number(),
    isCurrent: v.boolean(),
    outcome: v.union(
      v.literal("initial"),
      v.literal("updated"),
      v.literal("stale"),
      v.literal("instruction_rebound"),
      v.literal("synchronization_updated"),
    ),
  })
    .index("by_project_observation", ["projectId", "observationRef"])
    .index("by_project_issue_revision", ["projectId", "issueExternalId", "sourceRevision"])
    .index("by_project_issue_current", ["projectId", "issueExternalId", "isCurrent"])
    .index("by_project_current_issue", ["projectId", "isCurrent", "issueExternalId"])
    .index("by_project_issue_accepted", ["projectId", "issueExternalId", "acceptedAt"]),

  actors: defineTable({
`;
  const schema = replaceOnce(schemaSource, schemaMarker, table, "schema");

  const contextSource = readFileSync(
    "test/fixtures/lumen-901-githubProjectContexts.source.txt",
    "utf8",
  );
  const currentMarker = `    const classification = classifyGitHubIssueContextAcceptance(
      current === null
        ? null
        : {
          sourceRevision: current.sourceRevision,
          contentSha256: current.contentSha256,
          providerUpdatedAt: new Date(current.providerUpdatedAt).toISOString(),
          instructionSetId: current.instructionSetId,
          observedAt: new Date(current.observedAt).toISOString(),
        },
      {
`;
  const currentReplacement = `    const admittedCurrent = current === null
      ? null
      : admitStoredRecord(current, workspaceSlug, projectSlug);
    const classification = classifyGitHubIssueContextAcceptance(
      admittedCurrent === null
        ? null
        : {
          sourceRevision: admittedCurrent.sourceRevision,
          contentSha256: admittedCurrent.contentSha256,
          providerUpdatedAt: admittedCurrent.providerUpdatedAt,
          instructionSetId: admittedCurrent.instructionSetId,
          observedAt: admittedCurrent.observedAt,
        },
      {
`;
  const context = replaceOnce(
    contextSource,
    currentMarker,
    currentReplacement,
    "current row",
  );
  const currentRowTest = readFileSync(
    "test/fixtures/lumen-901-current-row.test.txt",
    "utf8",
  );
  const bundle = Buffer.from(
    JSON.stringify({ schema, context, currentRowTest }),
    "utf8",
  ).toString("base64");
  console.log(`LUMEN901_ARTIFACT_BASE64=${bundle}`);
  throw new Error("intentional diagnostics carrier failure");
});
