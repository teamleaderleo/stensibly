import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import { RunnerAdapterHostV1 } from "../src/runner-adapter-host.ts";
import {
  VERCEL_AI_SDK_ADAPTER_ID,
  VERCEL_AI_SDK_PROFILE_ID,
  VERCEL_AI_SDK_PROFILE_VERSION,
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
  test("returns a settled replay after the original durable lease expires", async () => {
    const fixture = createFixture();
    const input = {
      operationId: "host-settled-after-expiry",
      project: "runner_host_recovery",
    };
    try {
      const first = await fixture.host.startNext(input);
      expect(first?.disposition).toBe("executed");
      expireDurableRunLease(fixture.store);

      const replay = await fixture.host.startNext(input);

      expect(replay).toMatchObject({
        disposition: "settled_replay",
        command: null,
        observations: [],
        recovery: null,
        settlement: first?.settlement,
      });
      expect(replay?.run.status).toBe("abandoned");
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });

  test("claims deterministic non-executing recovery for an unsettled stranded command", async () => {
    const fixture = createFixture({ expireDuringModelCall: true });
    const input = {
      operationId: "host-stranded-recovery",
      project: "runner_host_recovery",
    };
    try {
      await expect(fixture.host.startNext(input)).rejects.toThrow(
        "Runner command authority expired before execution",
      );
      expireDurableRunLease(fixture.store);

      const recovered = await fixture.host.startNext(input);
      const replay = await fixture.host.startNext(input);

      expect(recovered).toMatchObject({
        disposition: "recovery_claimed",
        command: null,
        observations: [],
        settlement: null,
        recovery: {
          recoveryGeneration: 1,
          checkpoint: null,
          authorizesRedispatch: false,
          authorizesResume: false,
        },
      });
      expect(replay).toMatchObject({
        disposition: "recovery_claimed",
        recovery: recovered?.recovery,
      });
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
    } finally {
      fixture.store.close();
    }
  });
});

function createFixture(options: { expireDuringModelCall?: boolean } = {}) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project: "runner_host_recovery",
    kind: "task",
    title: "Recover one stranded runner command",
    summary: "Exercise durable host replay without redispatch.",
    nextAction: "Replay the command reservation after lease loss.",
    priority: 90,
    actor: supervisor,
  });
  dispatchNextWork(store, {
    actor: supervisor,
    runnerType: VERCEL_AI_SDK_ADAPTER_ID,
    runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
    runnerProfileVersion: VERCEL_AI_SDK_PROFILE_VERSION,
    itemId: item.id,
    leaseSeconds: 300,
    maxAttempts: 1,
    retryBackoffSeconds: 0,
    idempotencyKey: `dispatch:${item.id}`,
    executionEnvelope: compatibilityExecutionEnvelope("Recover one stranded runner command"),
  });

  let clock = new Date();
  const now = () => new Date(clock.getTime());
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      if (options.expireDuringModelCall) {
        clock = new Date(clock.getTime() + 60 * 60 * 1_000);
      }
      return textResult("bounded recovery test reply");
    },
  });
  const adapter = new VercelAISDKRunnerAdapter({
    agentSettings: {
      id: "runner-host-recovery",
      model,
      tools: {
        readOnlyProbe: tool({
          description: "Recovery replay conformance tool.",
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
    },
    checkpointStore: new CheckpointStore(),
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
  return { store, ledger, model, host };
}

function expireDurableRunLease(store: StensiblyStore): void {
  store.db.query(`
    UPDATE work_runs
    SET lease_expires_at = ?1
    WHERE id = (SELECT id FROM work_runs ORDER BY created_at ASC LIMIT 1)
  `).run(new Date(Date.now() - 1_000).toISOString());
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
