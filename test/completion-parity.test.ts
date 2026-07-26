import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const actor = { id: "agent-1", name: "Agent One", kind: "agent" as const };

describe("SQLite completion parity", () => {
  test("completion preserves or replaces summary, clears next action and lease, and replays once", async () => {
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
      const completed = await ledger.completeWork({
        id: preserved.id,
        actor,
        expectedClaimGeneration: claimed.claimGeneration,
        idempotencyKey: "complete-preserve",
      });
      expect(completed).toMatchObject({
        status: "done",
        summary: "Original summary",
        nextAction: null,
        claimedBy: null,
        claimExpiresAt: null,
      });
      const completedVersion = completed.version;
      const replayed = await ledger.completeWork({
        id: preserved.id,
        actor,
        expectedClaimGeneration: claimed.claimGeneration,
        idempotencyKey: "complete-preserve",
      });
      expect(replayed.version).toBe(completedVersion);
      expect(replayed.nextAction).toBeNull();
      expect((await ledger.getItem(preserved.id)).events.filter((event) => event.type === "item.completed")).toHaveLength(1);

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
      });
    } finally {
      store.close();
    }
  });

  test("the legacy local completion route uses the same next-action contract", async () => {
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
      const response = await app.request(`/api/items/${item.id}/complete`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "legacy-complete",
        },
        body: JSON.stringify({
          actor,
          expectedClaimGeneration: item.claimGeneration,
        }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as any;
      expect(payload.item).toMatchObject({
        status: "done",
        summary: "Keep this summary",
        nextAction: null,
        claimedBy: null,
        claimExpiresAt: null,
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
      store.completeItem(
        item.id,
        actor,
        item.claimGeneration,
        undefined,
        "old-complete",
      );
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
