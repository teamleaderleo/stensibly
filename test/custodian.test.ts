import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  inspectScrapbook,
  reportHasFindings,
} from "../src/custodian-report.ts";
import { StensiblyStore } from "../src/store.ts";
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

describe("custodian report", () => {
  test("surfaces expired, expiring, stale, vague, and duplicate work", () => {
    const now = new Date("2100-01-01T00:00:00.000Z");

    const expired = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Recover this claim",
      nextAction: "Let another actor claim it.",
      priority: 50,
      actor: leo,
    });
    store.claimItem(expired.id, browserAgent, 900);
    setItemTimes(expired.id, {
      updatedAt: "2099-12-31T23:59:00.000Z",
      claimExpiresAt: "2099-12-31T23:59:30.000Z",
    });

    const expiring = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Renew this soon",
      nextAction: "Renew the lease.",
      priority: 80,
      actor: leo,
    });
    store.claimItem(expiring.id, browserAgent, 900);
    setItemTimes(expiring.id, {
      updatedAt: "2099-12-31T23:59:00.000Z",
      claimExpiresAt: "2100-01-01T00:03:00.000Z",
    });

    const vague = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Figure something out",
      priority: 90,
      actor: leo,
    });
    setItemTimes(vague.id, { updatedAt: "2099-12-31T12:00:00.000Z" });

    const staleReady = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Old ready work",
      nextAction: "Decide whether this still belongs here.",
      priority: 60,
      actor: leo,
    });
    setItemTimes(staleReady.id, { updatedAt: "2099-01-01T00:00:00.000Z" });

    const staleBlocked = store.createItem({
      project: "scrapbook",
      kind: "task",
      title: "Old blocked work",
      priority: 70,
      actor: leo,
    });
    blockWork(store, {
      id: staleBlocked.id,
      actor: leo,
      reason: "Waiting on a system that may never arrive.",
      nextAction: "Confirm whether the dependency still exists.",
    });
    setItemTimes(staleBlocked.id, { updatedAt: "2099-02-01T00:00:00.000Z" });

    const duplicateOne = store.createItem({
      project: "scrapbook",
      kind: "question",
      title: "Review API!",
      nextAction: "Read the API surface.",
      priority: 40,
      actor: leo,
    });
    const duplicateTwo = store.createItem({
      project: "scrapbook",
      kind: "question",
      title: "  review   api  ",
      nextAction: "Compare the API surface.",
      priority: 30,
      actor: leo,
    });
    setItemTimes(duplicateOne.id, { updatedAt: "2099-12-31T10:00:00.000Z" });
    setItemTimes(duplicateTwo.id, { updatedAt: "2099-12-31T11:00:00.000Z" });

    const completedDuplicate = store.createItem({
      project: "scrapbook",
      kind: "question",
      title: "Review API",
      priority: 100,
      actor: leo,
    });
    store.completeItem(completedDuplicate.id, leo, "Already answered once.");

    const report = inspectScrapbook(store, {
      project: "scrapbook",
      staleDays: 7,
      expiringWithinMinutes: 5,
      now,
    });

    expect(report.generatedAt).toBe(now.toISOString());
    expect(report.summary).toEqual({
      expiredClaims: 1,
      expiringClaims: 1,
      missingNextActions: 1,
      staleReady: 1,
      staleBlocked: 1,
      duplicateTitleGroups: 1,
    });
    expect(report.expiredClaimIds).toEqual([expired.id]);
    expect(report.expiringClaims.map((item) => item.id)).toEqual([expiring.id]);
    expect(report.missingNextActions.map((item) => item.id)).toEqual([vague.id]);
    expect(report.staleReady.map((item) => item.id)).toEqual([staleReady.id]);
    expect(report.staleBlocked.map((item) => item.id)).toEqual([staleBlocked.id]);
    expect(report.duplicateTitleGroups).toEqual([
      {
        project: "scrapbook",
        normalizedTitle: "review api",
        items: [
          expect.objectContaining({ id: duplicateOne.id }),
          expect.objectContaining({ id: duplicateTwo.id }),
        ],
      },
    ]);
    expect(reportHasFindings(report)).toBe(true);
    expect(store.getItem(expired.id)).toMatchObject({
      status: "ready",
      claimedBy: null,
      claimExpiresAt: null,
    });
  });

  test("can inspect a clean project without noise from another project", () => {
    store.createItem({
      project: "clean",
      kind: "decision",
      title: "Keep this project tidy",
      priority: 50,
      actor: leo,
    });
    store.createItem({
      project: "messy",
      kind: "task",
      title: "Missing a next action",
      priority: 50,
      actor: leo,
    });

    const report = inspectScrapbook(store, {
      project: "clean",
      now: new Date(),
      staleDays: 30,
      expiringWithinMinutes: 5,
    });
    expect(report.scope.project).toBe("clean");
    expect(reportHasFindings(report)).toBe(false);
  });

  test("validates inspection windows", () => {
    expect(() => inspectScrapbook(store, { staleDays: -1 })).toThrow(RangeError);
    expect(() => inspectScrapbook(store, { expiringWithinMinutes: 10_081 })).toThrow(
      RangeError,
    );
  });
});

function setItemTimes(
  id: string,
  input: { updatedAt: string; claimExpiresAt?: string },
): void {
  store.db
    .query(`
      UPDATE items
      SET updated_at = ?1,
          claim_expires_at = COALESCE(?2, claim_expires_at)
      WHERE id = ?3
    `)
    .run(input.updatedAt, input.claimExpiresAt ?? null, id);
}
