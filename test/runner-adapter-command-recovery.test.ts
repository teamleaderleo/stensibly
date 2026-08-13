import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchNextWork } from "../src/dispatcher.ts";
import type {
  ClaimRunnerAdapterCommandRecoveryInput,
  RunnerAdapterCommandRecoveryClaim,
} from "../src/runner-adapter-command-recovery.ts";
import { claimSqliteRunnerAdapterCommandRecovery } from "../src/runner-adapter-command-recovery-sqlite.ts";
import { RunnerAdapterCommandConflictError } from "../src/runner-adapter-command-contracts.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const runnerA = { id: "agent:runner-a", name: "Runner A", kind: "agent" as const };
const runnerB = { id: "agent:runner-b", name: "Runner B", kind: "agent" as const };
const recoveryAt = new Date("2026-08-13T04:00:00.000Z");

describe("runner adapter command recovery ownership", () => {
  test("waits for original authority, binds durable checkpoint lineage, and advances generations", async () => {
    const fixture = await createFixture("recovery-lineage");
    try {
      expect(() => claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        recoveryInput(fixture.commandId, fixture.commandFingerprint, runnerA, "recovery-live"),
        new Date(fixture.claimedAt),
      )).toThrow(RunnerAdapterCommandConflictError);

      const checkpoint = checkpointReference(fixture.runGeneration);
      await fixture.ledger.heartbeatRun({
        id: fixture.runId,
        actor: runnerA,
        expectedGeneration: fixture.runGeneration,
        expectedLeaseGeneration: fixture.leaseGeneration,
        leaseSeconds: 900,
        checkpoint: JSON.stringify(checkpoint),
        idempotencyKey: "recovery-checkpoint-heartbeat",
      });
      fixture.store.db.query(`
        UPDATE work_runs SET lease_expires_at = ?1 WHERE id = ?2
      `).run(new Date(recoveryAt.getTime() - 1).toISOString(), fixture.runId);

      const firstInput = recoveryInput(
        fixture.commandId,
        fixture.commandFingerprint,
        runnerB,
        "recovery-owner-first",
      );
      const first = claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        firstInput,
        recoveryAt,
      );
      expect(first).toMatchObject({
        outcome: "claimed",
        claim: {
          commandId: fixture.commandId,
          commandFingerprint: fixture.commandFingerprint,
          runId: fixture.runId,
          runGeneration: fixture.runGeneration,
          leaseGeneration: fixture.leaseGeneration,
          recoveryGeneration: 1,
          actor: runnerB,
          checkpoint: {
            version: 1,
            externalId: checkpoint.externalId,
            checkpointDigest: checkpoint.digest,
            referenceSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            runGeneration: fixture.runGeneration,
            createdAt: checkpoint.createdAt,
          },
          authorizesRedispatch: false,
          authorizesResume: false,
        },
      });
      expect(claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        firstInput,
        new Date(recoveryAt.getTime() + 1_000),
      )).toEqual({ ...first, outcome: "replayed" });
      expect(() => claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        { ...firstInput, leaseSeconds: 120 },
        new Date(recoveryAt.getTime() + 1_000),
      )).toThrow(RunnerAdapterCommandConflictError);
      expect(() => claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        recoveryInput(
          fixture.commandId,
          fixture.commandFingerprint,
          runnerA,
          "recovery-owner-competing",
        ),
        new Date(recoveryAt.getTime() + 1_000),
      )).toThrow(RunnerAdapterCommandConflictError);

      const secondAt = new Date(recoveryAt.getTime() + 61_000);
      const second = claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        recoveryInput(
          fixture.commandId,
          fixture.commandFingerprint,
          runnerA,
          "recovery-owner-second",
        ),
        secondAt,
      );
      expect(second).toMatchObject({
        outcome: "claimed",
        claim: {
          recoveryGeneration: 2,
          actor: runnerA,
          checkpoint: first.claim.checkpoint,
          authorizesRedispatch: false,
          authorizesResume: false,
        },
      });
      expect(fixture.store.db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM runner_adapter_command_recoveries
      `).get()?.count).toBe(2);
    } finally {
      fixture.close();
    }
  });

  test("keeps null checkpoint lineage explicit and rejects recovery after settlement", async () => {
    const fixture = await createFixture("recovery-null");
    try {
      fixture.store.db.query(`
        UPDATE work_runs SET lease_expires_at = ?1 WHERE id = ?2
      `).run(new Date(recoveryAt.getTime() - 1).toISOString(), fixture.runId);
      const claimed = claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        recoveryInput(
          fixture.commandId,
          fixture.commandFingerprint,
          runnerB,
          "recovery-null-checkpoint",
        ),
        recoveryAt,
      );
      expect(claimed.claim.checkpoint).toBeNull();

      await fixture.ledger.settleRunnerAdapterCommand({
        commandId: fixture.commandId,
        commandFingerprint: fixture.commandFingerprint,
        outcome: {
          version: 1,
          kind: "bounded_episode_completed",
          observationCount: 1,
          observationsSha256: `sha256:${"1".repeat(64)}`,
          terminalObservationId: "terminal-after-recovery",
          terminalObservationType: "interrupted",
          latestCheckpointExternalId: null,
          latestCheckpointSha256: null,
          containsPrivateContent: false,
          containsCredentials: false,
        },
      });
      expect(() => claimSqliteRunnerAdapterCommandRecovery(
        fixture.store,
        recoveryInput(
          fixture.commandId,
          fixture.commandFingerprint,
          runnerA,
          "recovery-after-settlement",
        ),
        new Date(recoveryAt.getTime() + 61_000),
      )).toThrow(RunnerAdapterCommandConflictError);
    } finally {
      fixture.close();
    }
  });

  test("authorizes one recovery owner across concurrent SQLite processes", async () => {
    const fixture = await createFixture("recovery-concurrent");
    const databasePath = fixture.databasePath;
    const commandId = fixture.commandId;
    const commandFingerprint = fixture.commandFingerprint;
    fixture.store.db.query(`
      UPDATE work_runs SET lease_expires_at = ?1 WHERE id = ?2
    `).run(new Date(recoveryAt.getTime() - 1).toISOString(), fixture.runId);
    fixture.closeStoreOnly();
    try {
      const [alpha, beta] = await Promise.allSettled([
        spawnRecovery(databasePath, {
          ...recoveryInput(commandId, commandFingerprint, runnerA, "concurrent-alpha"),
          now: recoveryAt.toISOString(),
        }),
        spawnRecovery(databasePath, {
          ...recoveryInput(commandId, commandFingerprint, runnerB, "concurrent-beta"),
          now: recoveryAt.toISOString(),
        }),
      ]);
      const fulfilled = [alpha, beta].filter(
        (result): result is PromiseFulfilledResult<RunnerAdapterCommandRecoveryClaim> =>
          result.status === "fulfilled",
      );
      const rejected = [alpha, beta].filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(fulfilled[0]!.value.claim.recoveryGeneration).toBe(1);
      expect(fulfilled[0]!.value.claim.authorizesRedispatch).toBe(false);
      expect(fulfilled[0]!.value.claim.authorizesResume).toBe(false);

      const inspect = new StensiblyStore(databasePath);
      try {
        expect(inspect.db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM runner_adapter_command_recoveries
        `).get()?.count).toBe(1);
      } finally {
        inspect.close();
      }
    } finally {
      fixture.cleanup();
    }
  });
});

async function createFixture(label: string) {
  const directory = mkdtempSync(join(tmpdir(), `stensibly-runner-recovery-${label}-`));
  const databasePath = join(directory, "ledger.sqlite");
  const store = new StensiblyStore(databasePath);
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project: "orchestration",
    kind: "task",
    title: `Recover ${label}`,
    priority: 80,
    actor: supervisor,
  });
  dispatchNextWork(store, {
    actor: supervisor,
    runnerType: "vercel-ai-sdk",
    runnerProfile: "default",
    itemId: item.id,
    leaseSeconds: 900,
    idempotencyKey: `dispatch-${label}`,
  });
  const run = await ledger.claimRunnerWork({
    actor: runnerA,
    runnerType: "vercel-ai-sdk",
    runnerProfile: "default",
    project: "orchestration",
    leaseSeconds: 900,
    idempotencyKey: `claim-${label}`,
  });
  if (!run) throw new Error("Runner recovery fixture was not claimed");
  const commandId = `command-${label}`;
  const commandFingerprint = `sha256:${"b".repeat(64)}`;
  await ledger.reserveRunnerAdapterCommand({
    project: "orchestration",
    itemId: item.id,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    actor: runnerA,
    adapterId: "vercel-ai-sdk",
    profileId: "default",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    commandId,
    commandFingerprint,
    idempotencyKey: `reserve-${label}`,
  });
  let storeClosed = false;
  return {
    directory,
    databasePath,
    store,
    ledger,
    runId: run.id,
    runGeneration: run.generation,
    leaseGeneration: run.leaseGeneration,
    commandId,
    commandFingerprint,
    claimedAt: run.leaseExpiresAt ? new Date(Date.parse(run.leaseExpiresAt) - 1).toISOString() : recoveryAt.toISOString(),
    closeStoreOnly() {
      if (!storeClosed) {
        store.close();
        storeClosed = true;
      }
    },
    cleanup() {
      if (!storeClosed) store.close();
      storeClosed = true;
      rmSync(directory, { recursive: true, force: true });
    },
    close() {
      this.cleanup();
    },
  };
}

function recoveryInput(
  commandId: string,
  commandFingerprint: string,
  actor: typeof runnerA | typeof runnerB,
  idempotencyKey: string,
): ClaimRunnerAdapterCommandRecoveryInput {
  return {
    commandId,
    commandFingerprint,
    actor,
    leaseSeconds: 60,
    idempotencyKey,
  };
}

function checkpointReference(runGeneration: number) {
  return {
    version: 1 as const,
    kind: "checkpoint" as const,
    adapterId: "vercel-ai-sdk",
    externalId: "checkpoint-recovery-opaque-1",
    digest: `sha256:${"c".repeat(64)}`,
    uri: null,
    generation: runGeneration,
    createdAt: "2026-08-13T03:59:00.000Z",
    accessClass: "private" as const,
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}

async function spawnRecovery(
  databasePath: string,
  input: ClaimRunnerAdapterCommandRecoveryInput & { now: string },
): Promise<RunnerAdapterCommandRecoveryClaim> {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures", "claim-runner-adapter-command-recovery.ts"),
    databasePath,
  ], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const [output, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || output || "Recovery subprocess failed");
  const parsed = JSON.parse(output) as {
    ok: boolean;
    result?: RunnerAdapterCommandRecoveryClaim;
  };
  if (!parsed.ok || !parsed.result) throw new Error("Recovery subprocess returned no result");
  return parsed.result;
}
