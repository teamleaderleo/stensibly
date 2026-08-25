import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRunnerProfileVersions } from "../src/run-profile-version-sqlite.ts";
import {
  createWorkRun,
  getWorkRun,
  heartbeatWorkRun,
  listWorkRuns,
  transitionWorkRun,
} from "../src/runs.ts";
import { ensureRunSchema as ensureCoreRunSchema } from "../src/runs-core.ts";
import { ConflictError, StensiblyStore } from "../src/store.ts";

const runner = { id: "agent:profile-runner", name: "Profile Runner", kind: "agent" as const };
const baseTime = new Date("2026-08-25T10:00:00.000Z");
const exactVersion = "codex-default/2026-08-25";
const tempDirectories: string[] = [];

afterEach(async () => {
  while (tempDirectories.length) {
    await rm(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

function createItem(store: StensiblyStore, title = "Persist runner profile version") {
  return store.createItem({
    project: "runner-profile-version",
    kind: "task",
    title,
    summary: "Keep exact execution-profile provenance on the durable run.",
    nextAction: "Create a version-aware run.",
    priority: 80,
    actor: runner,
  });
}

function createExactRun(store: StensiblyStore, itemId: string) {
  return createWorkRun(store, {
    itemId,
    actor: runner,
    runnerType: "generic-mcp",
    runnerProfile: "codex-default",
    runnerProfileVersion: exactVersion,
    leaseSeconds: 300,
    maxAttempts: 2,
    retryBackoffSeconds: 60,
    idempotencyKey: "profile-version-create-1",
  }, baseTime);
}

describe("SQLite runner profile version provenance", () => {
  test("persists exact provenance, projects it, and conflicts on changed replay", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store);
      const created = createExactRun(store, item.id);
      const replayed = createExactRun(store, item.id);

      expect(created.runnerProfileVersion).toBe(exactVersion);
      expect(replayed).toEqual(created);
      expect(getWorkRun(store, created.id, baseTime).runnerProfileVersion).toBe(exactVersion);
      expect(listWorkRuns(store, { itemId: item.id }, baseTime)[0]?.runnerProfileVersion)
        .toBe(exactVersion);

      const raw = store.db
        .query<{ runner_profile_version: string | null }, [string]>(`
          SELECT runner_profile_version
          FROM work_runs
          WHERE id = ?1
        `)
        .get(created.id);
      expect(raw?.runner_profile_version).toBe(exactVersion);

      const provenanceEvents = store.listEvents(item.id)
        .filter((event) => event.type === "run.profile_provenance");
      expect(provenanceEvents).toHaveLength(1);
      expect(provenanceEvents[0]?.payload).toEqual({
        runId: created.id,
        generation: 1,
        runnerProfile: "codex-default",
        runnerProfileVersion: exactVersion,
      });

      expect(() => createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: "codex-default/2026-08-26",
        leaseSeconds: 300,
        maxAttempts: 2,
        retryBackoffSeconds: 60,
        idempotencyKey: "profile-version-create-1",
      }, baseTime)).toThrow(ConflictError);
      expect(() => createWorkRun(store, {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: null,
        leaseSeconds: 300,
        maxAttempts: 2,
        retryBackoffSeconds: 60,
        idempotencyKey: "profile-version-create-1",
      }, baseTime)).toThrow("different runner profile provenance");
    } finally {
      store.close();
    }
  });

  test("hydrates a multi-run projection with one profile-version query", () => {
    let batchQueries = 0;
    const fakeStore = {
      db: {
        query(sql: string) {
          if (sql.includes("PRAGMA table_info(work_runs)")) {
            return { all: () => [{ name: "runner_profile_version" }] };
          }
          if (sql.includes("FROM json_each(?1)")) {
            batchQueries += 1;
            return {
              all: (encodedIds: string) => {
                expect(JSON.parse(encodedIds)).toEqual(["run_a", "run_b", "run_c"]);
                return [
                  {
                    id: "run_a",
                    runner_profile: "codex-default",
                    runner_profile_version: "v1",
                  },
                  {
                    id: "run_b",
                    runner_profile: "codex-default",
                    runner_profile_version: null,
                  },
                  {
                    id: "run_c",
                    runner_profile: "codex-default",
                    runner_profile_version: "v3",
                  },
                ];
              },
            };
          }
          throw new Error(`Unexpected SQL in batch hydration test: ${sql}`);
        },
        exec() {
          throw new Error("Batch hydration should not migrate an already-current schema");
        },
      },
    } as unknown as StensiblyStore;

    const hydrated = withRunnerProfileVersions(fakeStore, [
      { id: "run_a", runnerProfile: "codex-default" },
      { id: "run_b", runnerProfile: "codex-default" },
      { id: "run_c", runnerProfile: "codex-default" },
    ]);

    expect(batchQueries).toBe(1);
    expect(hydrated.map((run) => run.runnerProfileVersion)).toEqual(["v1", null, "v3"]);
  });

  test("preserves the creation version through heartbeat, failure, and retry", () => {
    const store = new StensiblyStore(":memory:");
    try {
      const item = createItem(store, "Keep profile version immutable");
      const queued = createExactRun(store, item.id);
      const starting = transitionWorkRun(store, {
        id: queued.id,
        actor: runner,
        command: "start",
        expectedGeneration: queued.generation,
        expectedLeaseGeneration: queued.leaseGeneration,
        leaseSeconds: 300,
      }, new Date("2026-08-25T10:00:30.000Z"));
      const running = transitionWorkRun(store, {
        id: starting.id,
        actor: runner,
        command: "run",
        expectedGeneration: starting.generation,
        expectedLeaseGeneration: starting.leaseGeneration,
        leaseSeconds: 300,
      }, new Date("2026-08-25T10:01:00.000Z"));
      const heartbeat = heartbeatWorkRun(store, {
        id: running.id,
        actor: runner,
        expectedGeneration: running.generation,
        expectedLeaseGeneration: running.leaseGeneration,
        leaseSeconds: 300,
        checkpoint: "Version-aware run is healthy.",
      }, new Date("2026-08-25T10:01:30.000Z"));
      const failed = transitionWorkRun(store, {
        id: heartbeat.id,
        actor: runner,
        command: "fail",
        expectedGeneration: heartbeat.generation,
        expectedLeaseGeneration: heartbeat.leaseGeneration,
        outcome: "Retryable fixture failure.",
      }, new Date("2026-08-25T10:02:00.000Z"));
      const retried = transitionWorkRun(store, {
        id: failed.id,
        actor: runner,
        command: "retry",
        expectedGeneration: failed.generation,
        expectedLeaseGeneration: failed.leaseGeneration,
        leaseSeconds: 300,
      }, new Date("2026-08-25T10:03:00.000Z"));

      for (const run of [queued, starting, running, heartbeat, failed, retried]) {
        expect(run.runnerProfileVersion).toBe(exactVersion);
      }
      expect(getWorkRun(store, queued.id, new Date("2026-08-25T10:03:01.000Z")))
        .toMatchObject({
          status: "queued",
          runnerProfile: "codex-default",
          runnerProfileVersion: exactVersion,
        });
    } finally {
      store.close();
    }
  });

  test("migrates historical work_runs without inventing a profile version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stensibly-run-profile-version-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "legacy.sqlite");

    const firstStore = new StensiblyStore(databasePath);
    const item = createItem(firstStore, "Read a legacy run after migration");
    ensureCoreRunSchema(firstStore);
    firstStore.db.query(`
      INSERT INTO work_runs (
        id, item_id, actor_id, runner_type, runner_profile, external_run_id,
        status, generation, lease_generation, lease_owner_id, lease_expires_at,
        last_heartbeat_at, checkpoint, outcome, continuation_ref, usage_json,
        retry_attempt, max_attempts, retry_backoff_seconds, next_retry_at,
        creation_request_json, idempotency_key, created_at, updated_at,
        started_at, ended_at
      ) VALUES (
        ?1, ?2, ?3, 'generic-mcp', 'codex-default', NULL,
        'succeeded', 2, 1, NULL, NULL,
        NULL, 'legacy checkpoint', 'legacy outcome', NULL, '{}',
        0, 3, 60, NULL,
        ?4, 'legacy-profile-version-create', ?5, ?5,
        ?5, ?5
      )
    `).run(
      "run_legacy_profile_version",
      item.id,
      runner.id,
      JSON.stringify({
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        externalRunId: null,
        continuationRef: null,
        leaseSeconds: 300,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
      }),
      baseTime.toISOString(),
    );
    firstStore.close();

    const migratedStore = new StensiblyStore(databasePath);
    try {
      const historical = getWorkRun(
        migratedStore,
        "run_legacy_profile_version",
        new Date("2026-08-25T10:10:00.000Z"),
      );
      expect(historical).toMatchObject({
        runnerProfile: "codex-default",
        runnerProfileVersion: null,
        status: "succeeded",
      });
      const columns = migratedStore.db
        .query<{ name: string }, []>("PRAGMA table_info(work_runs)")
        .all();
      expect(columns.some((column) => column.name === "runner_profile_version")).toBe(true);
      const raw = migratedStore.db
        .query<{ runner_profile_version: string | null }, [string]>(`
          SELECT runner_profile_version
          FROM work_runs
          WHERE id = ?1
        `)
        .get(historical.id);
      expect(raw?.runner_profile_version).toBeNull();

      expect(() => createWorkRun(migratedStore, {
        itemId: item.id,
        actor: runner,
        runnerType: "generic-mcp",
        runnerProfile: "codex-default",
        runnerProfileVersion: exactVersion,
        leaseSeconds: 300,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
        idempotencyKey: "legacy-profile-version-create",
      }, baseTime)).toThrow("different runner profile provenance");

      const afterRejectedRetrofit = migratedStore.db
        .query<{ runner_profile_version: string | null }, [string]>(`
          SELECT runner_profile_version
          FROM work_runs
          WHERE id = ?1
        `)
        .get(historical.id);
      expect(afterRejectedRetrofit?.runner_profile_version).toBeNull();
    } finally {
      migratedStore.close();
    }
  });
});
