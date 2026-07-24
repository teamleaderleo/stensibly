import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkRun,
  getWorkRun,
  heartbeatWorkRun,
  listRetryEligibleRuns,
  listWorkRuns,
  reconcileStaleRuns,
  transitionWorkRun,
} from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const runner = { id: "agent:runner", name: "Runner", kind: "agent" as const };
const otherRunner = { id: "agent:other", name: "Other Runner", kind: "agent" as const };
const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const baseTime = new Date("2026-07-25T10:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function createItem(store: StensiblyStore, title = "Run durable work") {
  return store.createItem({
    project: "orchestration",
    kind: "task",
    title,
    summary: "Execute through the generic runner.",
    nextAction: "Dispatch the work.",
    priority: 80,
    actor: supervisor,
  });
}

function createRun(store: StensiblyStore, itemId: string, overrides = {}) {
  return createWorkRun(store, {
    itemId,
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    externalRunId: "external-1",
    continuationRef: "continuation-1",
    leaseSeconds: 300,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    idempotencyKey: "run-create-1",
    ...overrides,
  }, baseTime);
}

function transition(
  store: StensiblyStore,
  run: { id: string; generation: number; leaseGeneration: number },
  command: Parameters<typeof transitionWorkRun>[1]["command"],
  now: Date,
  overrides = {},
) {
  return transitionWorkRun(store, {
    id: run.id,
    actor: runner,
    command,
    expectedGeneration: run.generation,
    expectedLeaseGeneration: run.leaseGeneration,
    leaseSeconds: 300,
    ...overrides,
  }, now);
}

describe("local durable runs", () => {
  test("creates one live run per item and replays exact creation", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const created = createRun(store, item.id);
      const replayed = createRun(store, item.id);

      expect(replayed).toEqual(created);
      expect(created).toMatchObject({
        itemId: item.id,
        actorId: runner.id,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        status: "queued",
        generation: 1,
        leaseGeneration: 1,
        leaseOwnerId: runner.id,
        retryAttempt: 0,
        maxAttempts: 3,
      });
      expect(created.leaseExpiresAt).toBe("2026-07-25T10:05:00.000Z");
      expect(store.getItem(item.id).version).toBe(item.version + 1);
      expect(store.listEvents(item.id).filter((event) => event.type === "run.queued")).toHaveLength(1);
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toHaveLength(1);

      expect(() => createRun(store, item.id, { runnerProfile: "different" })).toThrow(ConflictError);
      expect(() => createWorkRun(store, {
        itemId: item.id,
        actor: otherRunner,
        runnerType: "generic-mcp",
        runnerProfile: "other",
        leaseSeconds: 300,
      }, baseTime)).toThrow("already has live run");
    } finally {
      store.close();
    }
  });

  test("starts, runs, and heartbeats with stable generation and extended lease", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = createRun(store, item.id);
      const starting = transition(store, queued, "start", new Date("2026-07-25T10:01:00.000Z"), {
        idempotencyKey: "run-start-1",
      });
      const running = transition(store, starting, "run", new Date("2026-07-25T10:02:00.000Z"), {
        idempotencyKey: "run-running-1",
      });

      const heartbeatInput = {
        id: running.id,
        actor: runner,
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        leaseSeconds: 600,
        checkpoint: "Repository cloned and tests inspected.",
        usage: { inputTokens: 1200, outputTokens: 300, toolCalls: 8, childAgents: 1 },
        idempotencyKey: "run-heartbeat-1",
      };
      const heartbeat = heartbeatWorkRun(store, heartbeatInput, new Date("2026-07-25T10:03:00.000Z"));
      const replayed = heartbeatWorkRun(store, heartbeatInput, new Date("2026-07-25T10:04:00.000Z"));

      expect(starting).toMatchObject({ status: "starting", generation: 2, leaseGeneration: 1 });
      expect(running).toMatchObject({ status: "running", generation: 3, leaseGeneration: 1 });
      expect(heartbeat).toMatchObject({
        status: "running",
        generation: 3,
        leaseGeneration: 1,
        leaseExpiresAt: "2026-07-25T10:13:00.000Z",
        lastHeartbeatAt: "2026-07-25T10:03:00.000Z",
        checkpoint: "Repository cloned and tests inspected.",
        usage: { inputTokens: 1200, outputTokens: 300, toolCalls: 8, childAgents: 1 },
      });
      expect(replayed).toEqual(heartbeat);
      expect(store.listEvents(item.id).filter((event) => event.type === "run.heartbeat")).toHaveLength(1);
      expect(() => heartbeatWorkRun(store, { ...heartbeatInput, checkpoint: "Different" }, baseTime)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });

  test("waits, resumes, blocks, and acquires a new lease generation after unblock", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = createRun(store, item.id);
      const starting = transition(store, queued, "start", new Date("2026-07-25T10:00:30.000Z"));
      const running = transition(store, starting, "run", new Date("2026-07-25T10:01:00.000Z"));
      const waiting = transition(store, running, "wait", new Date("2026-07-25T10:01:30.000Z"), {
        checkpoint: "Waiting for a dependency.",
      });
      const resumed = transition(store, waiting, "resume", new Date("2026-07-25T10:02:00.000Z"));
      const blocked = transition(store, resumed, "block", new Date("2026-07-25T10:02:30.000Z"), {
        checkpoint: "Needs human access.",
      });
      const unblocked = transition(store, blocked, "resume", new Date("2026-07-25T10:03:00.000Z"), {
        leaseSeconds: 900,
      });

      expect(waiting).toMatchObject({ status: "waiting", generation: 4, leaseGeneration: 1 });
      expect(resumed).toMatchObject({ status: "running", generation: 5, leaseGeneration: 1 });
      expect(blocked).toMatchObject({
        status: "blocked",
        generation: 6,
        leaseGeneration: 1,
        leaseOwnerId: null,
        leaseExpiresAt: null,
      });
      expect(unblocked).toMatchObject({
        status: "running",
        generation: 7,
        leaseGeneration: 2,
        leaseOwnerId: runner.id,
        leaseExpiresAt: "2026-07-25T10:18:00.000Z",
      });
    } finally {
      store.close();
    }
  });

  test("succeeds once and rejects stale or terminal mutations", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = createRun(store, item.id);
      const starting = transition(store, queued, "start", new Date("2026-07-25T10:01:00.000Z"));
      const running = transition(store, starting, "run", new Date("2026-07-25T10:02:00.000Z"));
      const command = {
        id: running.id,
        actor: runner,
        command: "succeed" as const,
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        checkpoint: "All tests passed.",
        outcome: "Delivered the requested change.",
        continuationRef: "continuation:next",
        usage: { toolCalls: 12 },
        idempotencyKey: "run-succeed-1",
      };
      const succeeded = transitionWorkRun(store, command, new Date("2026-07-25T10:03:00.000Z"));
      const replayed = transitionWorkRun(store, command, new Date("2026-07-25T10:04:00.000Z"));

      expect(replayed).toEqual(succeeded);
      expect(succeeded).toMatchObject({
        status: "succeeded",
        generation: running.generation + 1,
        leaseOwnerId: null,
        leaseExpiresAt: null,
        checkpoint: "All tests passed.",
        outcome: "Delivered the requested change.",
        continuationRef: "continuation:next",
        usage: { toolCalls: 12 },
        endedAt: "2026-07-25T10:03:00.000Z",
      });
      expect(store.listEvents(item.id).filter((event) => event.type === "run.succeeded")).toHaveLength(1);
      expect(() => transitionWorkRun(store, {
        ...command,
        command: "cancel",
        idempotencyKey: "run-stale-cancel",
        expectedGeneration: running.generation,
      }, baseTime)).toThrow("generation changed");
      expect(() => transitionWorkRun(store, {
        ...command,
        command: "cancel",
        idempotencyKey: "run-terminal-cancel",
        expectedGeneration: succeeded.generation,
      }, baseTime)).toThrow("cannot cancel while succeeded");
    } finally {
      store.close();
    }
  });

  test("schedules bounded retries and releases the item when the budget is exhausted", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = createRun(store, item.id, {
        maxAttempts: 2,
        retryBackoffSeconds: 60,
      });
      const starting = transition(store, queued, "start", new Date("2026-07-25T10:00:30.000Z"));
      const running = transition(store, starting, "run", new Date("2026-07-25T10:01:00.000Z"));
      const failed = transition(store, running, "fail", new Date("2026-07-25T10:02:00.000Z"), {
        outcome: "Transient runner startup failure.",
      });

      expect(failed).toMatchObject({
        status: "failed",
        retryAttempt: 1,
        maxAttempts: 2,
        nextRetryAt: "2026-07-25T10:03:00.000Z",
        leaseOwnerId: null,
      });
      expect(listRetryEligibleRuns(store, new Date("2026-07-25T10:02:59.000Z"))).toEqual([]);
      expect(listRetryEligibleRuns(store, new Date("2026-07-25T10:03:00.000Z"))).toEqual([
        expect.objectContaining({ id: failed.id, retryAttempt: 1 }),
      ]);
      expect(() => transition(store, failed, "retry", new Date("2026-07-25T10:02:59.000Z"))).toThrow("not eligible");

      const retried = transition(store, failed, "retry", new Date("2026-07-25T10:03:00.000Z"));
      const retryStarting = transition(store, retried, "start", new Date("2026-07-25T10:03:30.000Z"));
      const retryRunning = transition(store, retryStarting, "run", new Date("2026-07-25T10:04:00.000Z"));
      const exhausted = transition(store, retryRunning, "fail", new Date("2026-07-25T10:05:00.000Z"), {
        outcome: "Second failure exhausted the budget.",
      });

      expect(retried).toMatchObject({
        status: "queued",
        leaseGeneration: 2,
        leaseOwnerId: runner.id,
        nextRetryAt: null,
      });
      expect(exhausted).toMatchObject({
        status: "failed",
        retryAttempt: 2,
        nextRetryAt: null,
        endedAt: "2026-07-25T10:05:00.000Z",
      });
      expect(listRetryEligibleRuns(store, new Date("2030-01-01T00:00:00.000Z"))).toEqual([]);
      expect(() => transition(store, exhausted, "retry", new Date("2030-01-01T00:00:00.000Z"))).toThrow(
        "cannot retry while failed",
      );

      const replacement = createWorkRun(store, {
        itemId: item.id,
        actor: otherRunner,
        runnerType: "generic-mcp",
        runnerProfile: "replacement",
        leaseSeconds: 300,
        idempotencyKey: "replacement-run",
      }, new Date("2026-07-25T10:06:00.000Z"));
      expect(replacement.status).toBe("queued");
    } finally {
      store.close();
    }
  });

  test("enforces lease ownership and can cancel non-terminal runs", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = createRun(store, item.id);
      expect(() => transitionWorkRun(store, {
        id: queued.id,
        actor: otherRunner,
        command: "start",
        expectedGeneration: queued.generation,
        expectedLeaseGeneration: queued.leaseGeneration,
      }, new Date("2026-07-25T10:01:00.000Z"))).toThrow("lease owner");
      expect(() => transitionWorkRun(store, {
        id: queued.id,
        actor: runner,
        command: "start",
        expectedGeneration: queued.generation,
        expectedLeaseGeneration: 2,
      }, new Date("2026-07-25T10:01:00.000Z"))).toThrow("lease generation changed");

      const cancelled = transitionWorkRun(store, {
        id: queued.id,
        actor: supervisor,
        command: "cancel",
        expectedGeneration: queued.generation,
        expectedLeaseGeneration: queued.leaseGeneration,
        outcome: "Cancelled by supervisor policy.",
      }, new Date("2026-07-25T10:01:00.000Z"));
      expect(cancelled).toMatchObject({
        status: "cancelled",
        leaseOwnerId: null,
        leaseExpiresAt: null,
        outcome: "Cancelled by supervisor policy.",
      });
    } finally {
      store.close();
    }
  });

  test("abandons stale active runs exactly once", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const queued = createRun(store, item.id, { leaseSeconds: 60 });
      const starting = transition(store, queued, "start", new Date("2026-07-25T10:00:10.000Z"));
      const running = transition(store, starting, "run", new Date("2026-07-25T10:00:20.000Z"));

      const first = reconcileStaleRuns(store, new Date("2026-07-25T10:01:01.000Z"));
      const second = reconcileStaleRuns(store, new Date("2026-07-25T10:02:00.000Z"));
      expect(first.abandoned).toEqual([
        expect.objectContaining({
          id: running.id,
          status: "abandoned",
          generation: running.generation + 1,
          outcome: "Run lease expired without a heartbeat.",
        }),
      ]);
      expect(second).toEqual({ abandoned: [] });
      expect(store.listEvents(item.id).filter((event) => event.type === "run.abandoned")).toHaveLength(1);
      expect(getWorkRun(store, running.id, new Date("2026-07-25T10:02:00.000Z")).status).toBe("abandoned");
    } finally {
      store.close();
    }
  });

  test("recovers stale runs after reopening the SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-runs-"));
    tempDirectories.push(directory);
    const path = join(directory, "ledger.sqlite");
    let itemId = "";
    let runId = "";

    const first = new StensiblyStore(path);
    try {
      const item = createItem(first);
      itemId = item.id;
      const queued = createWorkRun(first, {
        itemId,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "restart-test",
        leaseSeconds: 60,
      }, baseTime);
      const starting = transition(first, queued, "start", new Date("2026-07-25T10:00:10.000Z"));
      runId = transition(first, starting, "run", new Date("2026-07-25T10:00:20.000Z")).id;
    } finally {
      first.close();
    }

    const second = new StensiblyStore(path);
    try {
      const result = reconcileStaleRuns(second, new Date("2026-07-25T10:01:01.000Z"));
      expect(result.abandoned).toEqual([
        expect.objectContaining({ id: runId, itemId, status: "abandoned" }),
      ]);
      expect(listWorkRuns(second, { itemId }, new Date("2026-07-25T10:02:00.000Z"))).toEqual([
        expect.objectContaining({ id: runId, status: "abandoned" }),
      ]);
    } finally {
      second.close();
    }
  });
});
