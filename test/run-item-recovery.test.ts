import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:runner",
  name: "Runner",
  kind: "agent" as const,
};

function createItem(store: StensiblyStore) {
  return store.createItem({
    project: "recovery",
    kind: "task",
    title: "Recover run and item ownership together",
    summary: "Run leases and item claims must remain aligned.",
    nextAction: "Claim, heartbeat, and recover this work.",
    priority: 90,
    actor: supervisor,
  });
}

function dispatch(store: StensiblyStore, itemId: string, now = new Date()) {
  return dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "default",
    itemId,
    leaseSeconds: 300,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
  }, now)!;
}

describe("run item recovery", () => {
  test("abandons an expired queued run and releases its reserved item", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = dispatch(store, item.id, new Date("2020-01-01T00:00:00.000Z"));
      const ledger = new SqliteWorkLedger(store);

      const recovered = await ledger.getRun(queued.run.id);
      expect(recovered).toMatchObject({
        status: "abandoned",
        generation: queued.run.generation + 1,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        outcome: "Run lease expired before a runner claimed it.",
      });
      expect(store.getItem(item.id)).toMatchObject({
        status: "ready",
        claimedBy: null,
        claimExpiresAt: null,
      });
      const event = store.listEvents(item.id)
        .slice()
        .reverse()
        .find((entry) => entry.type === "run.abandoned");
      expect(event?.payload).toMatchObject({
        runId: queued.run.id,
        fromStatus: "queued",
        reason: "queue_lease_expired",
        itemClaimReleased: true,
      });
    } finally {
      store.close();
    }
  });

  test("extends the item claim with each runner heartbeat without replay drift", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      dispatch(store, item.id);
      const ledger = new SqliteWorkLedger(store);
      const claimed = await ledger.claimRunnerWork({
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "recovery",
        leaseSeconds: 300,
      });
      if (!claimed) throw new Error("Expected a runner claim");
      const before = store.getItem(item.id);

      const heartbeatInput = {
        id: claimed.id,
        actor: runner,
        expectedGeneration: claimed.generation,
        expectedLeaseGeneration: claimed.leaseGeneration,
        leaseSeconds: 1_800,
        checkpoint: "Still working from the durable context packet.",
        idempotencyKey: "heartbeat-recovery-1",
      };
      const heartbeat = await ledger.heartbeatRun(heartbeatInput);
      const after = store.getItem(item.id);
      expect(after).toMatchObject({
        status: "active",
        claimedBy: runner.id,
        claimExpiresAt: heartbeat.leaseExpiresAt,
      });
      expect(Date.parse(after.claimExpiresAt!)).toBeGreaterThan(
        Date.parse(before.claimExpiresAt!),
      );

      const replayVersion = after.version;
      expect(await ledger.heartbeatRun(heartbeatInput)).toEqual(heartbeat);
      expect(store.getItem(item.id).version).toBe(replayVersion);
    } finally {
      store.close();
    }
  });

  test("releases terminal work and recovers retry queues by their actual lease owner", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      dispatch(store, item.id);
      const ledger = new SqliteWorkLedger(store);
      const claimed = await ledger.claimRunnerWork({
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "recovery",
      });
      if (!claimed) throw new Error("Expected a runner claim");

      const failed = await ledger.transitionRun({
        id: claimed.id,
        actor: runner,
        command: "fail",
        expectedGeneration: claimed.generation,
        expectedLeaseGeneration: claimed.leaseGeneration,
        outcome: "Transient execution failure.",
      });
      expect(failed.status).toBe("failed");
      expect(store.getItem(item.id)).toMatchObject({
        status: "ready",
        claimedBy: null,
        claimExpiresAt: null,
      });

      store.db
        .query("UPDATE work_runs SET next_retry_at = ?1 WHERE id = ?2")
        .run("2020-01-01T00:00:00.000Z", failed.id);
      const retried = await ledger.transitionRun({
        id: failed.id,
        actor: supervisor,
        command: "retry",
        expectedGeneration: failed.generation,
        expectedLeaseGeneration: failed.leaseGeneration,
        leaseSeconds: 300,
      });
      expect(retried).toMatchObject({
        status: "queued",
        actorId: runner.id,
        leaseOwnerId: supervisor.id,
      });
      expect(store.getItem(item.id)).toMatchObject({
        status: "active",
        claimedBy: supervisor.id,
        claimExpiresAt: retried.leaseExpiresAt,
      });

      store.db
        .query("UPDATE work_runs SET lease_expires_at = ?1 WHERE id = ?2")
        .run("2020-01-01T00:00:00.000Z", retried.id);
      const abandoned = await ledger.getRun(retried.id);
      expect(abandoned.status).toBe("abandoned");
      expect(store.getItem(item.id)).toMatchObject({
        status: "ready",
        claimedBy: null,
        claimExpiresAt: null,
      });
      const event = store.listEvents(item.id)
        .slice()
        .reverse()
        .find((entry) => entry.type === "run.abandoned");
      expect(event?.payload).toMatchObject({
        runId: retried.id,
        itemClaimReleased: true,
      });
    } finally {
      store.close();
    }
  });
});
