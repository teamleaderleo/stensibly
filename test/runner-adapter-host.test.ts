import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import {
  RunnerAdapterHostV1,
  RunnerObservationConsumerV1,
} from "../src/runner-adapter-host.ts";
import {
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
  type RunnerStartCommandV1,
} from "../src/runner-adapter-v1.ts";
import {
  VERCEL_AI_SDK_ADAPTER_ID,
  VERCEL_AI_SDK_PROFILE_ID,
  VercelAISDKRunnerAdapter,
  type VercelAISDKCheckpointRecordV1,
  type VercelAISDKCheckpointStore,
} from "../src/runner-adapters/vercel-ai-sdk.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:runner-host",
  name: "Runner Host Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:runner-host",
  name: "Runner Host",
  kind: "agent" as const,
};

class CheckpointStore implements VercelAISDKCheckpointStore {
  readonly records = new Map<string, VercelAISDKCheckpointRecordV1>();

  saveCheckpoint(record: VercelAISDKCheckpointRecordV1): void {
    this.records.set(record.externalId, structuredClone(record));
  }

  loadCheckpoint(externalId: string): VercelAISDKCheckpointRecordV1 | null {
    const record = this.records.get(externalId);
    return record ? structuredClone(record) : null;
  }
}

describe("runner adapter host v1", () => {
  test("claims and executes the AI SDK mock profile while persisting only bounded evidence", async () => {
    const fixture = createFixture();
    try {
      const result = await fixture.host.startNext({
        operationId: "ai-sdk-host-start-1",
        project: "runner_host",
      });

      if (!result || !result.command || !result.latestCheckpoint) {
        throw new Error("Expected one executed host result with a checkpoint");
      }
      expect(result.disposition).toBe("executed");
      expect(result.run).toMatchObject({
        status: "starting",
        generation: result.command.runGeneration,
        leaseGeneration: result.command.leaseGeneration,
      });
      expect(result.observations.map((entry) => entry.type)).toEqual([
        "start_accepted",
        "execution_started",
        "tool_surface_observed",
        "work_step",
        "checkpoint_published",
        "interrupted",
      ]);
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
      expect(fixture.checkpoints.records.size).toBe(1);

      const checkpoint = parseRunnerExternalReferenceV1(
        JSON.parse(result.run.checkpoint ?? "null"),
      );
      expect(checkpoint).toEqual(result.latestCheckpoint);
      expect(checkpoint.kind).toBe("checkpoint");

      const detail = await fixture.ledger.getItem(fixture.itemId);
      const receipts = detail.events.filter(
        (event) => event.type === "run.adapter.observation",
      );
      expect(receipts).toHaveLength(6);
      expect(detail.events.filter(
        (event) => event.type === "run.adapter.command_dispatched",
      )).toHaveLength(1);
      expect(detail.events.filter(
        (event) => event.type === "run.tool_surface_observed",
      )).toHaveLength(1);
      expect(detail.events.filter((event) => event.type === "run.heartbeat")).toHaveLength(1);
      const retained = JSON.stringify(receipts);
      expect(retained).not.toContain("AI SDK ToolLoopAgent completed");
      expect(retained).not.toContain("bounded AI SDK call completed");
      expect(retained).not.toContain("runner objective");
    } finally {
      fixture.store.close();
    }
  });

  test("uses the durable command reservation to prevent sequential blind redispatch", async () => {
    const fixture = createFixture();
    try {
      const input = {
        operationId: "ai-sdk-host-replay-1",
        project: "runner_host",
      };
      const first = await fixture.host.startNext(input);
      const replay = await fixture.host.startNext(input);

      expect(first?.disposition).toBe("executed");
      expect(replay).toMatchObject({
        disposition: "already_dispatched",
        command: null,
        observations: [],
      });
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
      const detail = await fixture.ledger.getItem(fixture.itemId);
      expect(detail.events.filter(
        (event) => event.type === "run.adapter.command_dispatched",
      )).toHaveLength(1);
      expect(detail.events.filter(
        (event) => event.type === "run.adapter.observation",
      )).toHaveLength(6);
    } finally {
      fixture.store.close();
    }
  });

  test("conflicts altered stable inputs under the same command reservation key", async () => {
    const fixture = createFixture();
    try {
      const operationId = "ai-sdk-host-altered-reservation-1";
      const first = await fixture.host.startNext({
        operationId,
        project: "runner_host",
        correlationId: "trace:first",
      });
      await expect(fixture.host.startNext({
        operationId,
        project: "runner_host",
        correlationId: "trace:changed",
      })).rejects.toThrow("idempotency key was already used for a different command");

      expect(first?.disposition).toBe("executed");
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  test("authorizes exactly one model dispatch across concurrent host instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stensibly-runner-host-"));
    const database = join(directory, "runner.db");
    const firstStore = new StensiblyStore(database);
    const firstLedger = new SqliteWorkLedger(firstStore);
    const item = firstStore.createItem({
      project: "runner_host",
      kind: "task",
      title: "Reserve one concurrent AI SDK host episode",
      summary: "Prove only one host may advance the adapter.",
      nextAction: "Race two exact command reservations.",
      priority: 90,
      actor: supervisor,
    });
    dispatchNextWork(firstStore, {
      actor: supervisor,
      runnerType: VERCEL_AI_SDK_ADAPTER_ID,
      runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
      itemId: item.id,
      leaseSeconds: 300,
      maxAttempts: 1,
      retryBackoffSeconds: 0,
      idempotencyKey: `dispatch:${item.id}`,
      executionEnvelope: compatibilityExecutionEnvelope("Reserve one host episode"),
    });
    const secondStore = new StensiblyStore(database);
    const secondLedger = new SqliteWorkLedger(secondStore);
    const firstModel = new MockLanguageModelV4({
      doGenerate: async () => textResult("first bounded reply"),
    });
    const secondModel = new MockLanguageModelV4({
      doGenerate: async () => textResult("second bounded reply"),
    });
    const host = (ledger: SqliteWorkLedger, model: MockLanguageModelV4) =>
      new RunnerAdapterHostV1({
        ledger,
        adapter: new VercelAISDKRunnerAdapter({
          agentSettings: {
            id: "runner-host-concurrent",
            model,
            tools: {},
          },
          checkpointStore: new CheckpointStore(),
        }),
        actor: runner,
        profileId: VERCEL_AI_SDK_PROFILE_ID,
        leaseSeconds: 300,
      });
    try {
      const input = {
        operationId: "ai-sdk-host-concurrent-1",
        project: "runner_host",
      };
      const [first, second] = await Promise.all([
        host(firstLedger, firstModel).startNext(input),
        host(secondLedger, secondModel).startNext(input),
      ]);

      expect([first?.disposition, second?.disposition].sort()).toEqual([
        "already_dispatched",
        "executed",
      ]);
      expect(firstModel.doGenerateCalls.length + secondModel.doGenerateCalls.length).toBe(1);
      const detail = await firstLedger.getItem(item.id);
      expect(detail.events.filter(
        (event) => event.type === "run.adapter.command_dispatched",
      )).toHaveLength(1);
    } finally {
      secondStore.close();
      firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects authority expiry during a stream before retaining the later observation", async () => {
    const fixture = createFixture({ expireDuringModelCall: true });
    try {
      await expect(fixture.host.startNext({
        operationId: "ai-sdk-host-expiry-1",
        project: "runner_host",
      })).rejects.toThrow("Runner command authority expired before execution");

      const detail = await fixture.ledger.getItem(fixture.itemId);
      expect(detail.events.filter(
        (event) => event.type === "run.adapter.observation",
      ).map((event) => (event.payload as { observationType?: string }).observationType)).toEqual([
        "start_accepted",
        "execution_started",
        "tool_surface_observed",
      ]);
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  test("rejects a conflicting same-ID observation before a second durable write", async () => {
    const fixture = createFixture();
    try {
      const started = await fixture.host.startNext({
        operationId: "ai-sdk-host-conflict-seed",
        project: "runner_host",
      });
      const command = started?.command;
      if (!command) throw new Error("Expected a host command");
      const run = await fixture.ledger.getRun(command.runId);
      const consumer = new RunnerObservationConsumerV1({
        ledger: fixture.ledger,
        descriptor: fixture.adapter.describe(),
        command,
        actor: runner,
        initialRun: run,
        leaseSeconds: 300,
        now: fixture.now,
      });
      const first = observation(command, "start_accepted", "observation-hostile-replay");
      const changed = observation(command, "execution_started", "observation-hostile-replay");

      await expect(consumer.consume(stream(first, changed))).rejects.toThrow(
        "was replayed with different content",
      );

      const detail = await fixture.ledger.getItem(fixture.itemId);
      expect(detail.events.filter(
        (event) =>
          event.type === "run.adapter.observation"
          && (event.payload as { observationId?: string }).observationId
            === "observation-hostile-replay",
      )).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  test("refuses a profile absent from the admitted adapter descriptor", () => {
    const fixture = createFixture();
    try {
      expect(() => new RunnerAdapterHostV1({
        ledger: fixture.ledger,
        adapter: fixture.adapter,
        actor: runner,
        profileId: "different-profile",
      })).toThrow("profile is absent");
    } finally {
      fixture.store.close();
    }
  });
});

function createFixture(options: { expireDuringModelCall?: boolean } = {}) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project: "runner_host",
    kind: "task",
    title: "Run one model-free AI SDK host episode",
    summary: "Prove the shared host without a provider or network request.",
    nextAction: "Claim the exact run and retain bounded observations.",
    priority: 90,
    actor: supervisor,
  });
  dispatchNextWork(store, {
    actor: supervisor,
    runnerType: VERCEL_AI_SDK_ADAPTER_ID,
    runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
    itemId: item.id,
    leaseSeconds: 300,
    maxAttempts: 1,
    retryBackoffSeconds: 0,
    idempotencyKey: `dispatch:${item.id}`,
    executionEnvelope: compatibilityExecutionEnvelope(
      "Run one model-free AI SDK host episode",
    ),
  });

  let clock = new Date();
  const now = () => new Date(clock.getTime());
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      if (options.expireDuringModelCall) {
        clock = new Date(clock.getTime() + 60 * 60 * 1_000);
      }
      return textResult("model-free bounded reply");
    },
  });
  const checkpoints = new CheckpointStore();
  const adapter = new VercelAISDKRunnerAdapter({
    agentSettings: {
      id: "runner-host-model-free",
      model,
      tools: {
        readOnlyProbe: tool({
          description: "A model-free host conformance tool.",
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
    },
    checkpointStore: checkpoints,
    now,
  });
  const host = new RunnerAdapterHostV1({
    ledger,
    adapter,
    actor: runner,
    profileId: VERCEL_AI_SDK_PROFILE_ID,
    requiredCapabilities: [{ class: "host_dynamic", id: "readOnlyProbe" }],
    leaseSeconds: 300,
    now,
  });
  return { store, ledger, itemId: item.id, model, checkpoints, adapter, host, now };
}

function observation(
  command: RunnerStartCommandV1,
  type: "start_accepted" | "execution_started",
  observationId: string,
) {
  return parseRunnerObservationV1({
    version: 1,
    type,
    observationId,
    commandId: command.commandId,
    correlationId: command.correlationId,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    profileVersion: command.profileVersion,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    observedAt: command.issuedAt,
    references: [],
    observationAuthority: "adapter_report",
    durableTransitionApplied: false,
  });
}

async function* stream(...values: RunnerObservationV1[]) {
  yield* values;
}

type RunnerObservationV1 = ReturnType<typeof parseRunnerObservationV1>;

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: {
      inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
    warnings: [],
  };
}
