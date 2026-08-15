import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import { RunnerAdapterHostV1 } from "../src/runner-adapter-host.ts";
import { parseRunnerExternalReferenceV1 } from "../src/runner-adapter-v1.ts";
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
  id: "service:runner-host-recovery",
  name: "Runner Host Recovery Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:runner-host-recovery",
  name: "Runner Host Recovery",
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

describe("runner adapter host recovery replay", () => {
  test("replays a committed settlement after original run authority expires", async () => {
    const fixture = createFixture();
    let loseFirstResponse = true;
    const unreliableLedger = new Proxy(fixture.ledger, {
      get(target, property, receiver) {
        if (property === "settleRunnerAdapterCommand") {
          return async (
            input: Parameters<typeof target.settleRunnerAdapterCommand>[0],
          ) => {
            const result = await target.settleRunnerAdapterCommand(input);
            if (loseFirstResponse) {
              loseFirstResponse = false;
              throw new Error("simulated settlement response loss");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const unreliableHost = hostFor(fixture, unreliableLedger);
    const input = {
      operationId: "host-recovery-settled-response-loss",
      project: "runner_host_recovery",
    };
    try {
      await expect(unreliableHost.startNext(input)).rejects.toThrow(
        "simulated settlement response loss",
      );
      expireRunLease(fixture.store, onlyRunId(fixture.store));

      const replay = await fixture.host.startNext(input);
      expect(replay).toMatchObject({
        disposition: "settled_replay",
        command: null,
        observations: [],
        recovery: null,
        settlement: {
          outcome: {
            kind: "bounded_episode_completed",
            observationCount: 6,
          },
        },
      });
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  test("keeps live replay inert, then claims exact stranded recovery with checkpoint lineage", async () => {
    const fixture = createFixture();
    const unsettledLedger = new Proxy(fixture.ledger, {
      get(target, property, receiver) {
        if (property === "settleRunnerAdapterCommand") {
          return async () => {
            throw new Error("simulated unsettled command");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const unsettledHost = hostFor(fixture, unsettledLedger);
    const input = {
      operationId: "host-recovery-stranded",
      project: "runner_host_recovery",
    };
    try {
      await expect(unsettledHost.startNext(input)).rejects.toThrow(
        "simulated unsettled command",
      );
      const runId = onlyRunId(fixture.store);
      const liveRun = await fixture.ledger.getRun(runId);
      const checkpoint = parseRunnerExternalReferenceV1(
        JSON.parse(liveRun.checkpoint ?? "null"),
      );

      const liveReplay = await fixture.host.startNext(input);
      expect(liveReplay).toMatchObject({
        disposition: "already_dispatched",
        command: null,
        observations: [],
        settlement: null,
        recovery: null,
      });
      expect(fixture.model.doGenerateCalls).toHaveLength(1);

      expireRunLease(fixture.store, runId);
      const recovered = await fixture.host.startNext(input);
      expect(recovered).toMatchObject({
        disposition: "recovery_claimed",
        command: null,
        observations: [],
        settlement: null,
        recovery: {
          commandId: expect.any(String),
          commandFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          recoveryGeneration: 1,
          checkpoint: {
            externalId: checkpoint.externalId,
            checkpointDigest: checkpoint.digest,
            runGeneration: checkpoint.generation,
          },
          authorizesRedispatch: false,
          authorizesResume: false,
        },
      });
      expect(fixture.model.doGenerateCalls).toHaveLength(1);

      const exactReplay = await fixture.host.startNext(input);
      expect(exactReplay?.disposition).toBe("recovery_claimed");
      expect(exactReplay?.recovery).toEqual(recovered?.recovery);
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });
});

function createFixture() {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project: "runner_host_recovery",
    kind: "task",
    title: "Recover one stranded runner host episode",
    summary: "Keep recovery read-only after original authority expires.",
    nextAction: "Replay durable command state before rebuilding a command.",
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
      "Recover one stranded runner host episode",
    ),
  });
  const model = new MockLanguageModelV4({
    doGenerate: async () => textResult("bounded recovery fixture reply"),
  });
  const checkpoints = new CheckpointStore();
  const adapter = new VercelAISDKRunnerAdapter({
    agentSettings: {
      id: "runner-host-recovery",
      model,
      tools: {},
    },
    checkpointStore: checkpoints,
  });
  const fixture = { store, ledger, model, checkpoints, adapter };
  return { ...fixture, host: hostFor(fixture, ledger) };
}

function hostFor(
  fixture: {
    adapter: VercelAISDKRunnerAdapter;
  },
  ledger: SqliteWorkLedger,
) {
  return new RunnerAdapterHostV1({
    ledger,
    adapter: fixture.adapter,
    actor: runner,
    profileId: VERCEL_AI_SDK_PROFILE_ID,
    leaseSeconds: 300,
  });
}

function onlyRunId(store: StensiblyStore): string {
  const row = store.db.query<{ id: string }, []>(`
    SELECT id FROM work_runs LIMIT 1
  `).get();
  if (!row) throw new Error("Runner host recovery fixture run disappeared");
  return row.id;
}

function expireRunLease(store: StensiblyStore, runId: string): void {
  store.db.query(`
    UPDATE work_runs SET lease_expires_at = ?1 WHERE id = ?2
  `).run(new Date(Date.now() - 1_000).toISOString(), runId);
}

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
