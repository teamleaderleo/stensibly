import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachArtifact } from "../src/artifacts.ts";
import { getProjectBrief } from "../src/briefs.ts";
import { NotFoundError, StensiblyStore } from "../src/store.ts";
import { blockWork } from "../src/transitions.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const browserAgent = {
  id: "browser-agent",
  name: "Browser Agent",
  kind: "agent" as const,
};

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("project briefs", () => {
  test("summarizes live work, knowledge, completions, and artifacts", () => {
    const ready = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Add the next useful feature",
      summary: "The basic ledger works.",
      nextAction: "Build the briefing surface.",
      priority: 90,
      actor: leo,
    });
    const active = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Check the MCP client",
      priority: 70,
      actor: leo,
    });
    store.claimItem(active.id, browserAgent, 900);

    const blocked = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Publish a hosted demo",
      priority: 80,
      actor: leo,
    });
    blockWork(store, {
      id: blocked.id,
      actor: leo,
      reason: "Waiting for a deployment target.",
      nextAction: "Choose a host.",
    });

    const decision = store.createItem({
      project: "scrapbook",
      kind: "decision",
      title: "Artifacts remain pointers",
      summary: "The server stores references and provenance only.",
      priority: 40,
      actor: leo,
    });

    const finding = store.createItem({
      project: "scrapbook",
      kind: "finding",
      title: "SQLite WAL supports the local split",
      priority: 30,
      actor: browserAgent,
    });
    store.completeItem(finding.id, browserAgent, "Confirmed through the web and MCP processes.");

    attachArtifact(store, {
      itemId: active.id,
      actor: browserAgent,
      kind: "log",
      label: "MCP test output",
      uri: "file:///tmp/mcp-test-output.txt",
    });

    store.createItem({
      project: "elsewhere",
      kind: "task",
      title: "Stay out of this brief",
      priority: 100,
      actor: leo,
    });

    const brief = getProjectBrief(store, "scrapbook", 10);

    expect(brief.project).toBe("scrapbook");
    expect(brief.counts).toEqual({
      total: 5,
      byStatus: {
        ready: 2,
        active: 1,
        blocked: 1,
        done: 1,
        archived: 0,
      },
      byKind: {
        task: 3,
        finding: 1,
        question: 0,
        decision: 1,
        tip: 0,
        handoff: 0,
        note: 0,
      },
    });
    expect(brief.ready.map((item) => item.id)).toEqual([ready.id, decision.id]);
    expect(brief.active).toEqual([
      expect.objectContaining({ id: active.id, claimedBy: browserAgent.id }),
    ]);
    expect(brief.blocked).toEqual([
      expect.objectContaining({
        id: blocked.id,
        summary: "Waiting for a deployment target.",
        nextAction: "Choose a host.",
      }),
    ]);
    expect(brief.knowledge.map((item) => item.id).sort()).toEqual(
      [decision.id, finding.id].sort(),
    );
    expect(brief.recentlyCompleted).toEqual([
      expect.objectContaining({ id: finding.id, status: "done" }),
    ]);
    expect(brief.recentArtifacts).toEqual([
      expect.objectContaining({
        itemId: active.id,
        itemTitle: "Check the MCP client",
        actorId: browserAgent.id,
        kind: "log",
        label: "MCP test output",
      }),
    ]);
  });

  test("applies the section limit independently", () => {
    for (const priority of [10, 20, 30]) {
      store.createItem({
        project: "scrapbook",
        kind: "task",
        title: `Task ${priority}`,
        priority,
        actor: leo,
      });
    }

    const brief = getProjectBrief(store, "scrapbook", 2);
    expect(brief.counts.total).toBe(3);
    expect(brief.ready.map((item) => item.priority)).toEqual([30, 20]);
  });

  test("rejects unknown projects and invalid limits", () => {
    expect(() => getProjectBrief(store, "missing")).toThrow(NotFoundError);

    store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Create the project",
      priority: 50,
      actor: leo,
    });
    expect(() => getProjectBrief(store, "scrapbook", 0)).toThrow(RangeError);
    expect(() => getProjectBrief(store, "scrapbook", 101)).toThrow(RangeError);
  });
});
