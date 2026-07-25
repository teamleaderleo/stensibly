import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const runnerA = { id: "agent:runner-a", name: "Runner A", kind: "agent" as const };
const runnerB = { id: "agent:runner-b", name: "Runner B", kind: "agent" as const };

function createItem(store: StensiblyStore, title: string) {
  return store.createItem({
    project: "projection",
    kind: "task",
    title,
    summary: "Runner outcomes must become canonical item state.",
    nextAction: "Execute this through the generic runner.",
    priority: 90,
    actor: supervisor,
  });
}

function dispatch(store: StensiblyStore, itemId: string, idempotencyKey: string, maxAttempts = 3) {
  return dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "default",
    itemId,
    leaseSeconds: 900,
    maxAttempts,
    retryBackoffSeconds: 60,
    idempotencyKey,
  })!.run;
}

async function claimAndRun(
  ledger: SqliteWorkLedger,
  actor = runnerA,
) {
  const claimed = await ledger.claimRunnerWork({
    actor,
    runnerType: "generic-mcp",
    runnerProfile: "default",
    project: "projection",
    leaseSeconds: 900,
  });
  if (!claimed) throw new Error("Expected a queued run");
  const running = await ledger.transitionRun({
    id: claimed.id,
    actor,
    command: "run",
    expectedGeneration: claimed.generation,
    expectedLeaseGeneration: claimed.leaseGeneration,
    leaseSeconds: 900,
  });
  return running;
}

describe("run outcome item projection", () => {
  test("completes the item atomically with a successful run and replays cleanly", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Complete from runner success");
      dispatch(store, item.id, "dispatch-success");
      const ledger = new SqliteWorkLedger(store);
      const running = await claimAndRun(ledger);
      const before = store.getItem(item.id);
      const input = {
        id: running.id,
        actor: runnerA,
        command: "succeed" as const,
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "The runner produced the requested implementation.",
        idempotencyKey: "run-succeed-projection",
      };

      const succeeded = await ledger.transitionRun(input);
      expect(succeeded.status).toBe("succeeded");
      const completed = store.getItem(item.id);
      expect(completed).toMatchObject({
        status: "done",
        summary: "The runner produced the requested implementation.",
        claimedBy: null,
        claimExpiresAt: null,
      });
      expect(completed.version).toBe(before.version + 1);

      const replayVersion = completed.version;
      expect(await ledger.transitionRun(input)).toEqual(succeeded);
      expect(store.getItem(item.id).version).toBe(replayVersion);
    } finally {
      store.close();
    }
  });

  test("blocks, resumes, and reclaims retryable failure without duplicate dispatch state", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Recover through block and retry");
      dispatch(store, item.id, "dispatch-retry");
      const ledger = new SqliteWorkLedger(store);
      const running = await claimAndRun(ledger);

      const blocked = await ledger.transitionRun({
        id: running.id,
        actor: runnerA,
        command: "block",
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "A required approval is missing.",
        checkpoint: "Obtain approval, then resume the same run.",
      });
      expect(blocked.status).toBe("blocked");
      expect(store.getItem(item.id)).toMatchObject({
        status: "blocked",
        summary: "A required approval is missing.",
        nextAction: "Obtain approval, then resume the same run.",
        claimedBy: null,
      });

      const resumed = await ledger.transitionRun({
        id: blocked.id,
        actor: runnerA,
        command: "resume",
        expectedGeneration: blocked.generation,
        expectedLeaseGeneration: blocked.leaseGeneration,
        leaseSeconds: 900,
      });
      expect(resumed.status).toBe("running");
      expect(store.getItem(item.id)).toMatchObject({
        status: "active",
        claimedBy: runnerA.id,
        claimExpiresAt: resumed.leaseExpiresAt,
      });

      const failed = await ledger.transitionRun({
        id: resumed.id,
        actor: runnerA,
        command: "fail",
        expectedGeneration: resumed.generation,
        expectedLeaseGeneration: resumed.leaseGeneration,
        outcome: "The provider returned a transient startup error.",
      });
      expect(failed).toMatchObject({ status: "failed", retryAttempt: 1 });
      expect(failed.nextRetryAt).not.toBeNull();
      expect(store.getItem(item.id)).toMatchObject({
        status: "blocked",
        summary: "The provider returned a transient startup error.",
        nextAction: `Retry is eligible after ${failed.nextRetryAt}.`,
        claimedBy: null,
        claimExpiresAt: null,
      });

      store.db
        .query("UPDATE work_runs SET next_retry_at = ?1 WHERE id = ?2")
        .run("2020-01-01T00:00:00.000Z", failed.id);
      const retryClaim = await ledger.claimRunnerWork({
        actor: runnerB,
        runnerType: "generic-mcp",
        runnerProfile: "default",
        project: "projection",
        runId: failed.id,
        leaseSeconds: 900,
      });
      expect(retryClaim).toMatchObject({
        id: failed.id,
        status: "starting",
        actorId: runnerB.id,
        leaseOwnerId: runnerB.id,
      });
      expect(store.getItem(item.id)).toMatchObject({
        status: "active",
        claimedBy: runnerB.id,
        claimExpiresAt: retryClaim?.leaseExpiresAt,
      });
    } finally {
      store.close();
    }
  });

  test("blocks exhausted failures for human review", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Escalate exhausted failure");
      dispatch(store, item.id, "dispatch-exhausted", 1);
      const ledger = new SqliteWorkLedger(store);
      const running = await claimAndRun(ledger);

      const failed = await ledger.transitionRun({
        id: running.id,
        actor: runnerA,
        command: "fail",
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "The run exhausted its only attempt.",
      });
      expect(failed).toMatchObject({
        status: "failed",
        retryAttempt: 1,
        nextRetryAt: null,
      });
      expect(store.getItem(item.id)).toMatchObject({
        status: "blocked",
        summary: "The run exhausted its only attempt.",
        nextAction: "Review the failed run and decide how to continue.",
        claimedBy: null,
      });
    } finally {
      store.close();
    }
  });

  test("rolls back the run transition when item ownership changed", async () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Rollback projection conflict");
      dispatch(store, item.id, "dispatch-conflict");
      const ledger = new SqliteWorkLedger(store);
      const running = await claimAndRun(ledger);
      const competing = {
        id: "agent:competing",
        name: "Competing Actor",
        kind: "agent" as const,
      };
      store.db
        .query(`
          INSERT INTO actors (id, name, kind, updated_at)
          VALUES (?1, ?2, ?3, ?4)
        `)
        .run(competing.id, competing.name, competing.kind, new Date().toISOString());
      store.db
        .query(`
          UPDATE items
          SET status = 'active', claimed_by = ?1, claim_expires_at = ?2
          WHERE id = ?3
        `)
        .run(competing.id, "2099-01-01T00:00:00.000Z", item.id);

      await expect(ledger.transitionRun({
        id: running.id,
        actor: runnerA,
        command: "succeed",
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "This must roll back.",
      })).rejects.toBeInstanceOf(ConflictError);

      expect(await ledger.getRun(running.id)).toMatchObject({
        status: "running",
        generation: running.generation,
        outcome: null,
      });
      expect(store.getItem(item.id)).toMatchObject({
        status: "active",
        claimedBy: competing.id,
      });
      expect(store.listEvents(item.id).map((event) => event.type)).not.toContain("run.succeeded");
    } finally {
      store.close();
    }
  });
});
