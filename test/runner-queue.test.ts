import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { claimRunnerWork } from "../src/runner-queue.ts";
import { transitionWorkRun } from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const runner = { id: "agent:runner-a", name: "Runner A", kind: "agent" as const };
const otherRunner = { id: "agent:runner-b", name: "Runner B", kind: "agent" as const };
const baseTime = new Date("2026-07-25T12:00:00.000Z");

function createItem(store: StensiblyStore, project = "orchestration") {
  return store.createItem({
    project,
    kind: "task",
    title: "Execute through the generic runner",
    summary: "The supervisor should hand this run to a replaceable runner process.",
    nextAction: "Claim the queued run and begin.",
    priority: 90,
    actor: supervisor,
  });
}

function dispatch(store: StensiblyStore, itemId: string, idempotencyKey = "dispatch-runner-1") {
  return dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    itemId,
    leaseSeconds: 300,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    idempotencyKey,
  }, baseTime)!;
}

describe("generic runner queue", () => {
  test("atomically transfers a queued run and item lease to one runner", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = dispatch(store, item.id);
      const input = {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "orchestration",
        externalRunId: "runner-session-1",
        leaseSeconds: 600,
        idempotencyKey: "runner-claim-1",
      };

      const claimed = claimRunnerWork(store, input, new Date("2026-07-25T12:00:10.000Z"));
      const replay = claimRunnerWork(store, input, new Date("2026-07-25T12:00:20.000Z"));
      const competing = claimRunnerWork(store, {
        ...input,
        actor: otherRunner,
        externalRunId: "runner-session-2",
        idempotencyKey: "runner-claim-2",
      }, new Date("2026-07-25T12:00:20.000Z"));

      expect(claimed).toMatchObject({
        id: queued.run.id,
        itemId: item.id,
        actorId: runner.id,
        leaseOwnerId: runner.id,
        status: "starting",
        generation: queued.run.generation + 1,
        leaseGeneration: queued.run.leaseGeneration + 1,
        externalRunId: "runner-session-1",
        startedAt: "2026-07-25T12:00:10.000Z",
      });
      expect(claimed?.leaseExpiresAt).toBe("2026-07-25T12:10:10.000Z");
      expect(replay).toEqual(claimed);
      expect(competing).toBeNull();
      expect(store.getItem(item.id)).toMatchObject({
        status: "active",
        claimedBy: runner.id,
        claimExpiresAt: "2026-07-25T12:10:10.000Z",
      });
      expect(store.listEvents(item.id).filter((event) => event.type === "run.starting")).toEqual([
        expect.objectContaining({ actorId: runner.id }),
      ]);
      expect(() => claimRunnerWork(store, {
        ...input,
        runnerProfile: "different",
      }, baseTime)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });

  test("does not steal an active item held indefinitely by an unrelated actor", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = dispatch(store, item.id);
      const protectedActor = {
        id: "agent:protected",
        name: "Protected Runner",
        kind: "agent" as const,
      };
      store.db
        .query(`
          INSERT INTO actors (id, name, kind, updated_at)
          VALUES (?1, ?2, ?3, ?4)
        `)
        .run(protectedActor.id, protectedActor.name, protectedActor.kind, baseTime.toISOString());
      store.db
        .query(`
          UPDATE items
          SET status = 'active', claimed_by = ?1, claim_expires_at = NULL
          WHERE id = ?2
        `)
        .run(protectedActor.id, item.id);

      expect(() => claimRunnerWork(store, {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runId: queued.run.id,
      }, new Date("2026-07-25T12:00:10.000Z"))).toThrow(
        "actively claimed by another actor",
      );
      expect(store.getItem(item.id)).toMatchObject({
        status: "active",
        claimedBy: protectedActor.id,
        claimExpiresAt: null,
      });
    } finally {
      store.close();
    }
  });

  test("claims retry-eligible failures only after their bounded backoff", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      dispatch(store, item.id);
      const starting = claimRunnerWork(store, {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "orchestration",
        leaseSeconds: 300,
      }, new Date("2026-07-25T12:00:10.000Z"))!;
      const running = transitionWorkRun(store, {
        id: starting.id,
        actor: runner,
        command: "run",
        expectedGeneration: starting.generation,
        expectedLeaseGeneration: starting.leaseGeneration,
        leaseSeconds: 300,
      }, new Date("2026-07-25T12:00:20.000Z"));
      const failed = transitionWorkRun(store, {
        id: running.id,
        actor: runner,
        command: "fail",
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "Runner startup failed transiently.",
      }, new Date("2026-07-25T12:01:00.000Z"));

      expect(failed).toMatchObject({
        status: "failed",
        retryAttempt: 1,
        nextRetryAt: "2026-07-25T12:02:00.000Z",
      });
      expect(claimRunnerWork(store, {
        actor: otherRunner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "orchestration",
      }, new Date("2026-07-25T12:01:59.000Z"))).toBeNull();

      const retried = claimRunnerWork(store, {
        actor: otherRunner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "orchestration",
        externalRunId: "retry-session",
      }, new Date("2026-07-25T12:02:00.000Z"));
      expect(retried).toMatchObject({
        id: failed.id,
        status: "starting",
        actorId: otherRunner.id,
        leaseOwnerId: otherRunner.id,
        generation: failed.generation + 1,
        leaseGeneration: failed.leaseGeneration + 1,
        retryAttempt: 1,
        nextRetryAt: null,
        outcome: null,
        externalRunId: "retry-session",
      });
      expect(store.getItem(item.id).claimedBy).toBe(otherRunner.id);
      expect(store.listEvents(item.id).map((event) => event.type)).toContain("run.retry_starting");
    } finally {
      store.close();
    }
  });

  test("filters claims by project, profile, and exact run", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const alpha = createItem(store, "alpha");
      const beta = createItem(store, "beta");
      const alphaRun = dispatch(store, alpha.id, "dispatch-alpha").run;
      dispatch(store, beta.id, "dispatch-beta");

      expect(claimRunnerWork(store, {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "wrong-profile",
        project: "alpha",
      }, baseTime)).toBeNull();
      expect(claimRunnerWork(store, {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "beta",
        runId: alphaRun.id,
      }, baseTime)).toBeNull();

      const exact = claimRunnerWork(store, {
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "alpha",
        runId: alphaRun.id,
      }, baseTime);
      expect(exact?.id).toBe(alphaRun.id);
      expect(store.getItem(beta.id).claimedBy).toBe(supervisor.id);
    } finally {
      store.close();
    }
  });
});
