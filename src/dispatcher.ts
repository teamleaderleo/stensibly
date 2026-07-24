import { randomUUID } from "node:crypto";
import { actorSchema, type ActorInput } from "./schemas.js";
import {
  ensurePromiseSchema,
  reconcileWorkPromises,
  type ReconcileWorkPromisesResult,
} from "./promises.js";
import {
  ensureRunSchema,
  listRetryEligibleRuns,
  reconcileStaleRuns,
  type WorkRun,
} from "./runs.js";
import { ConflictError, NotFoundError, StensiblyStore, type Item, type ItemKind, type ItemStatus } from "./store.js";

export interface DispatchCandidate {
  itemId: string;
  project: string;
  kind: ItemKind;
  title: string;
  priority: number;
  createdAt: string;
  readyPromiseWakeups: number;
  explanation: string[];
}

export interface DispatchSurvey {
  candidates: DispatchCandidate[];
  retryEligibleRuns: WorkRun[];
  reconciliation: {
    satisfiedPromiseIds: string[];
    missedPromiseIds: string[];
    abandonedRunIds: string[];
  };
}

export interface SurveyDispatchInput {
  project?: string;
  limit?: number;
}

export interface DispatchNextWorkInput {
  actor: ActorInput;
  runnerType: string;
  runnerProfile: string;
  project?: string;
  externalRunId?: string;
  continuationRef?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  idempotencyKey?: string;
}

export interface DispatchResult {
  item: Item;
  run: WorkRun;
}

interface CandidateRow {
  id: string;
  project_id: string;
  kind: ItemKind;
  title: string;
  priority: number;
  created_at: string;
  wakeup_count: number;
}

interface DispatchCommandRow {
  request_json: string;
  result_json: string;
}

interface RunRow {
  id: string;
  item_id: string;
  actor_id: string;
  runner_type: string;
  runner_profile: string;
  external_run_id: string | null;
  status: WorkRun["status"];
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
}

const initializedStores = new WeakSet<StensiblyStore>();

export function surveyDispatch(
  store: StensiblyStore,
  rawInput: SurveyDispatchInput = {},
  now = new Date(),
): DispatchSurvey {
  ensureDispatchSchema(store);
  const input = normalizeSurveyInput(rawInput);
  const timestamp = isoNow(now);
  const promiseResult = reconcileWorkPromises(store, now);
  const runResult = reconcileStaleRuns(store, now);
  const candidates = queryCandidates(store, {
    project: input.project ?? null,
    limit: input.limit,
    now: timestamp,
    actorId: null,
  }).map(mapCandidate);

  return {
    candidates,
    retryEligibleRuns: listRetryEligibleRuns(store, now),
    reconciliation: reconciliationSummary(promiseResult, runResult.abandoned),
  };
}

export function dispatchNextWork(
  store: StensiblyStore,
  rawInput: DispatchNextWorkInput,
  now = new Date(),
): DispatchResult | null {
  ensureDispatchSchema(store);
  const input = normalizeDispatchInput(rawInput);
  const timestamp = isoNow(now);
  const leaseExpiresAt = addSeconds(now, input.leaseSeconds);
  const requestJson = JSON.stringify(dispatchRequest(input));

  reconcileWorkPromises(store, now);
  reconcileStaleRuns(store, now);

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = store.db
        .query<DispatchCommandRow, [string]>(
          "SELECT request_json, result_json FROM dispatch_commands WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey);
      if (existing) {
        if (existing.request_json !== requestJson) {
          throw new ConflictError("Idempotency key was already used for a different dispatch request");
        }
        return JSON.parse(existing.result_json) as DispatchResult | null;
      }
    }

    upsertActor(store, input.actor, timestamp);
    const candidate = queryCandidates(store, {
      project: input.project ?? null,
      limit: 1,
      now: timestamp,
      actorId: input.actor.id,
    })[0];
    if (!candidate) {
      storeDispatchReplay(store, input.idempotencyKey, requestJson, null, timestamp);
      return null;
    }

    const claim = store.db
      .query(`
        UPDATE items
        SET status = 'active',
            claimed_by = ?1,
            claim_expires_at = ?2,
            version = version + 1,
            updated_at = ?3
        WHERE id = ?4
          AND status = 'ready'
          AND (
            claimed_by IS NULL
            OR claim_expires_at IS NULL
            OR claim_expires_at <= ?3
            OR claimed_by = ?1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM work_runs
            WHERE item_id = ?4
              AND (
                status IN ('queued', 'starting', 'running', 'waiting', 'blocked')
                OR (status = 'failed' AND next_retry_at IS NOT NULL)
              )
          )
      `)
      .run(input.actor.id, leaseExpiresAt, timestamp, candidate.id);
    if (claim.changes !== 1) {
      throw new ConflictError("Dispatch candidate changed before it could be claimed");
    }

    const runId = `run_${randomUUID()}`;
    store.db
      .query(`
        INSERT INTO work_runs (
          id, item_id, actor_id, runner_type, runner_profile, external_run_id,
          status, generation, lease_generation, lease_owner_id, lease_expires_at,
          last_heartbeat_at, checkpoint, outcome, continuation_ref, usage_json,
          retry_attempt, max_attempts, retry_backoff_seconds, next_retry_at,
          creation_request_json, idempotency_key, created_at, updated_at,
          started_at, ended_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          'queued', 1, 1, ?3, ?7,
          NULL, NULL, NULL, ?8, '{}',
          0, ?9, ?10, NULL,
          ?11, NULL, ?12, ?12,
          NULL, NULL
        )
      `)
      .run(
        runId,
        candidate.id,
        input.actor.id,
        input.runnerType,
        input.runnerProfile,
        input.externalRunId ?? null,
        leaseExpiresAt,
        input.continuationRef ?? null,
        input.maxAttempts,
        input.retryBackoffSeconds,
        requestJson,
        timestamp,
      );

    appendDispatchEvent(store, {
      itemId: candidate.id,
      actorId: input.actor.id,
      type: "claim.created",
      payload: {
        leaseSeconds: input.leaseSeconds,
        expiresAt: leaseExpiresAt,
        source: "supervisor_dispatch",
      },
      now: timestamp,
    });
    appendDispatchEvent(store, {
      itemId: candidate.id,
      actorId: input.actor.id,
      type: "run.queued",
      payload: {
        runId,
        generation: 1,
        leaseGeneration: 1,
        leaseExpiresAt,
        runnerType: input.runnerType,
        runnerProfile: input.runnerProfile,
        source: "supervisor_dispatch",
        readyPromiseWakeups: candidate.wakeup_count,
      },
      now: timestamp,
    });

    const result: DispatchResult = {
      item: store.getItem(candidate.id),
      run: mapRun(getRunRow(store, runId)),
    };
    storeDispatchReplay(store, input.idempotencyKey, requestJson, result, timestamp);
    return result;
  });

  return transaction();
}

export function ensureDispatchSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  ensurePromiseSchema(store);
  ensureRunSchema(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_commands (
      idempotency_key TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  initializedStores.add(store);
}

function queryCandidates(
  store: StensiblyStore,
  input: {
    project: string | null;
    limit: number;
    now: string;
    actorId: string | null;
  },
): CandidateRow[] {
  return store.db
    .query<CandidateRow, [string | null, string, string | null, number]>(`
      SELECT
        i.id,
        i.project_id,
        i.kind,
        i.title,
        i.priority,
        i.created_at,
        COUNT(DISTINCT w.id) AS wakeup_count
      FROM items i
      LEFT JOIN promise_wakeups w
        ON w.item_id = i.id AND w.state = 'ready'
      WHERE i.status = 'ready'
        AND (?1 IS NULL OR i.project_id = ?1)
        AND (
          i.claimed_by IS NULL
          OR i.claim_expires_at IS NULL
          OR i.claim_expires_at <= ?2
          OR (?3 IS NOT NULL AND i.claimed_by = ?3)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM work_runs r
          WHERE r.item_id = i.id
            AND (
              r.status IN ('queued', 'starting', 'running', 'waiting', 'blocked')
              OR (r.status = 'failed' AND r.next_retry_at IS NOT NULL)
            )
        )
      GROUP BY i.id
      ORDER BY
        CASE WHEN COUNT(DISTINCT w.id) > 0 THEN 0 ELSE 1 END,
        i.priority DESC,
        i.created_at ASC,
        i.id ASC
      LIMIT ?4
    `)
    .all(input.project, input.now, input.actorId, input.limit);
}

function mapCandidate(row: CandidateRow): DispatchCandidate {
  const wakeups = Number(row.wakeup_count) || 0;
  return {
    itemId: row.id,
    project: row.project_id,
    kind: row.kind,
    title: row.title,
    priority: row.priority,
    createdAt: row.created_at,
    readyPromiseWakeups: wakeups,
    explanation: [
      wakeups > 0
        ? `${wakeups} durable promise wakeup${wakeups === 1 ? "" : "s"} ready`
        : "ready work without a promise wakeup",
      `priority ${row.priority}`,
      `created ${row.created_at}`,
    ],
  };
}

function reconciliationSummary(
  promises: ReconcileWorkPromisesResult,
  abandonedRuns: WorkRun[],
): DispatchSurvey["reconciliation"] {
  return {
    satisfiedPromiseIds: promises.satisfied.map((entry) => entry.id),
    missedPromiseIds: promises.missed.map((entry) => entry.id),
    abandonedRunIds: abandonedRuns.map((entry) => entry.id),
  };
}

function storeDispatchReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  requestJson: string,
  result: DispatchResult | null,
  now: string,
): void {
  if (!idempotencyKey) return;
  store.db
    .query(`
      INSERT INTO dispatch_commands (idempotency_key, request_json, result_json, created_at)
      VALUES (?1, ?2, ?3, ?4)
    `)
    .run(idempotencyKey, requestJson, JSON.stringify(result), now);
}

function getRunRow(store: StensiblyStore, id: string): RunRow {
  const row = store.db.query<RunRow, [string]>("SELECT * FROM work_runs WHERE id = ?1").get(id);
  if (!row) throw new NotFoundError(`Run ${id} does not exist`);
  return row;
}

function appendDispatchEvent(
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
  if (actor.kind === "human") throw new TypeError("Supervisor dispatch actor must be an agent or service");
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

function normalizeSurveyInput(raw: SurveyDispatchInput): { project?: string; limit: number } {
  const project = optionalProject(raw.project);
  return {
    ...(project ? { project } : {}),
    limit: positiveInteger(raw.limit ?? 20, "Candidate limit", 100),
  };
}

function normalizeDispatchInput(raw: DispatchNextWorkInput) {
  const actor = actorSchema.parse(raw.actor);
  if (actor.kind === "human") throw new TypeError("Supervisor dispatch actor must be an agent or service");
  const project = optionalProject(raw.project);
  const externalRunId = optionalText(raw.externalRunId, "External run ID", 240);
  const continuationRef = optionalText(raw.continuationRef, "Continuation reference", 500);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    actor,
    runnerType: requiredText(raw.runnerType, "Runner type", 80),
    runnerProfile: requiredText(raw.runnerProfile, "Runner profile", 160),
    ...(project ? { project } : {}),
    ...(externalRunId ? { externalRunId } : {}),
    ...(continuationRef ? { continuationRef } : {}),
    leaseSeconds: positiveInteger(raw.leaseSeconds ?? 900, "Lease seconds", 86_400, 30),
    maxAttempts: positiveInteger(raw.maxAttempts ?? 3, "Maximum attempts", 20),
    retryBackoffSeconds: positiveInteger(raw.retryBackoffSeconds ?? 60, "Retry backoff seconds", 86_400, 0),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function dispatchRequest(input: ReturnType<typeof normalizeDispatchInput>) {
  return {
    actor: input.actor,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    project: input.project ?? null,
    externalRunId: input.externalRunId ?? null,
    continuationRef: input.continuationRef ?? null,
    leaseSeconds: input.leaseSeconds,
    maxAttempts: input.maxAttempts,
    retryBackoffSeconds: input.retryBackoffSeconds,
  };
}

function mapRun(row: RunRow): WorkRun {
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

function parseUsage(json: string): WorkRun["usage"] {
  const value = JSON.parse(json) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: WorkRun["usage"] = {};
  for (const key of ["inputTokens", "outputTokens", "toolCalls", "childAgents"] as const) {
    const entry = (value as Record<string, unknown>)[key];
    if (Number.isInteger(entry) && Number(entry) >= 0) output[key] = Number(entry);
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

function requiredText(value: unknown, label: string, maxLength: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maxLength) throw new TypeError(`${label} may contain at most ${maxLength} characters`);
  return output;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) return undefined;
  if (output.length > maxLength) throw new TypeError(`${label} may contain at most ${maxLength} characters`);
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
