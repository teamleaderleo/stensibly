import { randomUUID } from "node:crypto";
import type { ClaimRunnerWorkInput } from "./runner-contracts.js";
import { actorSchema, type ActorInput } from "./schemas.js";
import {
  ensureRunSchema,
  type RunUsage,
  type WorkRun,
  type WorkRunStatus,
} from "./runs.js";
import { ConflictError, StensiblyStore } from "./store.js";

interface CandidateRow {
  id: string;
  item_id: string;
  actor_id: string;
  runner_type: string;
  runner_profile: string;
  external_run_id: string | null;
  status: WorkRunStatus;
  generation: number;
  lease_generation: number;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  checkpoint: string | null;
  outcome: string | null;
  continuation_ref: string | null;
  usage_json: string;
  retry_attempt: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  project_id: string;
}

interface ClaimCommandRow {
  request_json: string;
  result_json: string;
}

const initializedStores = new WeakSet<StensiblyStore>();

export function claimRunnerWork(
  store: StensiblyStore,
  rawInput: ClaimRunnerWorkInput,
  now = new Date(),
): WorkRun | null {
  ensureRunnerQueueSchema(store);
  const input = normalizeInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(claimRequest(input));

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = store.db
        .query<ClaimCommandRow, [string]>(
          "SELECT request_json, result_json FROM runner_claim_commands WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey);
      if (existing) {
        if (existing.request_json !== requestJson) {
          throw new ConflictError("Idempotency key was already used for a different runner claim");
        }
        return JSON.parse(existing.result_json) as WorkRun | null;
      }
    }

    const candidate = selectCandidate(store, input, timestamp);
    if (!candidate) {
      storeReplay(store, input.idempotencyKey, requestJson, null, timestamp);
      return null;
    }

    const actor = upsertActor(store, input.actor, timestamp);
    const leaseExpiresAt = addSeconds(now, input.leaseSeconds);
    const nextGeneration = candidate.generation + 1;
    const nextLeaseGeneration = candidate.lease_generation + 1;
    const retrying = candidate.status === "failed";

    const itemClaim = store.db
      .query(`
        UPDATE items
        SET status = 'active',
            claimed_by = ?1,
            claim_expires_at = ?2,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status IN ('ready', 'active')
          AND (
            claimed_by IS NULL
            OR claimed_by = ?1
            OR claimed_by = ?5
            OR claim_expires_at <= ?3
          )
      `)
      .run(
        actor.id,
        leaseExpiresAt,
        timestamp,
        candidate.item_id,
        candidate.actor_id,
      );
    if (itemClaim.changes !== 1) {
      throw new ConflictError("Run item is actively claimed by another actor");
    }

    const update = store.db
      .query(`
        UPDATE work_runs
        SET actor_id = ?1,
            external_run_id = COALESCE(?2, external_run_id),
            status = 'starting',
            generation = ?3,
            lease_generation = ?4,
            lease_owner_id = ?1,
            lease_expires_at = ?5,
            last_heartbeat_at = NULL,
            outcome = NULL,
            next_retry_at = NULL,
            updated_at = ?6,
            started_at = ?6,
            ended_at = NULL
        WHERE id = ?7
          AND generation = ?8
          AND lease_generation = ?9
          AND (
            status = 'queued'
            OR (
              status = 'failed'
              AND next_retry_at IS NOT NULL
              AND next_retry_at <= ?6
              AND retry_attempt < max_attempts
            )
          )
      `)
      .run(
        actor.id,
        input.externalRunId ?? null,
        nextGeneration,
        nextLeaseGeneration,
        leaseExpiresAt,
        timestamp,
        candidate.id,
        candidate.generation,
        candidate.lease_generation,
      );
    if (update.changes !== 1) {
      throw new ConflictError("Run changed before the runner lease could be claimed");
    }

    appendEvent(store, {
      itemId: candidate.item_id,
      actorId: actor.id,
      type: retrying ? "run.retry_starting" : "run.starting",
      payload: {
        runId: candidate.id,
        source: "generic_runner_claim",
        runnerType: candidate.runner_type,
        runnerProfile: candidate.runner_profile,
        generation: nextGeneration,
        leaseGeneration: nextLeaseGeneration,
        leaseExpiresAt,
        previousActorId: candidate.actor_id,
        ...(input.externalRunId ? { externalRunId: input.externalRunId } : {}),
        ...(retrying ? { retryAttempt: candidate.retry_attempt } : {}),
      },
      now: timestamp,
    });

    const claimed = mapRun(getRunRow(store, candidate.id));
    storeReplay(store, input.idempotencyKey, requestJson, claimed, timestamp);
    return claimed;
  });

  return transaction();
}

export function ensureRunnerQueueSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  ensureRunSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS runner_claim_commands (
      idempotency_key TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  initializedStores.add(store);
}

function selectCandidate(
  store: StensiblyStore,
  input: ReturnType<typeof normalizeInput>,
  now: string,
): CandidateRow | null {
  return store.db
    .query<CandidateRow, [string, string, string | null, string | null, string]>(`
      SELECT r.*, i.project_id
      FROM work_runs r
      JOIN items i ON i.id = r.item_id
      WHERE r.runner_type = ?1
        AND r.runner_profile = ?2
        AND (?3 IS NULL OR i.project_id = ?3)
        AND (?4 IS NULL OR r.id = ?4)
        AND (
          r.status = 'queued'
          OR (
            r.status = 'failed'
            AND r.next_retry_at IS NOT NULL
            AND r.next_retry_at <= ?5
            AND r.retry_attempt < r.max_attempts
          )
        )
      ORDER BY
        CASE WHEN r.status = 'failed' THEN 0 ELSE 1 END,
        COALESCE(r.next_retry_at, r.created_at) ASC,
        r.created_at ASC,
        r.id ASC
      LIMIT 1
    `)
    .get(
      input.runnerType,
      input.runnerProfile,
      input.project ?? null,
      input.runId ?? null,
      now,
    ) ?? null;
}

function getRunRow(store: StensiblyStore, id: string): CandidateRow {
  const row = store.db
    .query<CandidateRow, [string]>(`
      SELECT r.*, i.project_id
      FROM work_runs r
      JOIN items i ON i.id = r.item_id
      WHERE r.id = ?1
    `)
    .get(id);
  if (!row) throw new ConflictError(`Claimed run ${id} disappeared`);
  return row;
}

function storeReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  requestJson: string,
  result: WorkRun | null,
  now: string,
): void {
  if (!idempotencyKey) return;
  store.db
    .query(`
      INSERT INTO runner_claim_commands (idempotency_key, request_json, result_json, created_at)
      VALUES (?1, ?2, ?3, ?4)
    `)
    .run(idempotencyKey, requestJson, JSON.stringify(result), now);
}

function appendEvent(
  store: StensiblyStore,
  input: {
    itemId: string;
    actorId: string;
    type: string;
    payload: Record<string, unknown>;
    now: string;
  },
): void {
  store.db
    .query(`
      INSERT INTO events (id, item_id, actor_id, type, payload_json, idempotency_key, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
    `)
    .run(
      `evt_${randomUUID()}`,
      input.itemId,
      input.actorId,
      input.type,
      JSON.stringify(input.payload),
      input.now,
    );
}

function upsertActor(store: StensiblyStore, rawActor: ActorInput, now: string): ActorInput {
  const actor = actorSchema.parse(rawActor);
  if (actor.kind === "human") throw new TypeError("Runner actor must be an agent or service");
  store.db
    .query(`
      INSERT INTO actors (id, name, kind, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        updated_at = excluded.updated_at
    `)
    .run(actor.id, actor.name, actor.kind, now);
  return actor;
}

function normalizeInput(raw: ClaimRunnerWorkInput) {
  const actor = actorSchema.parse(raw.actor);
  if (actor.kind === "human") throw new TypeError("Runner actor must be an agent or service");
  const project = optionalProject(raw.project);
  const runId = optionalText(raw.runId, "Run ID", 240);
  const externalRunId = optionalText(raw.externalRunId, "External run ID", 240);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    actor,
    runnerType: requiredText(raw.runnerType, "Runner type", 80),
    runnerProfile: requiredText(raw.runnerProfile, "Runner profile", 160),
    ...(project ? { project } : {}),
    ...(runId ? { runId } : {}),
    ...(externalRunId ? { externalRunId } : {}),
    leaseSeconds: positiveInteger(raw.leaseSeconds ?? 900, "Lease seconds", 86_400, 30),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function claimRequest(input: ReturnType<typeof normalizeInput>) {
  return {
    actor: input.actor,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    project: input.project ?? null,
    runId: input.runId ?? null,
    externalRunId: input.externalRunId ?? null,
    leaseSeconds: input.leaseSeconds,
  };
}

function mapRun(row: CandidateRow): WorkRun {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    runnerType: row.runner_type,
    runnerProfile: row.runner_profile,
    externalRunId: row.external_run_id,
    status: row.status,
    generation: row.generation,
    leaseGeneration: row.lease_generation,
    leaseOwnerId: row.lease_owner_id,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    checkpoint: row.checkpoint,
    outcome: row.outcome,
    continuationRef: row.continuation_ref,
    usage: parseUsage(row.usage_json),
    retryAttempt: row.retry_attempt,
    maxAttempts: row.max_attempts,
    retryBackoffSeconds: row.retry_backoff_seconds,
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function parseUsage(json: string): RunUsage {
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const output: RunUsage = {};
  for (const key of ["inputTokens", "outputTokens", "toolCalls", "childAgents"] as const) {
    const value = (parsed as Record<string, unknown>)[key];
    if (Number.isInteger(value) && Number(value) >= 0) output[key] = Number(value);
  }
  return output;
}

function optionalProject(value: unknown): string | undefined {
  const project = optionalText(value, "Project", 80);
  if (!project) return undefined;
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(project)) throw new TypeError("Project must be a lowercase slug");
  return project;
}

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function isoNow(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError("Current time must be a valid date");
  return value.toISOString();
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maximum) throw new TypeError(`${label} may contain at most ${maximum} characters`);
  return output;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) return undefined;
  if (output.length > maximum) throw new TypeError(`${label} may contain at most ${maximum} characters`);
  return output;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 1,
): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) {
    throw new TypeError(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return output;
}
