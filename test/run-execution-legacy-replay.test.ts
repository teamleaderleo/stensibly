import { describe, expect, test } from "bun:test";
import {
  dispatchNextWork as dispatchLegacyWork,
} from "../src/dispatcher-core.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import type { ExecutionEnvelope } from "../src/execution-envelope.ts";
import { createWorkRun as createLegacyRun } from "../src/runs-core.ts";
import { createWorkRun } from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const runner = { id: "agent:runner", name: "Runner", kind: "agent" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const now = new Date("2026-07-26T12:00:00.000Z");

const executionEnvelope: ExecutionEnvelope = {
  schemaVersion: 1,
  objective: "Do not retrofit this historical run",
  scopeClass: "atomic",
  estimate: {
    lowMinutes: 10,
    likelyMinutes: 20,
    highMinutes: 30,
    confidence: 0.7,
  },
  budget: {
    expectedMessages: 2,
    expectedToolCalls: 10,
    expectedReviewMinutes: 3,
  },
  boundaries: {
    softCheckpointMinutes: 25,
    forcedHandoffMinutes: 35,
    hardRecoveryMinutes: 45,
  },
  completion: {
    requiredOutputs: ["result"],
    verificationRequired: true,
    continuationStateRequired: true,
    acceptanceChecks: ["result is verified"],
  },
  durableState: {
    accessClass: "project",
    retentionClass: "standard",
    redactionRequired: true,
    deleteAfter: null,
  },
};

function createItem(store: StensiblyStore, title: string) {
  return store.createItem({
    project: "orchestration",
    kind: "task",
    title,
    nextAction: "Run the historical replay test.",
    priority: 70,
    actor: supervisor,
  });
}

describe("historical execution-envelope replay", () => {
  test("replays a legacy direct creation as an explicit missing envelope", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Legacy direct creation");
      const input = {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "legacy-profile",
        leaseSeconds: 300,
        idempotencyKey: "legacy-direct-creation",
      };
      const legacy = createLegacyRun(store, input, now);
      const replay = createWorkRun(store, input, now);

      expect(replay).toMatchObject({
        id: legacy.id,
        executionEnvelope: null,
        executionRecords: [],
      });
      expect(() => createWorkRun(store, {
        ...input,
        executionEnvelope,
      }, now)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });

  test("replays a legacy dispatch result without attaching a default envelope", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Legacy dispatch");
      const input = {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "legacy-profile",
        itemId: item.id,
        leaseSeconds: 300,
        idempotencyKey: "legacy-dispatch",
      };
      const legacy = dispatchLegacyWork(store, input, now);
      const replay = dispatchNextWork(store, input, now);

      expect(replay?.run).toMatchObject({
        id: legacy?.run.id,
        executionEnvelope: null,
        executionRecords: [],
      });
      expect(() => dispatchNextWork(store, {
        ...input,
        executionEnvelope,
      }, now)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });
});
