import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { attachArtifact } from "../src/artifacts.ts";
import { compileProjectBrief, getProjectBrief } from "../src/briefs.ts";
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
      expectedClaimGeneration: blocked.claimGeneration,
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
    store.completeItem(
      finding.id,
      browserAgent,
      finding.claimGeneration,
      "Confirmed through the web and MCP processes.",
    );

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

  test("keeps the SQLite adapter claim-expiry transition before projection", () => {
    const active = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Expire this claim before briefing",
      priority: 70,
      actor: leo,
    });
    const claimed = store.claimItem(active.id, browserAgent, 900);
    store.db
      .query("UPDATE items SET claim_expires_at = ?1 WHERE id = ?2")
      .run("2000-01-01T00:00:00.000Z", active.id);

    const brief = getProjectBrief(store, "scrapbook", 10);
    const persisted = store.getItem(active.id);

    expect(brief.active).toEqual([]);
    expect(brief.ready).toEqual([
      expect.objectContaining({
        id: active.id,
        status: "ready",
        claimedBy: null,
        claimExpiresAt: null,
      }),
    ]);
    expect(persisted).toEqual(expect.objectContaining({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: claimed.claimGeneration + 1,
      version: claimed.version + 1,
    }));
  });

  test("compiles a read-only snapshot without expiring or mutating supplied evidence", () => {
    const active = Object.freeze({
      id: "item-active",
      project: "scrapbook",
      kind: "task" as const,
      title: "Retain stale authority evidence",
      summary: null,
      status: "active" as const,
      priority: 80,
      nextAction: "Reconcile the expired claim.",
      claimedBy: "runner-old",
      claimExpiresAt: "2020-01-01T00:00:00.000Z",
      claimGeneration: 7,
      version: 4,
      createdAt: "2019-12-31T23:00:00.000Z",
      updatedAt: "2020-01-01T00:01:00.000Z",
    });
    const ready = Object.freeze({
      id: "item-ready",
      project: "scrapbook",
      kind: "decision" as const,
      title: "Choose the recovery path",
      summary: "The projection does not grant recovery authority.",
      status: "ready" as const,
      priority: 90,
      nextAction: "Review the stale claim evidence.",
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: 0,
      version: 1,
      createdAt: "2020-01-01T00:02:00.000Z",
      updatedAt: "2020-01-01T00:03:00.000Z",
    });
    const items = Object.freeze([active, ready]);
    const artifacts = Object.freeze([
      Object.freeze({
        project: "scrapbook",
        id: "artifact-old",
        itemId: active.id,
        itemTitle: active.title,
        actorId: "runner-old",
        kind: "log" as const,
        label: "Older evidence",
        uri: "artifact://older",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
      Object.freeze({
        project: "scrapbook",
        id: "artifact-new",
        itemId: active.id,
        itemTitle: active.title,
        actorId: "runner-old",
        kind: "log" as const,
        label: "Newest evidence",
        uri: "artifact://newest",
        createdAt: "2020-01-01T00:04:00.000Z",
      }),
    ]);

    const brief = compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2020-01-01T00:05:00.000Z",
      items,
      recentArtifacts: artifacts,
      limit: 1,
    });

    expect(brief.generatedAt).toBe("2020-01-01T00:05:00.000Z");
    expect(brief.counts.total).toBe(2);
    expect(brief.ready.map((item) => item.id)).toEqual([ready.id]);
    expect(brief.active).toEqual([
      expect.objectContaining({
        id: active.id,
        status: "active",
        claimedBy: "runner-old",
        claimExpiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    expect(brief.recentArtifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-new",
    ]);
    expect(brief.recentArtifacts[0]).not.toHaveProperty("project");
    expect(items).toEqual([active, ready]);
    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "artifact-old",
      "artifact-new",
    ]);
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(artifacts)).toBe(true);
  });

  test("rejects foreign-project items and artifacts before compiling a mixed projection", () => {
    const foreign = Object.freeze({
      id: "item-foreign",
      project: "elsewhere",
      kind: "task" as const,
      title: "Do not leak this item",
      summary: null,
      status: "ready" as const,
      priority: 100,
      nextAction: null,
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: 0,
      version: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });

    expect(() => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2020-01-01T00:00:00.000Z",
      items: [foreign],
      recentArtifacts: [],
    })).toThrow("items must belong to the requested project");

    expect(() => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2020-01-01T00:00:00.000Z",
      items: [],
      recentArtifacts: [{
        project: "elsewhere",
        id: "artifact-foreign",
        itemId: "item-foreign",
        itemTitle: "Do not leak this artifact",
        actorId: "runner-foreign",
        kind: "log",
        label: "Foreign evidence",
        uri: "artifact://foreign",
        createdAt: "2020-01-01T00:00:00.000Z",
      }],
    })).toThrow("artifacts must belong to the requested project");
  });

  test("binds artifact identity and titles to supplied project items", () => {
    const item = Object.freeze({
      id: "item-bound",
      project: "scrapbook",
      kind: "task" as const,
      title: "Bound item title",
      summary: null,
      status: "ready" as const,
      priority: 50,
      nextAction: null,
      claimedBy: null,
      claimExpiresAt: null,
      claimGeneration: 0,
      version: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const artifact = Object.freeze({
      project: "scrapbook",
      id: "artifact-bound",
      itemId: item.id,
      itemTitle: item.title,
      actorId: "runner-bound",
      kind: "log" as const,
      label: "Bound evidence",
      uri: "artifact://bound",
      createdAt: "2020-01-01T00:01:00.000Z",
    });
    type BriefInput = Parameters<typeof compileProjectBrief>[0];
    const compile = (
      items: BriefInput["items"],
      recentArtifacts: BriefInput["recentArtifacts"],
    ) => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2020-01-01T00:02:00.000Z",
      items,
      recentArtifacts,
    });

    expect(() => compile([item], [{
      ...artifact,
      itemId: "item-missing",
    }])).toThrow("must reference a supplied project item");

    expect(() => compile([item], [{
      ...artifact,
      itemTitle: "Substituted public title",
    }])).toThrow("item titles must match supplied items");

    expect(() => compile([item, {
      ...item,
      title: "Duplicate item identity",
    }], [artifact])).toThrow("item IDs must be unique");

    expect(() => compile([item], [artifact, {
      ...artifact,
      itemId: item.id,
      itemTitle: item.title,
      label: "Duplicate artifact identity",
    }])).toThrow("artifact IDs must be unique");
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
    expect(() => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2020-01-01T00:00:00.000Z",
      items: [],
      recentArtifacts: [],
      limit: 0,
    })).toThrow(RangeError);
    expect(() => compileProjectBrief({
      project: "scrapbook",
      generatedAt: "2020-01-01T00:00:00Z",
      items: [],
      recentArtifacts: [],
    })).toThrow("canonical UTC timestamp");
  });
});