import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchNextWork, surveyDispatch } from "../src/dispatcher.ts";
import {
  ensurePromiseWakeupConsumptionSchema,
  listDispatchablePromiseWakeups,
  listPromiseWakeupConsumptions,
  MAX_PROMISE_WAKEUPS_PER_DISPATCH,
} from "../src/promise-wakeup-consumptions.ts";
import {
  createWorkPromise,
  listReadyPromiseWakeups,
  resolveWorkPromise,
} from "../src/promises.ts";
import { listWorkRuns, transitionWorkRun } from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const worker = { id: "agent:worker", name: "Worker", kind: "agent" as const };
const baseTime = new Date("2026-07-27T00:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function createItem(
  store: StensiblyStore,
  title: string,
  project = "promise-consumption",
) {
  return store.createItem({
    project,
    kind: "task",
    title,
    summary: `Continue ${title}.`,
    nextAction: `Dispatch ${title}.`,
    priority: 50,
    actor: supervisor,
  });
}

function satisfyPromise(
  store: StensiblyStore,
  itemId: string,
  ordinal: number,
) {
  const promise = createWorkPromise(store, {
    itemId,
    actor: worker,
    action: `Resume promise ${ordinal}.`,
    wakeCondition: { kind: "manual" },
    expectedCheckInAt: "2030-01-01T00:00:00.000Z",
  }, new Date(baseTime.getTime() + ordinal));
  resolveWorkPromise(store, {
    id: promise.id,
    actor: supervisor,
    command: "satisfy",
    expectedGeneration: promise.generation,
  }, new Date(baseTime.getTime() + ordinal));
  return promise;
}

function dispatchInput(idempotencyKey: string, itemId?: string) {
  return {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    ...(itemId ? { itemId } : {}),
    leaseSeconds: 600,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    idempotencyKey,
  };
}

describe("promise wakeup dispatch consumption", () => {
  test("consumes one exact-current wakeup and removes its later ranking effect", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "one wakeup");
      satisfyPromise(store, item.id, 1);
      const ready = listReadyPromiseWakeups(store, baseTime);
      expect(ready).toHaveLength(1);
      expect(surveyDispatch(store, {}, baseTime).candidates[0]).toMatchObject({
        itemId: item.id,
        readyPromiseWakeups: 1,
      });

      const result = dispatchNextWork(store, dispatchInput("consume-one", item.id), baseTime);
      expect(result).not.toBeNull();
      expect(result?.promiseWakeupSource).toBe("local");
      expect(result?.dispatchCommandId).toMatch(/^dispatch_/);
      expect(result?.consumedPromiseWakeupIds).toEqual([ready[0]!.id]);
      expect(listReadyPromiseWakeups(store, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(store, { itemId: item.id })).toEqual([
        expect.objectContaining({
          wakeupId: ready[0]!.id,
          promiseId: ready[0]!.promiseId,
          promiseGeneration: ready[0]!.promiseGeneration,
          runId: result?.run.id,
          dispatchCommandId: result?.dispatchCommandId,
        }),
      ]);
      expect(store.listEvents(item.id).find((event) =>
        event.type === "promise.wakeups_consumed"
      )?.payload).toEqual({
        dispatchCommandId: result?.dispatchCommandId,
        runId: result?.run.id,
        wakeupIds: [ready[0]!.id],
        count: 1,
      });
    } finally {
      store.close();
    }
  });

  test("consumes multiple wakeups in deterministic created-time and ID order", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "ordered wakeups");
      satisfyPromise(store, item.id, 3);
      satisfyPromise(store, item.id, 1);
      satisfyPromise(store, item.id, 2);
      const expected = listReadyPromiseWakeups(store, baseTime)
        .filter((entry) => entry.itemId === item.id)
        .map((entry) => entry.id);

      const result = dispatchNextWork(store, dispatchInput("consume-ordered", item.id), baseTime);
      expect(result?.consumedPromiseWakeupIds).toEqual(expected);
      expect(listPromiseWakeupConsumptions(store, {
        dispatchCommandId: result?.dispatchCommandId ?? undefined,
      }).map((entry) => entry.wakeupId)).toEqual(expected);
    } finally {
      store.close();
    }
  });

  test("exact replay returns the original run and wakeup set without a second effect", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "replayed wakeups");
      satisfyPromise(store, item.id, 1);
      satisfyPromise(store, item.id, 2);
      const request = dispatchInput("consume-replay", item.id);
      const first = dispatchNextWork(store, request, baseTime);
      const consumptionCount = listPromiseWakeupConsumptions(store).length;
      const eventCount = store.listEvents(item.id).length;

      const second = dispatchNextWork(
        store,
        request,
        new Date(baseTime.getTime() + 300_000),
      );
      expect(second).toEqual(first);
      expect(listPromiseWakeupConsumptions(store)).toHaveLength(consumptionCount);
      expect(store.listEvents(item.id)).toHaveLength(eventCount);
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toHaveLength(1);
      expect(() => dispatchNextWork(store, {
        ...request,
        runnerProfile: "different",
      }, baseTime)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });

  test("rolls back claim, run, markers, events, and replay when the outer commit fails", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "rollback wakeups");
      satisfyPromise(store, item.id, 1);
      ensurePromiseWakeupConsumptionSchema(store);
      const ready = listReadyPromiseWakeups(store, baseTime);
      store.db.exec(`
        CREATE TRIGGER fail_promise_wakeup_dispatch_replay
        BEFORE INSERT ON promise_wakeup_dispatch_results
        BEGIN
          SELECT RAISE(ABORT, 'injected wakeup replay failure');
        END;
      `);

      expect(() => dispatchNextWork(
        store,
        dispatchInput("consume-rollback", item.id),
        baseTime,
      )).toThrow("injected wakeup replay failure");
      expect(store.getItem(item.id)).toMatchObject({ status: "ready", claimedBy: null });
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(store)).toEqual([]);
      expect(listReadyPromiseWakeups(store, baseTime).map((entry) => entry.id))
        .toEqual(ready.map((entry) => entry.id));
      expect(store.listEvents(item.id).some((event) =>
        event.type === "promise.wakeups_consumed" || event.type === "run.queued"
      )).toBe(false);
    } finally {
      store.close();
    }
  });

  test("rejects MAX plus one atomically and leaves every wakeup ready", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "overflow wakeups");
      for (let index = 0; index < MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1; index += 1) {
        satisfyPromise(store, item.id, index);
      }
      expect(listDispatchablePromiseWakeups(
        store,
        item.id,
        item.project,
      )).toHaveLength(MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1);

      expect(() => dispatchNextWork(
        store,
        dispatchInput("consume-overflow", item.id),
        baseTime,
      )).toThrow(`more than ${MAX_PROMISE_WAKEUPS_PER_DISPATCH}`);
      expect(store.getItem(item.id).status).toBe("ready");
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toEqual([]);
      expect(listPromiseWakeupConsumptions(store)).toEqual([]);
      expect(listReadyPromiseWakeups(store, baseTime))
        .toHaveLength(MAX_PROMISE_WAKEUPS_PER_DISPATCH + 1);
    } finally {
      store.close();
    }
  });

  test("does not consume stale-generation or mismatched-item wakeups", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const staleItem = createItem(store, "stale generation");
      const stalePromise = satisfyPromise(store, staleItem.id, 1);
      store.db.query(`
        UPDATE work_promises SET generation = generation + 1 WHERE id = ?1
      `).run(stalePromise.id);
      const staleResult = dispatchNextWork(
        store,
        dispatchInput("consume-stale", staleItem.id),
        baseTime,
      );
      expect(staleResult?.consumedPromiseWakeupIds).toEqual([]);

      const source = createItem(store, "source wakeup", "source-project");
      const target = createItem(store, "target item", "target-project");
      satisfyPromise(store, source.id, 2);
      const wakeup = listReadyPromiseWakeups(store, baseTime)
        .find((entry) => entry.itemId === source.id);
      if (!wakeup) throw new Error("Expected source wakeup");
      store.db.query("UPDATE promise_wakeups SET item_id = ?1 WHERE id = ?2")
        .run(target.id, wakeup.id);

      const targetResult = dispatchNextWork(
        store,
        dispatchInput("consume-cross-project", target.id),
        baseTime,
      );
      expect(targetResult?.consumedPromiseWakeupIds).toEqual([]);
      expect(listPromiseWakeupConsumptions(store, { itemId: target.id })).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("later run cancellation never revives a consumed wakeup", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "cancelled run");
      satisfyPromise(store, item.id, 1);
      const result = dispatchNextWork(store, dispatchInput("consume-cancel", item.id), baseTime);
      if (!result) throw new Error("Expected dispatch");
      transitionWorkRun(store, {
        id: result.run.id,
        actor: supervisor,
        command: "cancel",
        expectedGeneration: result.run.generation,
        expectedLeaseGeneration: result.run.leaseGeneration,
        leaseSeconds: 60,
      }, new Date(baseTime.getTime() + 1_000));
      store.db.query(`
        UPDATE items
        SET status = 'ready', claimed_by = NULL, claim_expires_at = NULL
        WHERE id = ?1
      `).run(item.id);

      expect(listReadyPromiseWakeups(store, baseTime)).toEqual([]);
      expect(surveyDispatch(store, { itemId: item.id } as any, baseTime).candidates[0])
        .toMatchObject({ itemId: item.id, readyPromiseWakeups: 0 });
    } finally {
      store.close();
    }
  });

  test("persists the exact consumption set and replay across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-wakeup-consumption-"));
    tempDirectories.push(directory);
    const path = join(directory, "ledger.sqlite");
    let itemId = "";
    let firstResult: ReturnType<typeof dispatchNextWork> = null;

    const first = new StensiblyStore(path);
    try {
      const item = createItem(first, "restart consumption");
      itemId = item.id;
      satisfyPromise(first, item.id, 1);
      satisfyPromise(first, item.id, 2);
      firstResult = dispatchNextWork(
        first,
        dispatchInput("consume-restart", item.id),
        baseTime,
      );
    } finally {
      first.close();
    }

    const second = new StensiblyStore(path);
    try {
      const replay = dispatchNextWork(
        second,
        dispatchInput("consume-restart", itemId),
        new Date(baseTime.getTime() + 60_000),
      );
      expect(replay).toEqual(firstResult);
      expect(listPromiseWakeupConsumptions(second, { itemId }).map((entry) => entry.wakeupId))
        .toEqual(firstResult?.consumedPromiseWakeupIds);
      expect(listReadyPromiseWakeups(second, baseTime)).toEqual([]);
    } finally {
      second.close();
    }
  });
});
