import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchNextWork, surveyDispatch } from "../src/dispatcher.ts";
import {
  MAX_PROMISE_WAKEUPS_PER_DISPATCH,
  listPromiseWakeupConsumptions,
} from "../src/promise-wakeup-consumption.ts";
import {
  createWorkPromise,
  listReadyPromiseWakeups,
  resolveWorkPromise,
} from "../src/promises.ts";
import { listWorkRuns, transitionWorkRun } from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:nightjar-supervisor", name: "Nightjar Supervisor", kind: "service" as const };
const agent = { id: "agent:promise-worker", name: "Promise Worker", kind: "agent" as const };
const baseTime = new Date("2026-07-27T01:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function createItem(store: StensiblyStore, title = "promised work", project = "orchestration") {
  return store.createItem({
    project,
    kind: "task",
    title,
    summary: `Coordinate ${title}.`,
    nextAction: `Dispatch ${title}.`,
    priority: 50,
    actor: supervisor,
  });
}

function readyWakeup(store: StensiblyStore, itemId: string, sequence: number) {
  const promise = createWorkPromise(store, {
    itemId,
    actor: agent,
    action: `Resume continuation ${sequence}.`,
    wakeCondition: { kind: "manual" },
    expectedCheckInAt: "2030-01-01T00:00:00.000Z",
    idempotencyKey: `promise-${sequence}`,
  }, baseTime);
  resolveWorkPromise(store, {
    id: promise.id,
    actor: supervisor,
    command: "satisfy",
    expectedGeneration: promise.generation,
    idempotencyKey: `satisfy-${sequence}`,
  }, baseTime);
  return promise;
}

function dispatchInput(idempotencyKey: string, itemId?: string) {
  return {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    ...(itemId ? { itemId } : {}),
    leaseSeconds: 600,
    maxAttempts: 1,
    retryBackoffSeconds: 0,
    idempotencyKey,
  };
}

describe("exactly-once promise wakeup consumption", () => {
  test("boosts before dispatch and consumes exactly once with replay evidence", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      readyWakeup(store, item.id, 1);
      expect(surveyDispatch(store, {}, baseTime).candidates[0]).toMatchObject({
        itemId: item.id,
        readyPromiseWakeups: 1,
      });

      const request = dispatchInput("consume-once", item.id);
      const first = dispatchNextWork(store, request, baseTime);
      expect(first?.wakeupSource).toBe("local");
      expect(first?.consumedPromiseWakeupIds).toHaveLength(1);
      expect(listReadyPromiseWakeups(store, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(store, { runId: first!.run.id })).toEqual([
        expect.objectContaining({
          wakeupId: first!.consumedPromiseWakeupIds[0],
          runId: first!.run.id,
          dispatchCommandId: `dispatch:${first!.run.id}`,
          itemId: item.id,
          project: "orchestration",
        }),
      ]);

      const queued = store.listEvents(item.id).find((event) => event.type === "run.queued");
      expect(queued?.payload).toMatchObject({
        readyPromiseWakeups: 1,
        consumedPromiseWakeupIds: first?.consumedPromiseWakeupIds,
        wakeupSource: "local",
      });

      const second = dispatchNextWork(store, request, new Date("2026-07-27T01:05:00.000Z"));
      expect(second).toEqual(first);
      expect(listPromiseWakeupConsumptions(store)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("consumes a deterministic bounded set in created/id order", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      for (let index = 0; index < 4; index += 1) readyWakeup(store, item.id, index);
      surveyDispatch(store, {}, baseTime);
      const expected = store.db
        .query<{ id: string }, []>(
          "SELECT id FROM promise_wakeups ORDER BY created_at ASC, id ASC",
        )
        .all()
        .map((row) => row.id);

      const result = dispatchNextWork(store, dispatchInput("deterministic", item.id), baseTime);
      expect(result?.consumedPromiseWakeupIds).toEqual(expected);
      expect(listPromiseWakeupConsumptions(store, { runId: result!.run.id })
        .map((entry) => entry.wakeupId)).toEqual(expected);
    } finally {
      store.close();
    }
  });

  test("fails closed at MAX plus one without claim, run, event, or consumption", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      for (let index = 0; index <= MAX_PROMISE_WAKEUPS_PER_DISPATCH; index += 1) {
        readyWakeup(store, item.id, index);
      }
      const eventsBefore = store.listEvents(item.id).length;
      expect(() => dispatchNextWork(store, dispatchInput("overflow", item.id), baseTime))
        .toThrow(`more than ${MAX_PROMISE_WAKEUPS_PER_DISPATCH}`);
      expect(store.getItem(item.id).status).toBe("ready");
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(store)).toEqual([]);
      expect(store.listEvents(item.id)).toHaveLength(eventsBefore);
      expect(listReadyPromiseWakeups(store, baseTime)).toHaveLength(
        MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1,
      );
    } finally {
      store.close();
    }
  });

  test("rolls markers back when a later dispatch write fails", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      readyWakeup(store, item.id, 1);
      surveyDispatch(store, {}, baseTime);
      const eventsBefore = store.listEvents(item.id).length;
      store.db.exec(`
        CREATE TRIGGER fail_run_queued
        BEFORE INSERT ON events
        WHEN NEW.type = 'run.queued'
        BEGIN
          SELECT RAISE(ABORT, 'injected post-consumption failure');
        END;
      `);

      expect(() => dispatchNextWork(store, dispatchInput("rollback", item.id), baseTime))
        .toThrow("injected post-consumption failure");
      expect(store.getItem(item.id).status).toBe("ready");
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(store)).toEqual([]);
      expect(listReadyPromiseWakeups(store, baseTime)).toHaveLength(1);
      expect(store.listEvents(item.id)).toHaveLength(eventsBefore);
    } finally {
      store.close();
    }
  });

  test("ignores stale-generation and mismatched-promise rows", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const other = createItem(store, "other", "elsewhere");
      const stale = readyWakeup(store, item.id, 1);
      const mismatched = readyWakeup(store, other.id, 2);
      surveyDispatch(store, {}, baseTime);
      store.db.query("UPDATE work_promises SET generation = generation + 1 WHERE id = ?1").run(stale.id);
      store.db.query("UPDATE promise_wakeups SET item_id = ?1 WHERE promise_id = ?2")
        .run(item.id, mismatched.id);

      const survey = surveyDispatch(store, { project: "orchestration" }, baseTime);
      expect(survey.candidates.find((candidate) => candidate.itemId === item.id)?.readyPromiseWakeups)
        .toBe(0);
      const result = dispatchNextWork(store, dispatchInput("invalid-rows", item.id), baseTime);
      expect(result?.consumedPromiseWakeupIds).toEqual([]);
      expect(listPromiseWakeupConsumptions(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("persists consumption across restart and never revives it after run failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-wakeup-consumption-"));
    tempDirectories.push(directory);
    const path = join(directory, "ledger.sqlite");
    let itemId = "";
    let runId = "";
    let wakeupIds: string[] = [];

    const firstStore = new StensiblyStore(path);
    try {
      itemId = createItem(firstStore).id;
      readyWakeup(firstStore, itemId, 1);
      const result = dispatchNextWork(firstStore, dispatchInput("restart", itemId), baseTime)!;
      runId = result.run.id;
      wakeupIds = result.consumedPromiseWakeupIds;
      const starting = transitionWorkRun(firstStore, {
        id: result.run.id,
        actor: supervisor,
        command: "start",
        expectedGeneration: result.run.generation,
        expectedLeaseGeneration: result.run.leaseGeneration,
      }, new Date("2026-07-27T01:00:05.000Z"));
      const running = transitionWorkRun(firstStore, {
        id: starting.id,
        actor: supervisor,
        command: "run",
        expectedGeneration: starting.generation,
        expectedLeaseGeneration: starting.leaseGeneration,
      }, new Date("2026-07-27T01:00:10.000Z"));
      transitionWorkRun(firstStore, {
        id: running.id,
        actor: supervisor,
        command: "fail",
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        outcome: "terminal failure",
      }, new Date("2026-07-27T01:01:00.000Z"));
      expect(listReadyPromiseWakeups(firstStore, baseTime)).toEqual([]);
    } finally {
      firstStore.close();
    }

    const secondStore = new StensiblyStore(path);
    try {
      expect(listReadyPromiseWakeups(secondStore, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(secondStore, { runId })
        .map((entry) => entry.wakeupId)).toEqual(wakeupIds);
      expect(dispatchNextWork(secondStore, dispatchInput("restart", itemId), baseTime))
        .toMatchObject({ run: { id: runId }, consumedPromiseWakeupIds: wakeupIds });
    } finally {
      secondStore.close();
    }
  });

  test("altered replay conflicts without consuming a later wakeup", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      readyWakeup(store, item.id, 1);
      const request = dispatchInput("altered", item.id);
      const first = dispatchNextWork(store, request, baseTime)!;
      readyWakeup(store, item.id, 2);
      expect(() => dispatchNextWork(store, {
        ...request,
        runnerProfile: "changed",
      }, baseTime)).toThrow(ConflictError);
      expect(listPromiseWakeupConsumptions(store)).toHaveLength(1);
      expect(listReadyPromiseWakeups(store, baseTime).map((entry) => entry.id))
        .not.toContain(first.consumedPromiseWakeupIds[0]);
    } finally {
      store.close();
    }
  });
});
