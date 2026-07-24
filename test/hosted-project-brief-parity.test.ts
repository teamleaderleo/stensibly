import { afterEach, describe, expect, test } from "bun:test";
import { ConvexWorkLedger } from "../src/convex-ledger.ts";
import { createServerApp } from "../src/server-app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";
import { readProjectBrief } from "../site/project-brief.js";

const fixture = {
  workspace: "test",
  project: "scrapbook",
  generatedAt: "2026-07-24T23:00:00.000Z",
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
    createdAt: "2026-07-24T22:00:00.000Z",
    updatedAt: "2026-07-24T22:00:00.000Z",
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
    createdAt: "2026-07-24T22:30:00.000Z",
  }],
  activeRuns: [],
  activeReservations: [],
};

const emptyFixture = {
  workspace: null,
  project: "missing",
  generatedAt: "2026-07-24T23:00:00.000Z",
  counts: {
    total: 0,
    byStatus: { ready: 0, active: 0, blocked: 0, done: 0, archived: 0 },
    byKind: { task: 0, finding: 0, question: 0, decision: 0, tip: 0, handoff: 0, note: 0 },
  },
  ready: [],
  active: [],
  blocked: [],
  knowledge: [],
  recentlyCompleted: [],
  recentArtifacts: [],
  activeRuns: [],
  activeReservations: [],
};

let store: StensiblyStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

describe("hosted project brief gateway parity", () => {
  test("passes the hosted result through the public ledger and dashboard parser", async () => {
    const ledger = convexLedgerReturning(fixture);
    const brief = await ledger.getBrief("scrapbook", 10);
    expect(brief).toBe(fixture);
    expect(readProjectBrief({ brief }, "scrapbook")).toMatchObject({
      project: "scrapbook",
      counts: fixture.counts,
      ready: [expect.objectContaining({ id: "item_1", title: "Verify hosted parity" })],
      recentArtifacts: [expect.objectContaining({ itemId: "item_1", itemTitle: "Verify hosted parity" })],
    });
  });

  test("returns the same empty 200 contract as SQLite for an unknown project", async () => {
    store = new StensiblyStore(":memory:");
    const local = await new SqliteWorkLedger(store).getBrief("missing", 10) as any;
    const hostedLedger = convexLedgerReturning(emptyFixture);
    const app = createServerApp(store, { ledger: hostedLedger });
    const response = await app.request("/api/v1/projects/missing/brief?limit=10");
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.brief).toMatchObject({
      project: local.project,
      counts: local.counts,
      ready: local.ready,
      active: local.active,
      blocked: local.blocked,
      knowledge: local.knowledge,
      recentlyCompleted: local.recentlyCompleted,
      recentArtifacts: local.recentArtifacts,
    });
    expect(readProjectBrief(payload, "missing")).toMatchObject({
      project: "missing",
      counts: emptyFixture.counts,
      ready: [],
      knowledge: [],
      recentArtifacts: [],
    });
  });
});

function convexLedgerReturning(value: unknown) {
  return new ConvexWorkLedger({
    client: {
      query: async () => value,
      mutation: async () => {
        throw new Error("not used");
      },
    },
    serviceSecret: "service-secret",
    workspace: "test",
  });
}
