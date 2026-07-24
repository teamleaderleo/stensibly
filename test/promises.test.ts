import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkPromise,
  getWorkPromise,
  listReadyPromiseWakeups,
  listWorkPromises,
  reconcileWorkPromises,
  recordPromiseHeartbeat,
  resolveWorkPromise,
} from "../src/promises.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const actor = { id: "agent:builder", name: "Builder", kind: "agent" as const };
const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const baseTime = new Date("2026-07-25T10:00:00.000Z");
const farFuture = "2030-01-01T00:00:00.000Z";
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function createItem(store: StensiblyStore, title = "Resume durable work") {
  return store.createItem({
    project: "orchestration",
    kind: "task",
    title,
    summary: "Current coordination state.",
    nextAction: "Wait for the promised condition.",
    priority: 70,
    actor,
  });
}

function manualPromise(store: StensiblyStore, itemId: string, suffix: string) {
  return createWorkPromise(store, {
    itemId,
    actor,
    runnerProfile: "codex-default",
    action: `Resume ${suffix}`,
    question: "Is the condition ready?",
    wakeCondition: { kind: "manual" },
    expectedCheckInAt: farFuture,
    evidence: [{ kind: "note", label: "Initial context", note: suffix }],
    idempotencyKey: `promise-${suffix}`,
  }, baseTime);
}

describe("local work promises", () => {
  test("creates and replays an exact promise while touching the source item once", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const input = {
        itemId: item.id,
        actor,
        action: "Check the deployment after the hold period.",
        wakeCondition: { kind: "manual" as const },
        expectedCheckInAt: farFuture,
        idempotencyKey: "promise-create-1",
      };

      const created = createWorkPromise(store, input, baseTime);
      const replayed = createWorkPromise(store, input, new Date("2026-07-25T10:05:00.000Z"));
      expect(replayed).toEqual(created);
      expect(created).toMatchObject({
        itemId: item.id,
        responsibleActorId: actor.id,
        status: "pending",
        generation: 1,
        wakeCondition: { kind: "manual" },
      });
      expect(store.getItem(item.id).version).toBe(item.version + 1);
      expect(store.listEvents(item.id).filter((event) => event.type === "promise.created")).toHaveLength(1);
      expect(listWorkPromises(store, { itemId: item.id }, baseTime)).toHaveLength(1);

      expect(() => createWorkPromise(store, { ...input, action: "Different work" }, baseTime)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });

  test("satisfies a manual promise once with a generation guard and one ready wakeup", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const promise = manualPromise(store, item.id, "manual");
      const command = {
        id: promise.id,
        actor: supervisor,
        command: "satisfy" as const,
        expectedGeneration: 1,
        note: "Human approved continuation.",
        evidence: [{ kind: "decision", label: "Approved" }],
        idempotencyKey: "promise-satisfy-1",
      };

      const satisfied = resolveWorkPromise(store, command, new Date("2026-07-25T10:10:00.000Z"));
      const replayed = resolveWorkPromise(store, command, new Date("2026-07-25T10:11:00.000Z"));
      expect(replayed).toEqual(satisfied);
      expect(satisfied).toMatchObject({ status: "satisfied", generation: 2, resolutionActorId: supervisor.id });
      expect(listReadyPromiseWakeups(store, baseTime)).toEqual([
        expect.objectContaining({ promiseId: promise.id, promiseGeneration: 2, itemId: item.id, state: "ready" }),
      ]);
      expect(store.listEvents(item.id).filter((event) => event.type === "promise.satisfied")).toHaveLength(1);
      expect(() => resolveWorkPromise(store, { ...command, idempotencyKey: "stale", expectedGeneration: 1 }, baseTime)).toThrow(
        "generation changed",
      );
      expect(() => resolveWorkPromise(store, {
        id: promise.id,
        actor: supervisor,
        command: "cancel",
        expectedGeneration: 2,
      }, baseTime)).toThrow("cannot cancel while satisfied");
    } finally {
      store.close();
    }
  });

  test("satisfies a due wake before marking the same check-in missed and stays idempotent", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const promise = createWorkPromise(store, {
        itemId: item.id,
        actor,
        action: "Resume at the scheduled checkpoint.",
        wakeCondition: { kind: "at_time", at: "2026-07-25T10:30:00.000Z" },
        expectedCheckInAt: "2026-07-25T10:30:00.000Z",
      }, baseTime);

      const first = reconcileWorkPromises(store, new Date("2026-07-25T10:31:00.000Z"));
      const second = reconcileWorkPromises(store, new Date("2026-07-25T10:32:00.000Z"));
      expect(first.satisfied.map((entry) => entry.id)).toEqual([promise.id]);
      expect(first.missed).toEqual([]);
      expect(first.wakeups).toHaveLength(1);
      expect(second).toEqual({ satisfied: [], missed: [], wakeups: [] });
      expect(getWorkPromise(store, promise.id, baseTime).status).toBe("satisfied");
      expect(store.listEvents(item.id).filter((event) => ["promise.satisfied", "promise.missed"].includes(event.type))).toHaveLength(1);
      expect(listReadyPromiseWakeups(store, baseTime)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("marks missed check-ins and recovers them with an idempotent heartbeat", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const promise = createWorkPromise(store, {
        itemId: item.id,
        actor,
        action: "Report back after investigation.",
        wakeCondition: { kind: "manual" },
        expectedCheckInAt: "2026-07-25T10:15:00.000Z",
      }, baseTime);

      const reconciliation = reconcileWorkPromises(store, new Date("2026-07-25T10:16:00.000Z"));
      expect(reconciliation.missed).toEqual([expect.objectContaining({ id: promise.id, status: "missed", generation: 2 })]);

      const heartbeat = {
        id: promise.id,
        actor,
        expectedGeneration: 2,
        nextCheckInAt: "2026-07-25T11:00:00.000Z",
        evidence: [{ kind: "checkpoint", label: "Investigation resumed", uri: "git:checkpoint" }],
        idempotencyKey: "promise-heartbeat-1",
      };
      const recovered = recordPromiseHeartbeat(store, heartbeat, new Date("2026-07-25T10:20:00.000Z"));
      const replayed = recordPromiseHeartbeat(store, heartbeat, new Date("2026-07-25T10:21:00.000Z"));
      expect(replayed).toEqual(recovered);
      expect(recovered).toMatchObject({
        status: "pending",
        generation: 3,
        expectedCheckInAt: "2026-07-25T11:00:00.000Z",
        lastHeartbeatAt: "2026-07-25T10:20:00.000Z",
      });
      expect(recovered.evidence.at(-1)).toMatchObject({ label: "Investigation resumed" });
      expect(store.listEvents(item.id).filter((event) => event.type === "promise.recovered")).toHaveLength(1);
      expect(() => recordPromiseHeartbeat(store, { ...heartbeat, nextCheckInAt: farFuture }, baseTime)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });

  test("wakes from matching events and dependent item status", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Wait for evidence");
      const dependency = createItem(store, "Finish prerequisite");
      const eventPromise = createWorkPromise(store, {
        itemId: item.id,
        actor,
        action: "Review the recorded artifact.",
        wakeCondition: { kind: "after_event", eventType: "artifact.attached", delaySeconds: 60 },
        expectedCheckInAt: farFuture,
      }, baseTime);
      const dependencyPromise = createWorkPromise(store, {
        itemId: item.id,
        actor,
        action: "Continue after the prerequisite completes.",
        wakeCondition: { kind: "item_status", itemId: dependency.id, status: "done" },
        expectedCheckInAt: farFuture,
      }, baseTime);

      store.recordEvent({ itemId: item.id, actor, type: "artifact.attached", payload: { label: "result" } });
      store.completeItem(dependency.id, actor);
      const result = reconcileWorkPromises(store, new Date("2030-01-01T00:00:00.000Z"));
      expect(new Set(result.satisfied.map((entry) => entry.id))).toEqual(new Set([eventPromise.id, dependencyPromise.id]));
      expect(result.wakeups).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("supports escalation, cancellation, and supersession with guarded terminal states", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const escalatedBase = manualPromise(store, item.id, "escalated");
      const cancelledBase = manualPromise(store, item.id, "cancelled");
      const supersededBase = manualPromise(store, item.id, "superseded");

      const escalated = resolveWorkPromise(store, {
        id: escalatedBase.id,
        actor: supervisor,
        command: "escalate",
        expectedGeneration: 1,
        note: "Human decision required.",
      }, baseTime);
      const cancelled = resolveWorkPromise(store, {
        id: cancelledBase.id,
        actor,
        command: "cancel",
        expectedGeneration: 1,
      }, baseTime);
      const superseded = resolveWorkPromise(store, {
        id: supersededBase.id,
        actor,
        command: "supersede",
        expectedGeneration: 1,
      }, baseTime);

      expect(escalated.status).toBe("escalated");
      expect(cancelled.status).toBe("cancelled");
      expect(superseded.status).toBe("superseded");
      expect(() => recordPromiseHeartbeat(store, {
        id: escalated.id,
        actor,
        expectedGeneration: escalated.generation,
        nextCheckInAt: farFuture,
      }, baseTime)).toThrow("cannot receive a heartbeat while escalated");
    } finally {
      store.close();
    }
  });

  test("reconciles after closing and reopening the SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-promises-"));
    tempDirectories.push(directory);
    const path = join(directory, "ledger.sqlite");
    let itemId = "";
    let promiseId = "";

    const first = new StensiblyStore(path);
    try {
      const item = createItem(first);
      itemId = item.id;
      promiseId = createWorkPromise(first, {
        itemId,
        actor,
        action: "Resume after restart.",
        wakeCondition: { kind: "at_time", at: "2026-07-25T10:30:00.000Z" },
        expectedCheckInAt: farFuture,
      }, baseTime).id;
    } finally {
      first.close();
    }

    const second = new StensiblyStore(path);
    try {
      const result = reconcileWorkPromises(second, new Date("2026-07-25T10:31:00.000Z"));
      expect(result.satisfied).toEqual([expect.objectContaining({ id: promiseId, itemId, status: "satisfied" })]);
      expect(listReadyPromiseWakeups(second, baseTime)).toEqual([
        expect.objectContaining({ promiseId, itemId, state: "ready" }),
      ]);
    } finally {
      second.close();
    }
  });
});
