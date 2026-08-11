import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
  type RunnerAdapterCommandReservation,
} from "../src/runner-adapter-command-contracts.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};
const runner = { id: "agent:runner-a", name: "Runner A", kind: "agent" as const };

describe("runner adapter command reservation", () => {
  test("authorizes exactly one dispatch across concurrent SQLite processes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stensibly-runner-command-"));
    const databasePath = join(directory, "ledger.sqlite");
    try {
      const store = new StensiblyStore(databasePath);
      const ledger = new SqliteWorkLedger(store);
      const item = store.createItem({
        project: "orchestration",
        kind: "task",
        title: "Reserve one adapter dispatch",
        priority: 80,
        actor: supervisor,
      });
      dispatchNextWork(store, {
        actor: supervisor,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        itemId: item.id,
        leaseSeconds: 900,
        idempotencyKey: "dispatch-command-reservation",
      });
      const run = await ledger.claimRunnerWork({
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        project: "orchestration",
        leaseSeconds: 900,
        idempotencyKey: "claim-command-reservation",
      });
      if (!run) throw new Error("Runner fixture was not claimed");
      store.close();

      const base: ReserveRunnerAdapterCommandInput = {
        project: "orchestration",
        itemId: item.id,
        runId: run.id,
        runGeneration: run.generation,
        leaseGeneration: run.leaseGeneration,
        actor: runner,
        adapterId: "vercel-ai-sdk",
        profileId: "default",
        requestFingerprint: `sha256:${"a".repeat(64)}`,
        commandId: "command-alpha",
        commandFingerprint: `sha256:${"b".repeat(64)}`,
        idempotencyKey: "reserve-adapter-command",
      };
      const alpha = spawnReservation(databasePath, base);
      const beta = spawnReservation(databasePath, {
        ...base,
        commandId: "command-rebuilt-after-context-change",
        commandFingerprint: `sha256:${"c".repeat(64)}`,
      });
      const results = await Promise.all([alpha, beta]);

      expect(results.map((entry) => entry.outcome).sort()).toEqual(["replayed", "reserved"]);
      expect(results.filter((entry) => entry.dispatchAuthorized)).toHaveLength(1);
      expect(results[0]!.command.commandId).toBe(results[1]!.command.commandId);
      expect(results[0]!.command.commandFingerprint)
        .toBe(results[1]!.command.commandFingerprint);
      expect(["command-alpha", "command-rebuilt-after-context-change"])
        .toContain(results[0]!.command.commandId);

      const replayStore = new StensiblyStore(databasePath);
      try {
        const replayLedger = new SqliteWorkLedger(replayStore);
        await expect(replayLedger.reserveRunnerAdapterCommand({
          ...base,
          requestFingerprint: `sha256:${"d".repeat(64)}`,
          commandId: "changed-stable-request",
          commandFingerprint: `sha256:${"e".repeat(64)}`,
        })).rejects.toBeInstanceOf(RunnerAdapterCommandConflictError);
        await expect(replayLedger.reserveRunnerAdapterCommand({
          ...base,
          profileId: "altered-profile",
          commandId: "altered-stable-binding",
          commandFingerprint: `sha256:${"f".repeat(64)}`,
        })).rejects.toBeInstanceOf(RunnerAdapterCommandConflictError);
        const winner = results[0]!.command;
        const outcome = {
          version: 1 as const,
          kind: "bounded_episode_completed" as const,
          observationCount: 6,
          observationsSha256: `sha256:${"1".repeat(64)}`,
          terminalObservationId: "observation-terminal",
          terminalObservationType: "interrupted",
          latestCheckpointExternalId: "checkpoint-opaque-1",
          latestCheckpointSha256: `sha256:${"2".repeat(64)}`,
          containsPrivateContent: false as const,
          containsCredentials: false as const,
        };
        const settled = await replayLedger.settleRunnerAdapterCommand({
          commandId: winner.commandId,
          commandFingerprint: winner.commandFingerprint,
          outcome,
        });
        expect(settled).toMatchObject({
          outcome: "settled",
          settlement: { outcome, outcomeSha256: expect.stringMatching(/^sha256:/) },
        });
        expect(await replayLedger.settleRunnerAdapterCommand({
          commandId: winner.commandId,
          commandFingerprint: winner.commandFingerprint,
          outcome,
        })).toEqual({ ...settled, outcome: "replayed" });
        const settledReplay = await replayLedger.reserveRunnerAdapterCommand({
          ...base,
          commandId: "another-rebuilt-command",
          commandFingerprint: `sha256:${"9".repeat(64)}`,
        });
        expect(settledReplay).toMatchObject({
          outcome: "replayed",
          dispatchAuthorized: false,
          settlement: settled.settlement,
        });
        await expect(replayLedger.settleRunnerAdapterCommand({
          commandId: winner.commandId,
          commandFingerprint: winner.commandFingerprint,
          outcome: { ...outcome, observationCount: 5 },
        })).rejects.toBeInstanceOf(RunnerAdapterCommandConflictError);
        expect(replayStore.db.query<{ count: number }, []>(`
          SELECT COUNT(*) AS count FROM runner_adapter_commands
        `).get()?.count).toBe(1);
      } finally {
        replayStore.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function spawnReservation(
  databasePath: string,
  input: ReserveRunnerAdapterCommandInput,
): Promise<RunnerAdapterCommandReservation> {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures", "reserve-runner-adapter-command.ts"),
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
  if (exitCode !== 0) throw new Error(`Reservation subprocess failed: ${stderr || output}`);
  const parsed = JSON.parse(output) as {
    ok: boolean;
    result?: RunnerAdapterCommandReservation;
    error?: string;
  };
  if (!parsed.ok || !parsed.result) throw new Error(parsed.error ?? "Reservation failed");
  return parsed.result;
}
