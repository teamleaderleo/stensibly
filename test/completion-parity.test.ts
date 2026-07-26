import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { renewClaim } from "../src/leases.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };

describe("SQLite completion parity", () => {
  test("completion advances generation, preserves or replaces summary, and replays once", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const preserved = await ledger.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Preserve the final summary",
        summary: "Original summary",
        nextAction: "This must disappear",
        priority: 50,
        actor,
      });
      const claimed = await ledger.claimWork({ id: preserved.id, actor, leaseSeconds: 900 });
      const request = {
        id: preserved.id,
        actor,
        expectedClaimGeneration: claimed.claimGeneration,
        idempotencyKey: "complete-preserve",
      };
      const completed = await ledger.completeWork(request);
      expect(completed).toMatchObject({
        status: "done",
        summary: "Original summary",
        nextAction: null,
        claimedBy: null,
        claimExpiresAt: null,
        claimGeneration: claimed.claimGeneration + 1,
      });
      expect(await ledger.completeWork(request)).toEqual(completed);
      const detail = await ledger.getItem(preserved.id);
      expect(detail.events.filter((event) => event.type === "item.completed")).toHaveLength(1);
      expect(detail.events.at(-1)?.payload).toMatchObject({
        generation: claimed.claimGeneration,
        nextGeneration: completed.claimGeneration,
      });

      const replaced = await ledger.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Replace the final summary",
        summary: "Before completion",
        nextAction: "Also disappears",
        priority: 50,
        actor,
      });
      const replacedResult = await ledger.completeWork({
        id: replaced.id,
        actor,
        expectedClaimGeneration: replaced.claimGeneration,
        summary: "Completed with evidence",
        idempotencyKey: "complete-replace",
      });
      expect(replacedResult).toMatchObject({
        status: "done",
        summary: "Completed with evidence",
        nextAction: null,
        claimedBy: null,
        claimExpiresAt: null,
        claimGeneration: 1,
      });
    } finally {
      store.close();
    }
  });

  test("same-actor stale completion is rejected after renewal", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const item = await ledger.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Reject stale completion",
        priority: 50,
        actor,
      });
      const claimed = await ledger.claimWork({ id: item.id, actor, leaseSeconds: 900 });
      const renewed = renewClaim(
        store,
        item.id,
        actor,
        1800,
        claimed.claimGeneration,
      );

      await expect(ledger.completeWork({
        id: item.id,
        actor,
        expectedClaimGeneration: claimed.claimGeneration,
      })).rejects.toBeInstanceOf(ConflictError);
      expect(store.getItem(item.id)).toEqual(renewed);
    } finally {
      store.close();
    }
  });

  test("the legacy local completion route requires generation zero for fresh work", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = store.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Complete through legacy REST",
        summary: "Keep this summary",
        nextAction: "Remove this action",
        priority: 50,
        actor,
      });
      const app = createApp(store);
      const missingGeneration = await app.request(`/api/items/${item.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor }),
      });
      expect(missingGeneration.status).toBe(400);

      const response = await app.request(`/api/items/${item.id}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "legacy-complete",
        },
        body: JSON.stringify({ actor, expectedClaimGeneration: 0 }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as any;
      expect(payload.item).toMatchObject({
        status: "done",
        summary: "Keep this summary",
        nextAction: null,
        claimedBy: null,
        claimExpiresAt: null,
        claimGeneration: 1,
      });
    } finally {
      store.close();
    }
  });

  test("startup repairs stale completed next actions without changing version or history", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = store.createItem({
        project: "scrapbook",
        kind: "task",
        title: "Repair an old completion",
        summary: "Already done",
        nextAction: "Old stale action",
        priority: 50,
        actor,
      });
      store.completeItem(item.id, actor, undefined, "old-complete");
      store.db.query("UPDATE items SET next_action = ?1 WHERE id = ?2").run("Stale legacy value", item.id);
      const before = store.getItem(item.id);
      const eventCount = store.listEvents(item.id).length;

      new SqliteWorkLedger(store);

      const repaired = store.getItem(item.id);
      expect(repaired.nextAction).toBeNull();
      expect(repaired.version).toBe(before.version);
      expect(store.listEvents(item.id)).toHaveLength(eventCount);
    } finally {
      store.close();
    }
  });
});
