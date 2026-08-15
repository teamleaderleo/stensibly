import { describe, expect, test } from "bun:test";
import { dispatchNextWork } from "../src/dispatcher.ts";
import { getSqliteRunnerAdapterCommand } from "../src/runner-adapter-command-sqlite.ts";
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

describe("runner adapter command read", () => {
  test("reads the exact reserved command and later settlement by idempotency identity", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    try {
      const item = store.createItem({
        project: "runner_read",
        kind: "task",
        title: "Read one durable runner command",
        priority: 80,
        actor: supervisor,
      });
      dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        leaseSeconds: 900,
        idempotencyKey: "dispatch-runner-read",
      });
      const run = await ledger.claimRunnerWork({
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "runner_read",
        leaseSeconds: 900,
        idempotencyKey: "claim-runner-read",
      });
      if (!run) throw new Error("Runner read fixture was not claimed");

      const command = {
        project: "runner_read",
        itemId: item.id,
        runId: run.id,
        runGeneration: run.generation,
        leaseGeneration: run.leaseGeneration,
        actor: runner,
        adapterId: "vercel-ai-sdk",
        profileId: "default",
        requestFingerprint: `sha256:${"a".repeat(64)}`,
        commandId: "runner-read-command",
        commandFingerprint: `sha256:${"b".repeat(64)}`,
        idempotencyKey: "runner-read-command-key",
      };
      const reserved = await ledger.reserveRunnerAdapterCommand(command);

      expect(getSqliteRunnerAdapterCommand(store, {
        idempotencyKey: "missing-runner-command",
      })).toBeNull();
      const read = getSqliteRunnerAdapterCommand(store, {
        idempotencyKey: command.idempotencyKey,
      });
      expect(read).toEqual({
        command: reserved.command,
        settlement: null,
      });
      expect(Object.isFrozen(read)).toBe(true);
      expect(Object.isFrozen(read?.command)).toBe(true);

      const outcome = {
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
      const settled = await ledger.settleRunnerAdapterCommand({
        commandId: command.commandId,
        commandFingerprint: command.commandFingerprint,
        outcome,
      });
      expect(getSqliteRunnerAdapterCommand(store, {
        idempotencyKey: command.idempotencyKey,
      })).toEqual({
        command: reserved.command,
        settlement: settled.settlement,
      });
    } finally {
      store.close();
    }
  });

  test("rejects invalid read identities before storage access", () => {
    const store = new StensiblyStore(":memory:");
    try {
      expect(() => getSqliteRunnerAdapterCommand(store, {
        idempotencyKey: "   ",
      })).toThrow("between 1 and 240 characters");
    } finally {
      store.close();
    }
  });
});
