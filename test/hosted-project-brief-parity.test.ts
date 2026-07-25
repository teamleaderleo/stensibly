import { afterEach, describe, expect, test } from "bun:test";
import { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { createServerApp } from "../src/server-app.ts";
import { StensiblyStore } from "../src/store.ts";
import { readProjectBrief } from "../site/project-brief.js";

const fixture = {
  workspace: "test",
  project: "scrapbook",
  generatedAt: "2026-07-25T14:00:00.000Z",
  counts: {
    total: 1,
    byStatus: { ready: 1, active: 0, blocked: 0, done: 0, archived: 0 },
    byKind: { task: 1, finding: 0, question: 0, decision: 0, tip: 0, handoff: 0, note: 0 },
  },
  ready: [{
    id: "item_1",
    project: "scrapbook",
    kind: "task",
    title: "Verify hosted parity",
    summary: "The public contract is aligned.",
    status: "ready",
    priority: 80,
    nextAction: "Load the dashboard brief.",
    claimedBy: null,
    claimExpiresAt: null,
    version: 1,
    createdAt: "2026-07-25T13:00:00.000Z",
    updatedAt: "2026-07-25T13:00:00.000Z",
  }],
  active: [],
  blocked: [],
  knowledge: [],
  recentlyCompleted: [],
  recentArtifacts: [{
    id: "artifact_1",
    itemId: "item_1",
    itemTitle: "Verify hosted parity",
    actorId: "agent-1",
    kind: "commit",
    label: "Parity commit",
    uri: "https://github.com/teamleaderleo/stensibly/commit/deadbeef",
    createdAt: "2026-07-25T13:30:00.000Z",
  }],
  activeRuns: [],
  activeReservations: [],
};

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("hosted project brief gateway parity", () => {
  test("passes trusted time and returns a dashboard-compatible public contract", async () => {
    const captured: { args?: Record<string, unknown> } = {};
    const ledger = new ConvexWorkLedger({
      client: {
        query: async (_reference, args) => {
          captured.args = args;
          return fixture;
        },
        mutation: async () => {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "test",
    });

    const before = Date.now();
    const brief = await ledger.getBrief("scrapbook", 10);
    const after = Date.now();
    const capturedArgs = captured.args;
    if (!capturedArgs) throw new Error("Convex query arguments were not captured");

    expect(brief).toBe(fixture);
    expect(capturedArgs).toMatchObject({
      serviceSecret: "service-secret",
      workspace: "test",
      project: "scrapbook",
      limit: 10,
    });
    expect(capturedArgs.now).toBeNumber();
    expect(capturedArgs.now as number).toBeGreaterThanOrEqual(before);
    expect(capturedArgs.now as number).toBeLessThanOrEqual(after);
    expect(readProjectBrief({ brief }, "scrapbook")).toMatchObject({
      project: "scrapbook",
      counts: fixture.counts,
      ready: [expect.objectContaining({ id: "item_1", title: "Verify hosted parity" })],
      recentArtifacts: [expect.objectContaining({ itemId: "item_1", itemTitle: "Verify hosted parity" })],
    });
  });

  test("maps a missing hosted project to the existing REST 404 contract", async () => {
    store = new StensiblyStore(":memory:");
    const ledger = new ConvexWorkLedger({
      client: {
        query: async (_reference, args) => {
          throw new Error(`Project ${String(args.project)} does not exist`);
        },
        mutation: async () => {
          throw new Error("not used");
        },
      },
      serviceSecret: "service-secret",
      workspace: "test",
    });
    const app = createServerApp(store, { ledger });

    const response = await app.request("/api/v1/projects/missing/brief?limit=10");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Project missing does not exist",
      code: "not_found",
    });
  });
});
