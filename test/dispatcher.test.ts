import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchNextWork, surveyDispatch } from "../src/dispatcher.ts";
import { createWorkPromise, resolveWorkPromise } from "../src/promises.ts";
import {
  createWorkRun,
  listWorkRuns,
  transitionWorkRun,
} from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const supervisor = { id: "service:supervisor", name: "Supervisor", kind: "service" as const };
const otherSupervisor = { id: "service:other", name: "Other Supervisor", kind: "service" as const };
const agent = { id: "agent:worker", name: "Worker", kind: "agent" as const };
const human = { id: "human:leo", name: "Leo", kind: "human" as const };
const baseTime = new Date("2026-07-25T10:00:00.000Z");
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
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
    summary: `Coordinate ${title}.`,
    nextAction: `Dispatch ${title}.`,
    priority,
    actor: supervisor,
  });
}

function dispatchInput(idempotencyKey: string, overrides = {}) {
  return {
    actor: supervisor,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    leaseSeconds: 600,
    maxAttempts: 3,
    retryBackoffSeconds: 60,
    continuationRef: "continuation:approved",
    idempotencyKey,
    ...overrides,
  };
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
    actor: agent,
    command,
    expectedGeneration: run.generation,
    expectedLeaseGeneration: run.leaseGeneration,
    leaseSeconds: 300,
    ...overrides,
  }, now);
}

describe("local supervisor dispatch", () => {
  test("ranks promise wakeups before priority, then priority and age", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const oldHigh = createItem(store, "old high priority", 90);
      const newHigh = createItem(store, "new high priority", 90);
      const wakeItem = createItem(store, "promised continuation", 10);
      createItem(store, "other project", 100, "elsewhere");
      store.db.query("UPDATE items SET created_at = ?1 WHERE id = ?2").run("2026-07-25T09:00:00.000Z", oldHigh.id);
      store.db.query("UPDATE items SET created_at = ?1 WHERE id = ?2").run("2026-07-25T09:30:00.000Z", newHigh.id);
      store.db.query("UPDATE items SET created_at = ?1 WHERE id = ?2").run("2026-07-25T09:45:00.000Z", wakeItem.id);

      const promise = createWorkPromise(store, {
        itemId: wakeItem.id,
        actor: agent,
        action: "Resume the promised continuation.",
        wakeCondition: { kind: "manual" },
        expectedCheckInAt: "2030-01-01T00:00:00.000Z",
      }, baseTime);
      resolveWorkPromise(store, {
        id: promise.id,
        actor: supervisor,
        command: "satisfy",
        expectedGeneration: promise.generation,
      }, baseTime);

      const survey = surveyDispatch(store, { project: "orchestration", limit: 10 }, baseTime);
      expect(survey.candidates.map((candidate) => candidate.itemId)).toEqual([
        wakeItem.id,
        oldHigh.id,
        newHigh.id,
      ]);
      expect(survey.candidates[0]).toMatchObject({
        readyPromiseWakeups: 1,
        priority: 10,
      });
      expect(survey.candidates[0]?.explanation[0]).toContain("1 durable promise wakeup ready");
      expect(survey.candidates.some((candidate) => candidate.project === "elsewhere")).toBe(false);
    } finally {
      store.close();
    }
  });

  test("reconciles stale and retryable runs while excluding live run items", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const available = createItem(store, "available", 50);
      const liveItem = createItem(store, "already running", 100);
      const retryItem = createItem(store, "retry later", 95);
      const staleItem = createItem(store, "stale runner", 90);

      createWorkRun(store, {
        itemId: liveItem.id,
        actor: agent,
        runnerType: "generic-mcp",
        runnerProfile: "live",
        leaseSeconds: 600,
      }, baseTime);

      const retryQueued = createWorkRun(store, {
        itemId: retryItem.id,
        actor: agent,
        runnerType: "generic-mcp",
        runnerProfile: "retry",
        leaseSeconds: 600,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
      }, baseTime);
      const retryStarting = transition(store, retryQueued, "start", new Date("2026-07-25T10:00:10.000Z"));
      const retryRunning = transition(store, retryStarting, "run", new Date("2026-07-25T10:00:20.000Z"));
      transition(store, retryRunning, "fail", new Date("2026-07-25T10:01:00.000Z"), {
        outcome: "Transient failure.",
      });

      const staleQueued = createWorkRun(store, {
        itemId: staleItem.id,
        actor: agent,
        runnerType: "generic-mcp",
        runnerProfile: "stale",
        leaseSeconds: 60,
      }, baseTime);
      const staleStarting = transition(store, staleQueued, "start", new Date("2026-07-25T10:00:10.000Z"));
      const staleRunning = transition(store, staleStarting, "run", new Date("2026-07-25T10:00:20.000Z"));

      const survey = surveyDispatch(store, { limit: 10 }, new Date("2026-07-25T10:02:01.000Z"));
      expect(survey.candidates.map((candidate) => candidate.itemId)).toContain(available.id);
      expect(survey.candidates.map((candidate) => candidate.itemId)).toContain(staleItem.id);
      expect(survey.candidates.map((candidate) => candidate.itemId)).not.toContain(liveItem.id);
      expect(survey.candidates.map((candidate) => candidate.itemId)).not.toContain(retryItem.id);
      expect(survey.retryEligibleRuns).toEqual([
        expect.objectContaining({ itemId: retryItem.id, status: "failed", retryAttempt: 1 }),
      ]);
      expect(survey.reconciliation.abandonedRunIds).toEqual([staleRunning.id]);
    } finally {
      store.close();
    }
  });

  test("atomically claims the top item and creates one queued run", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const lower = createItem(store, "lower", 40);
      const selected = createItem(store, "selected", 80);
      const initial = store.getItem(selected.id);
      const result = dispatchNextWork(store, dispatchInput("dispatch-1"), baseTime);

      expect(result).not.toBeNull();
      expect(result?.item).toMatchObject({
        id: selected.id,
        status: "active",
        claimedBy: supervisor.id,
        claimExpiresAt: "2026-07-25T10:10:00.000Z",
        version: initial.version + 1,
      });
      expect(result?.run).toMatchObject({
        itemId: selected.id,
        actorId: supervisor.id,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        status: "queued",
        generation: 1,
        leaseGeneration: 1,
        leaseOwnerId: supervisor.id,
        leaseExpiresAt: "2026-07-25T10:10:00.000Z",
        continuationRef: "continuation:approved",
        retryAttempt: 0,
        maxAttempts: 3,
      });
      expect(store.getItem(lower.id).status).toBe("ready");
      const events = store.listEvents(selected.id);
      expect(events.filter((event) => event.type === "claim.created")).toHaveLength(1);
      expect(events.filter((event) => event.type === "run.queued")).toHaveLength(1);
      expect(events.find((event) => event.type === "run.queued")?.payload).toMatchObject({
        source: "supervisor_dispatch",
        runId: result?.run.id,
      });
    } finally {
      store.close();
    }
  });

  test("replays exact dispatch without duplicate events or version changes", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "replayed", 70);
      const request = dispatchInput("dispatch-replay");
      const first = dispatchNextWork(store, request, baseTime);
      const version = store.getItem(item.id).version;
      const eventCount = store.listEvents(item.id).length;
      const second = dispatchNextWork(store, request, new Date("2026-07-25T10:05:00.000Z"));

      expect(second).toEqual(first);
      expect(store.getItem(item.id).version).toBe(version);
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

  test("prevents two supervisors from dispatching the same only item", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "single candidate", 60);
      const first = dispatchNextWork(store, dispatchInput("dispatch-first"), baseTime);
      const second = dispatchNextWork(store, dispatchInput("dispatch-second", {
        actor: otherSupervisor,
        runnerProfile: "other",
      }), baseTime);

      expect(first?.item.id).toBe(item.id);
      expect(second).toBeNull();
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toHaveLength(1);
      expect(store.listEvents(item.id).filter((event) => event.type === "run.queued")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("replays a no-candidate dispatch as the original no-op", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const request = dispatchInput("dispatch-empty");
      expect(dispatchNextWork(store, request, baseTime)).toBeNull();
      createItem(store, "created later", 100);
      expect(dispatchNextWork(store, request, new Date("2026-07-25T10:01:00.000Z"))).toBeNull();
      expect(surveyDispatch(store, {}, baseTime).candidates).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("validates actor and project boundaries before mutating", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "protected", 60);
      expect(() => dispatchNextWork(store, dispatchInput("human-dispatch", {
        actor: human,
      }), baseTime)).toThrow("agent or service");
      expect(() => dispatchNextWork(store, dispatchInput("invalid-project", {
        project: "Not Valid",
      }), baseTime)).toThrow("lowercase slug");
      expect(store.getItem(item.id).status).toBe("ready");
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("keeps the dispatched claim and run visible after process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-dispatch-"));
    tempDirectories.push(directory);
    const path = join(directory, "ledger.sqlite");
    let itemId = "";
    let runId = "";

    const first = new StensiblyStore(path);
    try {
      itemId = createItem(first, "restart visible", 75).id;
      const result = dispatchNextWork(first, dispatchInput("dispatch-restart"), baseTime);
      if (!result) throw new Error("Expected a dispatched run");
      runId = result.run.id;
    } finally {
      first.close();
    }

    const second = new StensiblyStore(path);
    try {
      expect(second.getItem(itemId)).toMatchObject({
        status: "active",
        claimedBy: supervisor.id,
      });
      expect(listWorkRuns(second, { itemId }, baseTime)).toEqual([
        expect.objectContaining({ id: runId, status: "queued", itemId }),
      ]);
      expect(surveyDispatch(second, {}, baseTime).candidates.map((candidate) => candidate.itemId)).not.toContain(itemId);
    } finally {
      second.close();
    }
  });
});
