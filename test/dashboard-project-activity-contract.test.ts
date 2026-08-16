import { describe, expect, test } from "bun:test";
import {
  normalizeActivityProjects,
  readProjectActivity,
} from "../site/project-activity.js";

const loader = await Bun.file(new URL("../site/item-claim.js", import.meta.url)).text();
const controller = await Bun.file(new URL("../site/project-activity-controller.js", import.meta.url)).text();
const helper = await Bun.file(new URL("../site/project-activity.js", import.meta.url)).text();
const declaration = await Bun.file(new URL("../site/project-activity.d.ts", import.meta.url)).text();
const styles = await Bun.file(new URL("../site/project-activity.css", import.meta.url)).text();
const assets = await Bun.file(new URL("../src/dashboard-assets.ts", import.meta.url)).text();

describe("dashboard Project Activity integration", () => {
  test("admits the bounded zero-authority mixed activity response", () => {
    const activity = readProjectActivity(fixture(), "stensibly");
    expect(activity.version).toBe("project-activity/v1");
    expect(activity.project).toBe("stensibly");
    expect(activity.entries.map((entry) => entry.sourceClass)).toEqual([
      "correspondence",
      "orchestrator_activity",
    ]);
    expect(activity.entries.map((entry) => entry.happenedAt)).toEqual([
      "2026-08-16T13:00:00.000Z",
      "2026-08-16T12:00:00.000Z",
    ]);
    expect(activity.sourceCompleteness.correspondence.rejectedCandidates).toBe(0);
  });

  test("rejects project escape, future evidence, authority drift, and completeness disagreement", () => {
    const foreign = fixture();
    foreign.activity.entries[0].project = "other";
    expect(() => readProjectActivity(foreign, "stensibly")).toThrow("escaped the project boundary");

    const future = fixture();
    future.activity.entries[0].happenedAt = "2026-08-16T15:00:00.000Z";
    expect(() => readProjectActivity(future, "stensibly")).toThrow("after the response observation time");

    const authority = fixture();
    authority.activity.entries[0].authorizesMutation = true;
    expect(() => readProjectActivity(authority, "stensibly")).toThrow("mutation authority");

    const partial = fixture();
    partial.activity.completeness.correspondenceTruncated = true;
    expect(() => readProjectActivity(partial, "stensibly")).toThrow("disagrees with its source envelope");
  });

  test("rejects source-semantic drift and newest-first ordering drift", () => {
    const correspondence = fixture();
    correspondence.activity.entries[0].summary = null;
    expect(() => readProjectActivity(correspondence, "stensibly")).toThrow("correspondence semantics");

    const orchestrator = fixture();
    orchestrator.activity.entries[1].currentness = "current";
    expect(() => readProjectActivity(orchestrator, "stensibly")).toThrow("orchestrator semantics");

    const ordering = fixture();
    ordering.activity.entries.reverse();
    expect(() => readProjectActivity(ordering, "stensibly")).toThrow("newest first");
  });

  test("normalizes only bounded safe visible projects", () => {
    expect(normalizeActivityProjects([
      "stensibly",
      " Stensibly ",
      "stensibly",
      "another-project",
      "stn.tok_secret",
      "bad project",
    ])).toEqual(["another-project", "stensibly"]);
  });

  test("loads as a read-only authenticated dashboard sidecar", () => {
    expect(loader).toContain("import './project-activity-controller.js'");
    expect(controller).toContain("if (typeof document !== 'undefined') installProjectActivityController()");
    expect(controller).toContain("openButton.textContent = 'project activity'");
    expect(controller).toContain("/api/v1/projects/${encodeURIComponent(project)}/activity?limit=30");
    expect(controller).toContain("authorization: `Bearer ${connection.token}`");
    expect(controller).toContain("cache: 'no-store'");
    expect(controller).toContain("const requestId = gate.begin()");
    expect(controller).toContain("gate.invalidate()");
    expect(controller).toContain("gate.isCurrent(requestId)");
    expect(controller).not.toContain("method: 'POST'");
    expect(controller).not.toContain("Idempotency-Key");
    expect(controller).not.toContain("STENSIBLY_SERVICE_SECRET");
    expect(controller).not.toContain("innerHTML");
  });

  test("renders completeness and only explicit relation evidence", () => {
    expect(controller).toContain("Coverage is partial");
    expect(controller).toContain("Causal predecessor");
    expect(controller).toContain("Related");
    expect(controller).toContain("threadsWithoutProviderProjection");
    expect(controller).toContain("providerViewsWithoutMailboxState");
    expect(controller).toContain("rejectedCandidates");
    expect(helper).toContain("fixedFalse(source.containsPrivateReasoning");
    expect(helper).toContain("fixedFalse(source.authorizesMutation");
    expect(helper).toContain("completeness.correspondenceTruncated !== sourceCompleteness.correspondence.truncated");
  });

  test("registers responsive static assets and the browser declaration", () => {
    expect(assets).toContain('path: "/project-activity-controller.js"');
    expect(assets).toContain('path: "/project-activity.js"');
    expect(assets).toContain('path: "/project-activity.css"');
    expect(declaration).toContain("interface ProjectActivity");
    expect(declaration).toContain("sourceClass: 'correspondence' | 'orchestrator_activity'");
    expect(styles).toContain(".project-activity-dialog");
    expect(styles).toContain("@media (max-width: 720px)");
    expect(styles).not.toMatch(/gradient\s*\(/i);
  });
});

function fixture(): any {
  return {
    activity: {
      version: "project-activity/v1",
      projectionFingerprint: `sha256:${"a".repeat(64)}`,
      project: "stensibly",
      asOf: "2026-08-16T14:00:00.000Z",
      entries: [
        {
          entryId: `project_activity:${"b".repeat(64)}`,
          entryFingerprint: `sha256:${"b".repeat(64)}`,
          workspace: "default",
          project: "stensibly",
          sourceClass: "correspondence",
          sourceId: "mail_thread:one",
          sourceFingerprint: `sha256:${"c".repeat(64)}`,
          happenedAt: "2026-08-16T13:00:00.000Z",
          activityClass: "correspondence_changed",
          activityState: "active",
          currentness: "current",
          actorId: "actor:one",
          callsign: "Keel",
          workItemId: null,
          attemptId: null,
          runId: "run:one",
          provider: "gmail",
          summary: "Review requested.",
          nextOrResolution: "Reviewer response.",
          causalPredecessorSourceId: null,
          relatedEvidenceIds: ["mail:one"],
          containsPrivateReasoning: false,
          containsRawProviderBody: false,
          authorizesOperation: false,
          authorizesMutation: false,
          grantsAuthority: false,
          grantsResponsibility: false,
          grantsApproval: false,
        },
        {
          entryId: `project_activity:${"d".repeat(64)}`,
          entryFingerprint: `sha256:${"d".repeat(64)}`,
          workspace: "default",
          project: "stensibly",
          sourceClass: "orchestrator_activity",
          sourceId: "activity:one",
          sourceFingerprint: `sha256:${"e".repeat(64)}`,
          happenedAt: "2026-08-16T12:00:00.000Z",
          activityClass: "completed",
          activityState: "succeeded",
          currentness: "unknown",
          actorId: "actor:two",
          callsign: null,
          workItemId: "work:one",
          attemptId: "attempt:one",
          runId: "run:two",
          provider: null,
          summary: null,
          nextOrResolution: null,
          causalPredecessorSourceId: "activity:previous",
          relatedEvidenceIds: ["ledger:one"],
          containsPrivateReasoning: false,
          containsRawProviderBody: false,
          authorizesOperation: false,
          authorizesMutation: false,
          grantsAuthority: false,
          grantsResponsibility: false,
          grantsApproval: false,
        },
      ],
      completeness: {
        correspondenceTruncated: false,
        orchestratorTruncated: false,
        omittedEntryCount: 0,
      },
      containsPrivateReasoning: false,
      containsRawProviderBody: false,
      authorizesOperation: false,
      authorizesMutation: false,
      grantsAuthority: false,
      grantsResponsibility: false,
      grantsApproval: false,
    },
    sourceCompleteness: {
      correspondence: {
        truncated: false,
        threadsWithoutProviderProjection: 0,
        providerViewsWithoutMailboxState: 0,
        rejectedCandidates: 0,
      },
      orchestrator: { truncated: false },
    },
  };
}
