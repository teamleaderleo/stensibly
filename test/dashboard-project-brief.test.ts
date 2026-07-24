import { describe, expect, test } from "bun:test";
import {
  normalizeBriefProjects,
  readProjectBrief,
  safeBriefArtifactHref,
} from "../site/project-brief.js";

const item = {
  id: "item_1",
  kind: "task",
  title: "Ship the dashboard",
  status: "ready",
  priority: 80,
  summary: "Core flow is working.",
  nextAction: "Run the clean-browser check.",
  claimedBy: null,
  claimExpiresAt: null,
  updatedAt: "2026-07-24T22:00:00.000Z",
};

function payload() {
  return {
    brief: {
      project: "scrapbook",
      generatedAt: "2026-07-24T22:01:00.000Z",
      counts: {
        total: 3,
        byStatus: { ready: 1, active: 1, blocked: 0, done: 1, archived: 0 },
        byKind: { task: 2, finding: 1, question: 0, decision: 0, tip: 0, handoff: 0, note: 0 },
      },
      ready: [item],
      active: [{ ...item, id: "item_2", status: "active", claimedBy: "agent-1", claimExpiresAt: "2026-07-24T23:00:00.000Z" }],
      blocked: [],
      knowledge: [{ ...item, id: "item_3", kind: "finding", status: "done" }],
      recentlyCompleted: [{ ...item, id: "item_3", kind: "finding", status: "done" }],
      recentArtifacts: [{
        id: "artifact_1",
        itemId: "item_3",
        itemTitle: "Ship the dashboard",
        actorId: "agent-1",
        kind: "commit",
        label: "Implementation commit",
        uri: "https://github.com/teamleaderleo/stensibly/commit/deadbeef",
        createdAt: "2026-07-24T22:00:30.000Z",
      }],
    },
  };
}

describe("dashboard project brief contract", () => {
  test("projects a bounded known response", () => {
    const brief = readProjectBrief(payload(), "scrapbook");
    expect(brief.project).toBe("scrapbook");
    expect(brief.counts.total).toBe(3);
    expect(brief.ready[0]).toEqual(item);
    expect(brief.active[0]).toMatchObject({ status: "active", claimedBy: "agent-1" });
    expect(brief.recentArtifacts[0]).toMatchObject({ kind: "commit", actorId: "agent-1" });
  });

  test("rejects project, count, section, timestamp, and credential mismatches", () => {
    expect(() => readProjectBrief(payload(), "other")).toThrow(/different project brief/);
    expect(() => readProjectBrief({ ...payload(), brief: { ...payload().brief, project: "Bad Project" } })).toThrow(/invalid project slug/);
    expect(() => readProjectBrief({ ...payload(), brief: { ...payload().brief, generatedAt: "not-a-date" } })).toThrow(/generated time/);
    expect(() => readProjectBrief({ ...payload(), brief: { ...payload().brief, counts: { ...payload().brief.counts, total: -1 } } })).toThrow(/total count/);
    expect(() => readProjectBrief({ ...payload(), brief: { ...payload().brief, ready: [{ ...item, status: "blocked" }] } })).toThrow(/outside the ready section/);
    expect(() => readProjectBrief({ ...payload(), brief: { ...payload().brief, ready: [{ ...item, title: "stn.tok_secret" }] } })).toThrow(/Credential-shaped/);
    expect(() => readProjectBrief({ ...payload(), brief: { ...payload().brief, recentArtifacts: Array.from({ length: 101 }, () => payload().brief.recentArtifacts[0]) } })).toThrow(/too many artifacts/);
  });

  test("normalizes only visible safe project slugs", () => {
    expect(normalizeBriefProjects([" beta ", "alpha", "alpha", "Bad Project", "stn.tok_secret", null])).toEqual(["alpha", "beta"]);
    expect(normalizeBriefProjects(null)).toEqual([]);
  });

  test("allows only explicit HTTP and HTTPS artifact links", () => {
    expect(safeBriefArtifactHref("https://example.com/report")).toBe("https://example.com/report");
    expect(safeBriefArtifactHref("http://example.com/report")).toBe("http://example.com/report");
    expect(safeBriefArtifactHref("git:repo@deadbeef")).toBe("");
    expect(safeBriefArtifactHref("javascript:alert(1)")).toBe("");
    expect(safeBriefArtifactHref("https://example.com/stn.tok_secret")).toBe("");
  });
});
