import { describe, expect, test } from "bun:test";
import { dispatchNextWork, ensureDispatchSchema } from "../src/dispatcher.ts";
import { dispatchExactWorkAtClaimGeneration } from "../src/exact-generation-dispatch.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:vesper-dispatch",
  name: "Vesper dispatch",
  kind: "service" as const,
};
const now = new Date("2026-08-27T02:00:00.000Z");

describe("exact claim-generation dispatch fence", () => {
  test("dispatches never-claimed generation zero exactly through the existing exact-item path", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Generation zero target", 20);
      expect(item.claimGeneration).toBe(0);

      const outcome = dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        expectedClaimGeneration: 0,
        continuationRef: "cont:lane-wake-0",
      }, now);

      expect(outcome).toMatchObject({
        status: "dispatched",
        itemId: item.id,
        expectedClaimGeneration: 0,
        result: {
          item: {
            id: item.id,
            status: "active",
            claimedBy: supervisor.id,
            claimGeneration: 1,
          },
          run: {
            itemId: item.id,
            status: "queued",
            continuationRef: "cont:lane-wake-0",
          },
        },
      });
      expect(store.getItem(item.id).claimGeneration).toBe(1);
    } finally {
      store.close();
    }
  });

  test("an old generation cannot claim a later ready incarnation of the same item", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Reacquired target", 20);
      const claimed = store.claimItem(item.id, supervisor, 900);
      expect(claimed.claimGeneration).toBe(1);
      const released = store.releaseItem(
        item.id,
        supervisor,
        claimed.claimGeneration,
      );
      expect(released.status).toBe("ready");
      expect(released.claimGeneration).toBe(2);

      const stale = dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        expectedClaimGeneration: 0,
      }, now);
      expect(stale).toEqual({
        status: "stale_generation",
        itemId: item.id,
        expectedClaimGeneration: 0,
        currentClaimGeneration: 2,
      });
      expect(store.getItem(item.id)).toMatchObject({
        status: "ready",
        claimGeneration: 2,
      });

      const current = dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        expectedClaimGeneration: 2,
      }, now);
      expect(current.status).toBe("dispatched");
      expect(store.getItem(item.id).claimGeneration).toBe(3);
    } finally {
      store.close();
    }
  });

  test("preserves exact-item project and availability behavior", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Project target", 20, "alpha");
      expect(dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "beta",
        itemId: item.id,
        expectedClaimGeneration: 0,
      }, now)).toEqual({
        status: "unavailable",
        itemId: item.id,
        expectedClaimGeneration: 0,
      });

      const claimed = store.claimItem(item.id, supervisor, 900);
      expect(dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "alpha",
        itemId: item.id,
        expectedClaimGeneration: claimed.claimGeneration,
      }, now)).toEqual({
        status: "unavailable",
        itemId: item.id,
        expectedClaimGeneration: claimed.claimGeneration,
      });
    } finally {
      store.close();
    }
  });

  test("a later run-write failure rolls the claim transition back with the outer transaction", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Rollback target", 20);
      ensureDispatchSchema(store);
      store.db.exec(`
        CREATE TRIGGER fail_exact_generation_run_insert
        BEFORE INSERT ON work_runs
        BEGIN
          SELECT RAISE(ABORT, 'forced run insert failure');
        END;
      `);

      expect(() => dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        expectedClaimGeneration: 0,
      }, now)).toThrow();

      expect(store.getItem(item.id)).toMatchObject({
        status: "ready",
        claimedBy: null,
        claimGeneration: 0,
      });
      const runCount = store.db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_runs")
        .get();
      expect(runCount?.count).toBe(0);
    } finally {
      store.close();
    }
  });

  test("does not disturb ordinary ranked dispatch when the helper is unused", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const high = createItem(store, "High priority", 100);
      const exact = createItem(store, "Low exact target", 10);

      const exactOutcome = dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: exact.id,
        expectedClaimGeneration: 0,
      }, now);
      expect(exactOutcome.status).toBe("dispatched");
      expect(store.getItem(high.id).status).toBe("ready");

      const ranked = dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
      }, now);
      expect(ranked?.item.id).toBe(high.id);
    } finally {
      store.close();
    }
  });

  test("rejects invalid generation identity before dispatch work", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Invalid generation target", 20);
      expect(() => dispatchExactWorkAtClaimGeneration(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        expectedClaimGeneration: -0,
      }, now)).toThrow(
        "Exact-generation dispatch expected claim generation must be a non-negative safe integer",
      );
      expect(store.getItem(item.id)).toMatchObject({
        status: "ready",
        claimGeneration: 0,
      });
    } finally {
      store.close();
    }
  });
});

function createItem(
  store: StensiblyStore,
  title: string,
  priority: number,
  project = "orchestration",
) {
  return store.createItem({
    project,
    kind: "task",
    title,
    nextAction: `Dispatch ${title}.`,
    priority,
    actor: supervisor,
  });
}
