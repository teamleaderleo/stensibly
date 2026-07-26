import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import type { ExecutionEnvelope } from "../src/execution-envelope.ts";
import { createWorkRun as createLegacyWorkRun } from "../src/runs-core.ts";
import {
  createWorkRun,
  getWorkRun,
  transitionWorkRun,
} from "../src/runs.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const runner = { id: "agent:runner", name: "Runner", kind: "agent" as const };
const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const baseTime = new Date("2026-07-26T10:00:00.000Z");

function envelope(overrides: Partial<ExecutionEnvelope> = {}): ExecutionEnvelope {
  return {
    schemaVersion: 1,
    objective: "Implement and verify the requested run",
    scopeClass: "segmented",
    estimate: {
      lowMinutes: 30,
      likelyMinutes: 60,
      highMinutes: 90,
      confidence: 0.6,
    },
    budget: {
      expectedMessages: 3,
      expectedToolCalls: 40,
      expectedReviewMinutes: 10,
    },
    boundaries: {
      softCheckpointMinutes: 70,
      forcedHandoffMinutes: 100,
      hardRecoveryMinutes: 120,
    },
    completion: {
      requiredOutputs: ["implementation", "tests"],
      verificationRequired: true,
      continuationStateRequired: true,
      acceptanceChecks: ["targeted tests pass"],
    },
    durableState: {
      accessClass: "project",
      retentionClass: "standard",
      redactionRequired: true,
      deleteAfter: null,
    },
    ...overrides,
  };
}

function createItem(store: StensiblyStore, title = "Run with an envelope") {
  return store.createItem({
    project: "orchestration",
    kind: "task",
    title,
    nextAction: "Dispatch the bounded run.",
    priority: 80,
    actor: supervisor,
  });
}

describe("local run execution envelopes", () => {
  test("persists one immutable envelope and compares it during replay", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const input = {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        leaseSeconds: 300,
        idempotencyKey: "enveloped-run-create",
        executionEnvelope: envelope(),
      };

      const created = createWorkRun(store, input, baseTime);
      const replayed = createWorkRun(store, input, baseTime);

      expect(replayed).toEqual(created);
      expect(created.executionEnvelope).toEqual(envelope());
      expect(created.executionRecords).toEqual([]);
      expect(store.listEvents(item.id).find((event) => event.type === "run.queued")?.payload)
        .toMatchObject({
          runId: created.id,
          generation: created.generation,
          leaseGeneration: created.leaseGeneration,
          envelopeSchemaVersion: 1,
        });

      expect(() => createWorkRun(store, {
        ...input,
        executionEnvelope: envelope({ objective: "A changed replay objective" }),
      }, baseTime)).toThrow(ConflictError);
      expect(getWorkRun(store, created.id).executionEnvelope).toEqual(envelope());
    } finally {
      store.close();
    }
  });

  test("appends terminal actuals without mutating the original estimate", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const originalEnvelope = envelope();
      const queued = createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        leaseSeconds: 7_200,
        executionEnvelope: originalEnvelope,
      }, baseTime);
      const starting = transitionWorkRun(store, {
        id: queued.id,
        actor: runner,
        command: "start",
        expectedGeneration: queued.generation,
        expectedLeaseGeneration: queued.leaseGeneration,
      }, new Date("2026-07-26T10:01:00.000Z"));
      const running = transitionWorkRun(store, {
        id: starting.id,
        actor: runner,
        command: "run",
        expectedGeneration: starting.generation,
        expectedLeaseGeneration: starting.leaseGeneration,
      }, new Date("2026-07-26T10:02:00.000Z"));
      const command = {
        id: running.id,
        actor: runner,
        command: "succeed" as const,
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        checkpoint: "Verification complete.",
        outcome: "Delivered the bounded change.",
        idempotencyKey: "enveloped-run-success",
        executionActual: {
          durationMinutes: 74.5,
          messagesConsumed: 4,
          toolCalls: 46,
          filesChanged: 12,
          reviewMinutes: 8,
          estimateErrorReasons: ["hidden dependency"],
        },
      };

      const succeeded = transitionWorkRun(
        store,
        command,
        new Date("2026-07-26T11:14:30.000Z"),
      );
      const replayed = transitionWorkRun(
        store,
        command,
        new Date("2026-07-26T11:20:00.000Z"),
      );

      expect(replayed).toEqual(succeeded);
      expect(succeeded.executionEnvelope).toEqual(originalEnvelope);
      expect(succeeded.executionRecords).toEqual([
        expect.objectContaining({
          runId: succeeded.id,
          runGeneration: succeeded.generation,
          leaseGeneration: succeeded.leaseGeneration,
          transition: "succeed",
          actual: command.executionActual,
        }),
      ]);
      expect(() => transitionWorkRun(store, {
        ...command,
        executionActual: { ...command.executionActual, filesChanged: 13 },
      }, new Date("2026-07-26T11:21:00.000Z"))).toThrow(ConflictError);
      expect(getWorkRun(store, succeeded.id).executionEnvelope).toEqual(originalEnvelope);
    } finally {
      store.close();
    }
  });

  test("keeps historical core-created rows readable as null and blocks key retrofits", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Legacy run");
      const legacy = createLegacyWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "legacy-profile",
        leaseSeconds: 300,
        idempotencyKey: "legacy-run-key",
      }, baseTime);

      expect(getWorkRun(store, legacy.id)).toMatchObject({
        id: legacy.id,
        executionEnvelope: null,
        executionRecords: [],
      });
      expect(() => createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "legacy-profile",
        leaseSeconds: 300,
        idempotencyKey: "legacy-run-key",
        executionEnvelope: envelope(),
      }, baseTime)).toThrow(/legacy run creation without an execution envelope/);
    } finally {
      store.close();
    }
  });

  test("binds dispatch envelopes and rejects changed-envelope replays", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Dispatch with envelope");
      const input = {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        leaseSeconds: 300,
        idempotencyKey: "enveloped-dispatch",
        executionEnvelope: envelope({ scopeClass: "atomic" }),
      };

      const first = dispatchNextWork(store, input, baseTime);
      const replayed = dispatchNextWork(store, input, baseTime);

      expect(replayed).toEqual(first);
      expect(first?.run.executionEnvelope).toEqual(input.executionEnvelope);
      expect(() => dispatchNextWork(store, {
        ...input,
        executionEnvelope: envelope({
          scopeClass: "exploratory",
          objective: "A different dispatch envelope",
        }),
      }, baseTime)).toThrow(ConflictError);
    } finally {
      store.close();
    }
  });
});
