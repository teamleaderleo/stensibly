import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inspectScrapbook, reportHasFindings } from "../src/custodian-report.ts";
import { StensiblyStore } from "../src/store.ts";
import { blockWork } from "../src/transitions.ts";

const leo = { id: "leo", name: "Leo", kind: "human" as const };
const agent = { id: "agent", name: "Agent", kind: "agent" as const };

let store: StensiblyStore;

beforeEach(() => {
  store = new StensiblyStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("custodian report", () => {
  test("reports elapsed leases, upcoming expiry, missing next actions, staleness, and duplicate titles", () => {
    const expired = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Expired lease",
      nextAction: "Resume after reconciliation.",
      priority: 80,
      actor: leo,
    });
    store.claimItem(expired.id, agent, 60);
    store.db.query("UPDATE items SET claim_expires_at = ?1 WHERE id = ?2")
      .run("2026-03-05T23:50:00.000Z", expired.id);

    const expiring = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Lease near expiry",
      nextAction: "Renew or hand off.",
      priority: 70,
      actor: leo,
    });
    store.claimItem(expiring.id, agent, 60);
    store.db.query("UPDATE items SET claim_expires_at = ?1 WHERE id = ?2")
      .run("2026-03-06T00:04:00.000Z", expiring.id);

    const missingNext = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Needs a next action",
      priority: 60,
      actor: leo,
    });

    const staleReady = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Stale ready work",
      nextAction: "Reassess this.",
      priority: 50,
      actor: leo,
    });

    const blocked = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Waiting forever",
      nextAction: "Check the dependency.",
      priority: 40,
      actor: leo,
    });
    blockWork(store, {
      id: blocked.id,
      actor: leo,
      expectedClaimGeneration: blocked.claimGeneration,
      reason: "The dependency never arrived.",
      nextAction: "Check the dependency.",
    });

    const duplicateOne = store.createItem({
      project: "scrapbook",
      kind: "finding",
      title: "Same Weird Thing!",
      priority: 30,
      actor: leo,
    });
    const duplicateTwo = store.createItem({
      project: "scrapbook",
      kind: "note",
      title: "same weird thing",
      priority: 20,
      actor: leo,
    });
    store.createItem({
      project: "elsewhere",
      kind: "task",
      title: "Do not include me",
      priority: 100,
      actor: leo,
    });

    for (const item of [staleReady, blocked]) {
      store.db.query("UPDATE items SET updated_at = ?1 WHERE id = ?2")
        .run("2026-02-01T00:00:00.000Z", item.id);
    }

    const report = inspectScrapbook(store, {
      project: "scrapbook",
      staleDays: 7,
      expiringWithinMinutes: 5,
      now: new Date("2026-03-06T00:00:00.000Z"),
    });

    expect(report.expiredClaimIds).toEqual([expired.id]);
    expect(store.getItem(expired.id)).toMatchObject({
      status: "active",
      claimedBy: agent.id,
      claimExpiresAt: "2026-03-05T23:50:00.000Z",
    });
    expect(report.expiringClaims.map((item) => item.id)).toEqual([expiring.id]);
    expect(report.missingNextActions.map((item) => item.id)).toEqual([
      missingNext.id,
      duplicateOne.id,
      duplicateTwo.id,
    ]);
    expect(report.staleReady.map((item) => item.id)).toEqual([staleReady.id]);
    expect(report.staleBlocked.map((item) => item.id)).toEqual([blocked.id]);
    expect(report.duplicateTitleGroups).toEqual([
      {
        project: "scrapbook",
        normalizedTitle: "same weird thing",
        items: [
          expect.objectContaining({ id: duplicateOne.id }),
          expect.objectContaining({ id: duplicateTwo.id }),
        ],
      },
    ]);
    expect(report.summary).toEqual({
      expiredClaims: 1,
      expiringClaims: 1,
      missingNextActions: 3,
      staleReady: 1,
      staleBlocked: 1,
      duplicateTitleGroups: 1,
    });
    expect(reportHasFindings(report)).toBe(true);
  });

  test("reports findings without rewriting work", () => {
    const item = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Keep the original state",
      priority: 50,
      actor: leo,
    });
    store.db.query("UPDATE items SET updated_at = ?1 WHERE id = ?2")
      .run("2026-02-01T00:00:00.000Z", item.id);
    const before = store.getItem(item.id);

    const report = inspectScrapbook(store, {
      staleDays: 7,
      now: new Date("2026-03-06T00:00:00.000Z"),
    });

    expect(report.summary.missingNextActions).toBe(1);
    expect(report.summary.staleReady).toBe(1);
    expect(store.getItem(item.id)).toEqual(before);
    expect(store.listEvents(item.id).map((event) => event.type)).toEqual(["item.created"]);
  });

  test("validates thresholds and reports an empty ledger cleanly", () => {
    const report = inspectScrapbook(store, {
      now: new Date("2026-03-06T00:00:00.000Z"),
    });
    expect(reportHasFindings(report)).toBe(false);
    expect(report.summary).toEqual({
      expiredClaims: 0,
      expiringClaims: 0,
      missingNextActions: 0,
      staleReady: 0,
      staleBlocked: 0,
      duplicateTitleGroups: 0,
    });
    expect(() => inspectScrapbook(store, { staleDays: -1 })).toThrow(RangeError);
    expect(() => inspectScrapbook(store, { expiringWithinMinutes: 10_081 })).toThrow(
      RangeError,
    );
    expect(() => inspectScrapbook(store, { project: "Bad Scope" })).toThrow(
      "Project must be a lowercase project slug",
    );
  });
});
