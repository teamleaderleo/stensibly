import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:runner-read-supervisor",
  name: "Runner Read Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:runner-read",
  name: "Runner Read",
  kind: "agent" as const,
};

describe("SQLite runner adapter command read", () => {
  test("returns exact reservation and settlement and rejects mismatched stored identity", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const item = store.createItem({
        project: "runner_read",
        kind: "task",
        title: "Read one durable runner command",
        nextAction: "Verify coherent reservation and settlement identity.",
        priority: 80,
        actor: supervisor,
      });
      dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "vercel-ai-sdk",
        runnerProfile: "default",
        itemId: item.id,
        leaseSeconds: 300,
        maxAttempts: 1,
        retryBackoffSeconds: 0,
        idempotencyKey: `dispatch:${item.id}`,
        executionEnvelope: compatibilityExecutionEnvelope(
          "Read one durable runner command",
        ),
      });
      const claimed = await ledger.claimRunnerWork({
        actor: runner,
        runnerType: "vercel-ai-sdk",
        runnerProfile: "default",
        project: "runner_read",
        leaseSeconds: 300,
        concurrency: { globalLimit: 4, projectLimit: 2 },
        idempotencyKey: "runner-read-claim",
      });
      if (!claimed) throw new Error("Runner read fixture was not claimable");

      const idempotencyKey = "runner-read-reservation";
      const commandId = "command-runner-read";
      const commandFingerprint = `sha256:${"b".repeat(64)}`;
      await ledger.reserveRunnerAdapterCommand({
        project: "runner_read",
        itemId: item.id,
        runId: claimed.id,
        runGeneration: claimed.generation,
        leaseGeneration: claimed.leaseGeneration,
        actor: runner,
        adapterId: "vercel-ai-sdk",
        profileId: "default",
        requestFingerprint: `sha256:${"a".repeat(64)}`,
        commandId,
        commandFingerprint,
        idempotencyKey,
      });

      expect(await ledger.getRunnerAdapterCommand({ idempotencyKey })).toMatchObject({
        command: {
          commandId,
          commandFingerprint,
          runId: claimed.id,
          runGeneration: claimed.generation,
          leaseGeneration: claimed.leaseGeneration,
          idempotencyKey,
        },
        settlement: null,
      });

      const settled = await ledger.settleRunnerAdapterCommand({
        commandId,
        commandFingerprint,
        outcome: commandOutcome(),
      });
      expect(await ledger.getRunnerAdapterCommand({ idempotencyKey })).toEqual({
        command: expect.objectContaining({ commandId, commandFingerprint }),
        settlement: settled.settlement,
      });

      const row = store.db.query<{ settlement_json: string }, [string]>(`
        SELECT settlement_json
        FROM runner_adapter_commands
        WHERE idempotency_key = ?1
      `).get(idempotencyKey);
      if (!row) throw new Error("Runner read settlement fixture disappeared");
      const malformed = {
        ...(JSON.parse(row.settlement_json) as Record<string, unknown>),
        commandId: "command-runner-read-corrupt",
      };
      store.db.query(`
        UPDATE runner_adapter_commands
        SET settlement_json = ?1
        WHERE idempotency_key = ?2
      `).run(JSON.stringify(malformed), idempotencyKey);

      await expect(ledger.getRunnerAdapterCommand({ idempotencyKey }))
        .rejects.toThrow("settlement changed command identity");
    } finally {
      store.close();
    }
  });
});

function commandOutcome() {
  return {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 1,
    observationsSha256: `sha256:${"c".repeat(64)}`,
    terminalObservationId: "runner-read-terminal",
    terminalObservationType: "interrupted",
    latestCheckpointExternalId: null,
    latestCheckpointSha256: null,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}
