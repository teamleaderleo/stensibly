import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { compatibilityExecutionEnvelope } from "../src/execution-envelope-default.ts";
import { RunnerAdapterHostV1 } from "../src/runner-adapter-host.ts";
import {
  RunnerAdapterCommandConflictError,
  type ReserveRunnerAdapterCommandInput,
} from "../src/runner-adapter-command-contracts.ts";
import { dispatchNextWork } from "../src/dispatcher.ts";
import {
  VERCEL_AI_SDK_ADAPTER_ID,
  VERCEL_AI_SDK_PROFILE_ID,
  VERCEL_AI_SDK_PROFILE_VERSION,
  VercelAISDKRunnerAdapter,
} from "../src/runner-adapters/vercel-ai-sdk.ts";
import { SqliteWorkLedger } from "../src/sqlite-ledger.ts";
import { StensiblyStore } from "../src/store.ts";

const supervisor = {
  id: "service:profile-fence",
  name: "Profile Fence Supervisor",
  kind: "service" as const,
};
const runner = {
  id: "agent:profile-fence",
  name: "Profile Fence Host",
  kind: "agent" as const,
};
const driftedVersion = "ai@0.0.0-profile-fence-drift";

describe("runner adapter exact profile version fence", () => {
  test("version-aware hosts claim and start the exact matching run", async () => {
    const fixture = createFenceFixture(VERCEL_AI_SDK_PROFILE_VERSION);
    try {
      const result = await fixture.host.startNext({
        operationId: "fence-exact-start",
        project: "profile_fence",
      });
      expect(result?.disposition).toBe("executed");
      expect(result?.command?.profileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);
      expect(result?.run.runnerProfileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);
      expect(fixture.model.doGenerateCalls).toHaveLength(1);
      expect(fixture.reservationVersions()).toEqual([VERCEL_AI_SDK_PROFILE_VERSION]);
    } finally {
      fixture.store.close();
    }
  });

  test("a changed durable profile version refuses before runtime or model work", async () => {
    const fixture = createFenceFixture(driftedVersion);
    try {
      const result = await fixture.host.startNext({
        operationId: "fence-drift-start",
        project: "profile_fence",
      });
      expect(result).toBeNull();
      expect(fixture.model.doGenerateCalls).toHaveLength(0);

      const runRow = fixture.store.db.query(
        "SELECT status, generation, lease_owner_id FROM work_runs WHERE runner_profile_version = ?1",
      ).get(driftedVersion);
      expect(runRow).toMatchObject({ status: "queued", generation: 1 });
      expect(fixture.store.db.query(
        "SELECT COUNT(*) AS count FROM runner_adapter_commands",
      ).get()).toMatchObject({ count: 0 });
      const detail = await fixture.ledger.getItem(fixture.itemId);
      expect(detail.events.filter((event) => event.type.startsWith("run.adapter"))).toHaveLength(0);

      const successor = createFenceFixture(VERCEL_AI_SDK_PROFILE_VERSION);
      try {
        const executed = await successor.host.startNext({
          operationId: "fence-successor-start",
          project: "profile_fence",
        });
        expect(executed?.disposition).toBe("executed");
        expect(successor.model.doGenerateCalls).toHaveLength(1);
      } finally {
        successor.store.close();
      }
    } finally {
      fixture.store.close();
    }
  });

  test("historical unknown runs stay explicitly unknown instead of being claimed or upgraded", async () => {
    const fixture = createFenceFixture(null);
    try {
      const result = await fixture.host.startNext({
        operationId: "fence-unknown-start",
        project: "profile_fence",
      });
      expect(result).toBeNull();
      expect(fixture.model.doGenerateCalls).toHaveLength(0);
      const runRow = fixture.store.db.query(
        "SELECT status, runner_profile_version FROM work_runs WHERE id = ?1",
      ).get(fixture.runId);
      expect(runRow).toMatchObject({ status: "queued", runner_profile_version: null });

      const claimedByUnknownProvenance = await fixture.ledger.claimRunnerWork({
        actor: runner,
        runnerType: VERCEL_AI_SDK_ADAPTER_ID,
        runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
        runnerProfileVersion: null,
        runId: fixture.runId,
        leaseSeconds: 900,
        idempotencyKey: "claim-legacy-unknown",
      });
      expect(claimedByUnknownProvenance?.runnerProfileVersion).toBeNull();
    } finally {
      fixture.store.close();
    }
  });

  test("reservation storage, reads, and replay retain the exact consumed version", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const claimed = await seedClaimedRun(store, ledger, VERCEL_AI_SDK_PROFILE_VERSION);
    try {
      const base: ReserveRunnerAdapterCommandInput = {
        project: "profile_fence",
        itemId: claimed.itemId,
        runId: claimed.runId,
        runGeneration: claimed.generation,
        leaseGeneration: claimed.leaseGeneration,
        actor: runner,
        adapterId: VERCEL_AI_SDK_ADAPTER_ID,
        profileId: VERCEL_AI_SDK_PROFILE_ID,
        profileVersion: VERCEL_AI_SDK_PROFILE_VERSION,
        requestFingerprint: fingerprint("aa"),
        commandId: "fence-command-1",
        commandFingerprint: fingerprint("bb"),
        idempotencyKey: "reserve-fence-retention",
      };
      const reserved = await ledger.reserveRunnerAdapterCommand(base);
      expect(reserved.dispatchAuthorized).toBe(true);
      expect(reserved.command.profileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);

      const readBack = await ledger.getRunnerAdapterCommand({
        idempotencyKey: base.idempotencyKey,
      });
      expect(readBack?.command.profileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);

      const replayed = await ledger.reserveRunnerAdapterCommand({
        ...base,
        commandId: "fence-command-replay",
        commandFingerprint: fingerprint("cc"),
      });
      expect(replayed).toMatchObject({
        outcome: "replayed",
        dispatchAuthorized: false,
      });
      expect(replayed.command.profileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);

      await expect(ledger.reserveRunnerAdapterCommand({
        ...base,
        profileVersion: driftedVersion,
        commandId: "fence-command-version-changed",
        commandFingerprint: fingerprint("dd"),
      })).rejects.toBeInstanceOf(RunnerAdapterCommandConflictError);

      await ledger.settleRunnerAdapterCommand({
        commandId: base.commandId,
        commandFingerprint: base.commandFingerprint,
        outcome: boundedOutcome(),
      });
      const settledReplay = await ledger.reserveRunnerAdapterCommand({
        ...base,
        commandId: "fence-command-settled-replay",
        commandFingerprint: fingerprint("ee"),
      });
      expect(settledReplay).toMatchObject({
        outcome: "replayed",
        dispatchAuthorized: false,
      });
      expect(settledReplay.command.profileVersion).toBe(VERCEL_AI_SDK_PROFILE_VERSION);
      expect(settledReplay.settlement?.commandId).toBe(base.commandId);
    } finally {
      store.close();
    }
  });

  test("fresh reservations fail closed when durable profile provenance differs", async () => {
    const cases = [
      {
        name: "exact version to another exact version",
        durableVersion: VERCEL_AI_SDK_PROFILE_VERSION,
        reservation: { profileVersion: driftedVersion },
      },
      {
        name: "exact version to unknown",
        durableVersion: VERCEL_AI_SDK_PROFILE_VERSION,
        reservation: { profileVersion: null },
      },
      {
        name: "legacy unknown to exact version",
        durableVersion: null,
        reservation: { profileVersion: VERCEL_AI_SDK_PROFILE_VERSION },
      },
      {
        name: "adapter and profile mismatch",
        durableVersion: VERCEL_AI_SDK_PROFILE_VERSION,
        reservation: {
          adapterId: "different-adapter",
          profileId: "different-profile",
          profileVersion: VERCEL_AI_SDK_PROFILE_VERSION,
        },
      },
    ] as const;

    for (const [index, scenario] of cases.entries()) {
      const store = new StensiblyStore(":memory:");
      const ledger = new SqliteWorkLedger(store);
      try {
        const claimed = await seedClaimedRun(store, ledger, scenario.durableVersion);
        const input: ReserveRunnerAdapterCommandInput = {
          project: "profile_fence",
          itemId: claimed.itemId,
          runId: claimed.runId,
          runGeneration: claimed.generation,
          leaseGeneration: claimed.leaseGeneration,
          actor: runner,
          adapterId: VERCEL_AI_SDK_ADAPTER_ID,
          profileId: VERCEL_AI_SDK_PROFILE_ID,
          requestFingerprint: fingerprint(`${index}a`),
          commandId: `fresh-profile-reject-${index}`,
          commandFingerprint: fingerprint(`${index}b`),
          idempotencyKey: `fresh-profile-reject-${index}`,
          ...scenario.reservation,
        };

        await expect(ledger.reserveRunnerAdapterCommand(input)).rejects.toThrow(
          /profile provenance does not match the run/,
        );
        expect(store.db.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM runner_adapter_commands",
        ).get()?.count, scenario.name).toBe(0);
      } finally {
        store.close();
      }
    }
  });

  test("historical reservations without versions read back as explicitly unknown", async () => {
    const store = new StensiblyStore(":memory:");
    const ledger = new SqliteWorkLedger(store);
    const claimed = await seedClaimedRun(store, ledger, null);
    try {
      const legacyRequest = {
        project: "profile_fence",
        itemId: claimed.itemId,
        runId: claimed.runId,
        runGeneration: claimed.generation,
        leaseGeneration: claimed.leaseGeneration,
        actor: runner,
        adapterId: VERCEL_AI_SDK_ADAPTER_ID,
        profileId: VERCEL_AI_SDK_PROFILE_ID,
        requestFingerprint: fingerprint("ff"),
        commandId: "legacy-command-1",
        commandFingerprint: fingerprint("11"),
        idempotencyKey: "reserve-legacy-unknown",
      };
      insertLegacyReservation(store, legacyRequest, "2026-08-25T00:00:00.000Z");

      const readBack = await ledger.getRunnerAdapterCommand({
        idempotencyKey: legacyRequest.idempotencyKey,
      });
      expect(readBack?.command.profileVersion).toBeNull();

      const replayed = await ledger.reserveRunnerAdapterCommand({
        ...legacyRequest,
        profileVersion: null,
      });
      expect(replayed).toMatchObject({ outcome: "replayed", dispatchAuthorized: false });
      expect(replayed.command.profileVersion).toBeNull();

      await expect(ledger.reserveRunnerAdapterCommand({
        ...legacyRequest,
        profileVersion: VERCEL_AI_SDK_PROFILE_VERSION,
        commandId: "legacy-command-upgraded",
        commandFingerprint: fingerprint("22"),
      })).rejects.toBeInstanceOf(RunnerAdapterCommandConflictError);
    } finally {
      store.close();
    }
  });
});

function createFenceFixture(runnerProfileVersion: string | null) {
  const store = new StensiblyStore(":memory:");
  const ledger = new SqliteWorkLedger(store);
  const item = store.createItem({
    project: "profile_fence",
    kind: "task",
    title: "Run one fenced AI SDK host episode",
    summary: "Prove exact runner profile version admission.",
    nextAction: "Claim only under the exact profile version.",
    priority: 90,
    actor: supervisor,
  });
  const queued = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: VERCEL_AI_SDK_ADAPTER_ID,
    runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
    runnerProfileVersion,
    itemId: item.id,
    leaseSeconds: 300,
    maxAttempts: 1,
    retryBackoffSeconds: 0,
    idempotencyKey: `dispatch:${item.id}:${String(runnerProfileVersion)}`,
    executionEnvelope: compatibilityExecutionEnvelope("Run one fenced AI SDK host episode"),
  });
  if (!queued) throw new Error("Expected one dispatched fence fixture run");
  let clock = new Date();
  const now = () => new Date(clock.getTime());
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: "stop" },
      content: [{ type: "text" as const, text: "model-free bounded reply" }],
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const adapter = new VercelAISDKRunnerAdapter({
    agentSettings: {
      id: "profile-fence-host",
      model,
      tools: {
        readOnlyProbe: tool({
          description: "A model-free fence probe tool.",
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => value,
        }),
      },
    },
    checkpointStore: {
      saveCheckpoint: () => undefined,
      loadCheckpoint: () => null,
    },
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
  return {
    store,
    ledger,
    host,
    model,
    itemId: item.id,
    runId: queued.run.id,
    reservationVersions(): Array<string | null> {
      return (store.db.query("SELECT request_json FROM runner_adapter_commands").all() as Array<{
        request_json: string;
      }>).map((row) =>
        (JSON.parse(row.request_json) as { profileVersion?: string | null }).profileVersion ?? null
      );
    },
  };
}

async function seedClaimedRun(
  store: StensiblyStore,
  ledger: SqliteWorkLedger,
  runnerProfileVersion: string | null,
) {
  const item = store.createItem({
    project: "profile_fence",
    kind: "task",
    title: "Reserve one fenced adapter command",
    summary: "Retain the consumed profile version exactly.",
    nextAction: "Reserve under the current authority.",
    priority: 90,
    actor: supervisor,
  });
  const queued = dispatchNextWork(store, {
    actor: supervisor,
    runnerType: VERCEL_AI_SDK_ADAPTER_ID,
    runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
    runnerProfileVersion,
    itemId: item.id,
    leaseSeconds: 3_600,
    maxAttempts: 1,
    retryBackoffSeconds: 0,
    executionEnvelope: compatibilityExecutionEnvelope("Reserve one fenced adapter command"),
  });
  if (!queued) throw new Error("Expected one dispatched fence fixture run");
  const claimed = await ledger.claimRunnerWork({
    actor: runner,
    runnerType: VERCEL_AI_SDK_ADAPTER_ID,
    runnerProfile: VERCEL_AI_SDK_PROFILE_ID,
    runnerProfileVersion,
    runId: queued.run.id,
    leaseSeconds: 3_600,
  });
  if (!claimed) throw new Error("Expected one claimed fence fixture run");
  return {
    itemId: item.id,
    runId: claimed.id,
    generation: claimed.generation,
    leaseGeneration: claimed.leaseGeneration,
  };
}

function insertLegacyReservation(
  store: StenselyStoreLike,
  input: Omit<ReserveRunnerAdapterCommandInput, "profileVersion">,
  reservedAt: string,
): void {
  const { commandId: _commandId, commandFingerprint: _commandFingerprint, ...stable } = input;
  store.db.query(`
    INSERT INTO runner_adapter_commands (
      idempotency_key, command_id, project_id, item_id, run_id,
      run_generation, lease_generation, actor_id, adapter_id, profile_id,
      request_fingerprint, command_fingerprint, request_json,
      stable_request_json, reserved_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
  `).run(
    input.idempotencyKey,
    input.commandId,
    input.project,
    input.itemId,
    input.runId,
    input.runGeneration,
    input.leaseGeneration,
    input.actor.id,
    input.adapterId,
    input.profileId,
    input.requestFingerprint,
    input.commandFingerprint,
    JSON.stringify(input),
    JSON.stringify(stable),
    reservedAt,
  );
}

type StenselyStoreLike = Pick<StensiblyStore, "createItem"> & {
  db: StensiblyStore["db"];
};

function boundedOutcome() {
  return {
    version: 1 as const,
    kind: "bounded_episode_completed" as const,
    observationCount: 1,
    observationsSha256: fingerprint("33"),
    terminalObservationId: "observation-terminal",
    terminalObservationType: "interrupted",
    latestCheckpointExternalId: "checkpoint-opaque-1",
    latestCheckpointSha256: fingerprint("44"),
    containsPrivateContent: false as const,
    containsCredentials: false as const,
  };
}

function fingerprint(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}
