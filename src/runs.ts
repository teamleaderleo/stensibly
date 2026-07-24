import { randomUUID } from "node:crypto";
import { actorSchema, type ActorInput } from "./schemas.js";
import { ConflictError, NotFoundError, StensiblyStore } from "./store.js";

export const runStatuses = [
  "queued",
  "starting",
  "running",
  "waiting",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export const runCommands = [
  "start",
  "run",
  "wait",
  "block",
  "resume",
  "succeed",
  "fail",
  "retry",
  "cancel",
] as const;

export type WorkRunStatus = typeof runStatuses[number];
export type WorkRunCommand = typeof runCommands[number];

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  childAgents?: number;
}

export interface WorkRun {
  id: string;
  itemId: string;
  actorId: string;
  runnerType: string;
  runnerProfile: string;
  externalRunId: string | null;
  status: WorkRunStatus;
  generation: number;
  leaseGeneration: number;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  checkpoint: string | null;
  outcome: string | null;
  continuationRef: string | null;
  usage: RunUsage;
  retryAttempt: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface CreateWorkRunInput {
  itemId: string;
  actor: ActorInput;
  runnerType: string;
  runnerProfile: string;
  externalRunId?: string;
  continuationRef?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  idempotencyKey?: string;
}

export interface HeartbeatWorkRunInput {
  id: string;
  actor: ActorInput;
  expectedGeneration: number;
  expectedLeaseGeneration: number;
  leaseSeconds?: number;
  checkpoint?: string;
  usage?: RunUsage;
  idempotencyKey?: string;
}

export interface TransitionWorkRunInput {
  id: string;
  actor: ActorInput;
  command: WorkRunCommand;
  expectedGeneration: number;
  expectedLeaseGeneration: number;
  leaseSeconds?: number;
  checkpoint?: string;
  outcome?: string;
  continuationRef?: string;
  usage?: RunUsage;
  idempotencyKey?: string;
}

export interface ListWorkRunsInput {
  itemId?: string;
  actorId?: string;
  status?: WorkRunStatus;
}

export interface ReconcileRunsResult {
  abandoned: WorkRun[];
}

interface RunRow {
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
  creation_request_json: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

interface CommandRow {
  run_id: string;
  command: string;
  request_json: string;
  result_json: string;
}

const initializedStores = new WeakSet<StensiblyStore>();
const leasedStatuses: WorkRunStatus[] = ["queued", "starting", "running", "waiting"];
const terminalStatuses: WorkRunStatus[] = ["succeeded", "cancelled", "abandoned"];

export function createWorkRun(
  store: StensiblyStore,
  rawInput: CreateWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const input = normalizeCreateInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(createRequest(input));

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = store.db
        .query<RunRow, [string]>("SELECT * FROM work_runs WHERE idempotency_key = ?1")
        .get(input.idempotencyKey);
      if (existing) {
        if (existing.creation_request_json !== requestJson) {
          throw new ConflictError("Idempotency key was already used for a different run");
        }
        return existing;
      }
    }

    store.getItem(input.itemId);
    const conflict = findLiveRun(store, input.itemId);
    if (conflict) throw new ConflictError(`Item already has live run ${conflict.id}`);
    upsertActor(store, input.actor, timestamp);
    const id = `run_${randomUUID()}`;
    const leaseExpiresAt = addSeconds(now, input.leaseSeconds);
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
          ?11, ?12, ?13, ?13,
          NULL, NULL
        )
      `)
      .run(
        id,
        input.itemId,
        input.actor.id,
        input.runnerType,
        input.runnerProfile,
        input.externalRunId ?? null,
        leaseExpiresAt,
        input.continuationRef ?? null,
        input.maxAttempts,
        input.retryBackoffSeconds,
        requestJson,
        input.idempotencyKey ?? null,
        timestamp,
      );

    appendRunEvent(store, {
      itemId: input.itemId,
      actorId: input.actor.id,
      type: "run.queued",
      payload: {
        runId: id,
        generation: 1,
        leaseGeneration: 1,
        leaseExpiresAt,
        runnerType: input.runnerType,
        runnerProfile: input.runnerProfile,
      },
      now: timestamp,
    });
    touchItem(store, input.itemId, timestamp);
    return getRunRow(store, id);
  });

  return mapRun(transaction());
}

export function getWorkRun(store: StensiblyStore, id: string, now = new Date()): WorkRun {
  ensureRunSchema(store);
  reconcileStaleRuns(store, now);
  return mapRun(getRunRow(store, requiredText(id, "Run ID", 240)));
}

export function listWorkRuns(
  store: StensiblyStore,
  input: ListWorkRunsInput = {},
  now = new Date(),
): WorkRun[] {
  ensureRunSchema(store);
  reconcileStaleRuns(store, now);
  const itemId = input.itemId ? requiredText(input.itemId, "Item ID", 240) : null;
  const actorId = input.actorId ? requiredText(input.actorId, "Actor ID", 120) : null;
  const status = input.status ? enumValue(input.status, runStatuses, "Run status") : null;
  return store.db
    .query<RunRow, [string | null, string | null, string | null]>(`
      SELECT *
      FROM work_runs
      WHERE (?1 IS NULL OR item_id = ?1)
        AND (?2 IS NULL OR actor_id = ?2)
        AND (?3 IS NULL OR status = ?3)
      ORDER BY created_at DESC, id DESC
    `)
    .all(itemId, actorId, status)
    .map(mapRun);
}

export function listRetryEligibleRuns(store: StensiblyStore, now = new Date()): WorkRun[] {
  ensureRunSchema(store);
  reconcileStaleRuns(store, now);
  const timestamp = isoNow(now);
  return store.db
    .query<RunRow, [string]>(`
      SELECT *
      FROM work_runs
      WHERE status = 'failed'
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= ?1
        AND retry_attempt < max_attempts
      ORDER BY next_retry_at ASC, created_at ASC, id ASC
    `)
    .all(timestamp)
    .map(mapRun);
}

export function heartbeatWorkRun(
  store: StensiblyStore,
  rawInput: HeartbeatWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const input = normalizeHeartbeatInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(heartbeatRequest(input));

  const transaction = store.db.transaction(() => {
    const replay = replayCommand(store, input.idempotencyKey, input.id, "heartbeat", requestJson);
    if (replay) return replay;
    const current = getRunRow(store, input.id);
    requireGeneration(current, input.expectedGeneration);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    if (!["starting", "running", "waiting"].includes(current.status)) {
      throw new ConflictError(`Run cannot heartbeat while ${current.status}`);
    }

    upsertActor(store, input.actor, timestamp);
    const leaseExpiresAt = addSeconds(now, input.leaseSeconds);
    const usage = mergeUsage(parseUsage(current.usage_json), input.usage);
    const result = store.db
      .query(`
        UPDATE work_runs
        SET lease_expires_at = ?1,
            last_heartbeat_at = ?2,
            checkpoint = ?3,
            usage_json = ?4,
            updated_at = ?2
        WHERE id = ?5 AND generation = ?6 AND lease_generation = ?7 AND status = ?8
      `)
      .run(
        leaseExpiresAt,
        timestamp,
        input.checkpoint ?? current.checkpoint,
        JSON.stringify(usage),
        input.id,
        current.generation,
        current.lease_generation,
        current.status,
      );
    if (result.changes !== 1) throw new ConflictError("Run changed while the heartbeat was being applied");

    appendRunEvent(store, {
      itemId: current.item_id,
      actorId: input.actor.id,
      type: "run.heartbeat",
      payload: {
        runId: input.id,
        generation: current.generation,
        leaseGeneration: current.lease_generation,
        leaseExpiresAt,
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        usage,
      },
      now: timestamp,
    });
    touchItem(store, current.item_id, timestamp);
    const updated = mapRun(getRunRow(store, input.id));
    storeCommandReplay(store, input.idempotencyKey, input.id, "heartbeat", requestJson, updated, timestamp);
    return updated;
  });

  return transaction();
}

export function transitionWorkRun(
  store: StensiblyStore,
  rawInput: TransitionWorkRunInput,
  now = new Date(),
): WorkRun {
  ensureRunSchema(store);
  const input = normalizeTransitionInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(transitionRequest(input));

  const transaction = store.db.transaction(() => {
    const replay = replayCommand(store, input.idempotencyKey, input.id, input.command, requestJson);
    if (replay) return replay;
    const current = getRunRow(store, input.id);
    requireGeneration(current, input.expectedGeneration);
    if (current.lease_generation !== input.expectedLeaseGeneration) {
      throw new ConflictError(
        `Run lease generation changed from ${input.expectedLeaseGeneration} to ${current.lease_generation}`,
      );
    }
    if (terminalStatuses.includes(current.status) || (current.status === "failed" && current.next_retry_at === null)) {
      throw new ConflictError(`Run cannot ${input.command} while ${current.status}`);
    }

    upsertActor(store, input.actor, timestamp);
    const next = nextRunState(current, input, now);
    const result = store.db
      .query(`
        UPDATE work_runs
        SET status = ?1,
            generation = ?2,
            lease_generation = ?3,
            lease_owner_id = ?4,
            lease_expires_at = ?5,
            last_heartbeat_at = ?6,
            checkpoint = ?7,
            outcome = ?8,
            continuation_ref = ?9,
            usage_json = ?10,
            retry_attempt = ?11,
            next_retry_at = ?12,
            updated_at = ?13,
            started_at = ?14,
            ended_at = ?15
        WHERE id = ?16 AND generation = ?17 AND lease_generation = ?18 AND status = ?19
      `)
      .run(
        next.status,
        next.generation,
        next.leaseGeneration,
        next.leaseOwnerId,
        next.leaseExpiresAt,
        next.lastHeartbeatAt,
        next.checkpoint,
        next.outcome,
        next.continuationRef,
        JSON.stringify(next.usage),
        next.retryAttempt,
        next.nextRetryAt,
        timestamp,
        next.startedAt,
        next.endedAt,
        input.id,
        current.generation,
        current.lease_generation,
        current.status,
      );
    if (result.changes !== 1) throw new ConflictError("Run changed while the command was being applied");

    const eventType = input.command === "retry" ? "run.retry_queued" : `run.${next.status}`;
    appendRunEvent(store, {
      itemId: current.item_id,
      actorId: input.actor.id,
      type: eventType,
      payload: {
        runId: input.id,
        command: input.command,
        fromStatus: current.status,
        toStatus: next.status,
        generation: next.generation,
        leaseGeneration: next.leaseGeneration,
        retryAttempt: next.retryAttempt,
        ...(next.leaseExpiresAt ? { leaseExpiresAt: next.leaseExpiresAt } : {}),
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        ...(input.outcome ? { outcome: input.outcome } : {}),
      },
      now: timestamp,
    });
    touchItem(store, current.item_id, timestamp);
    const updated = mapRun(getRunRow(store, input.id));
    storeCommandReplay(store, input.idempotencyKey, input.id, input.command, requestJson, updated, timestamp);
    return updated;
  });

  return transaction();
}

export function reconcileStaleRuns(store: StensiblyStore, now = new Date()): ReconcileRunsResult {
  ensureRunSchema(store);
  const timestamp = isoNow(now);
  const abandoned: WorkRun[] = [];
  const transaction = store.db.transaction(() => {
    const rows = store.db
      .query<RunRow, [string]>(`
        SELECT *
        FROM work_runs
        WHERE status IN ('starting', 'running', 'waiting')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1
        ORDER BY lease_expires_at ASC, id ASC
      `)
      .all(timestamp);
    for (const current of rows) {
      const nextGeneration = current.generation + 1;
      const result = store.db
        .query(`
          UPDATE work_runs
          SET status = 'abandoned',
              generation = ?1,
              lease_owner_id = NULL,
              lease_expires_at = NULL,
              outcome = 'Run lease expired without a heartbeat.',
              next_retry_at = NULL,
              updated_at = ?2,
              ended_at = ?2
          WHERE id = ?3 AND generation = ?4 AND status = ?5
            AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?2
        `)
        .run(nextGeneration, timestamp, current.id, current.generation, current.status);
      if (result.changes !== 1) continue;
      appendRunEvent(store, {
        itemId: current.item_id,
        actorId: null,
        type: "run.abandoned",
        payload: {
          runId: current.id,
          fromStatus: current.status,
          generation: nextGeneration,
          leaseGeneration: current.lease_generation,
          reason: "lease_expired",
        },
        now: timestamp,
      });
      touchItem(store, current.item_id, timestamp);
      abandoned.push(mapRun(getRunRow(store, current.id)));
    }
  });
  transaction();
  return { abandoned };
}

export function ensureRunSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS work_runs (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      runner_type TEXT NOT NULL,
      runner_profile TEXT NOT NULL,
      external_run_id TEXT,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'starting', 'running', 'waiting', 'blocked',
        'succeeded', 'failed', 'cancelled', 'abandoned'
      )),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      lease_generation INTEGER NOT NULL DEFAULT 1 CHECK (lease_generation >= 1),
      lease_owner_id TEXT REFERENCES actors(id),
      lease_expires_at TEXT,
      last_heartbeat_at TEXT,
      checkpoint TEXT,
      outcome TEXT,
      continuation_ref TEXT,
      usage_json TEXT NOT NULL DEFAULT '{}',
      retry_attempt INTEGER NOT NULL DEFAULT 0 CHECK (retry_attempt >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
      retry_backoff_seconds INTEGER NOT NULL DEFAULT 60 CHECK (retry_backoff_seconds >= 0),
      next_retry_at TEXT,
      creation_request_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS run_commands (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES work_runs(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_runs_one_live_item
      ON work_runs(item_id)
      WHERE status IN ('queued', 'starting', 'running', 'waiting', 'blocked')
         OR (status = 'failed' AND next_retry_at IS NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_work_runs_status_lease
      ON work_runs(status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_work_runs_retry
      ON work_runs(status, next_retry_at);
  `);
  initializedStores.add(store);
}

function nextRunState(current: RunRow, input: ReturnType<typeof normalizeTransitionInput>, now: Date) {
  const timestamp = isoNow(now);
  const usage = mergeUsage(parseUsage(current.usage_json), input.usage);
  const common = {
    status: current.status,
    generation: current.generation + 1,
    leaseGeneration: current.lease_generation,
    leaseOwnerId: current.lease_owner_id,
    leaseExpiresAt: current.lease_expires_at,
    lastHeartbeatAt: current.last_heartbeat_at,
    checkpoint: input.checkpoint ?? current.checkpoint,
    outcome: input.outcome ?? current.outcome,
    continuationRef: input.continuationRef ?? current.continuation_ref,
    usage,
    retryAttempt: current.retry_attempt,
    nextRetryAt: current.next_retry_at,
    startedAt: current.started_at,
    endedAt: current.ended_at,
  };

  if (input.command === "start") {
    requireStatus(current, ["queued"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return { ...common, status: "starting" as const, startedAt: current.started_at ?? timestamp };
  }
  if (input.command === "run") {
    requireStatus(current, ["starting"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return { ...common, status: "running" as const, lastHeartbeatAt: timestamp };
  }
  if (input.command === "wait") {
    requireStatus(current, ["running"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return { ...common, status: "waiting" as const, lastHeartbeatAt: timestamp };
  }
  if (input.command === "block") {
    requireStatus(current, ["starting", "running", "waiting"], input.command);
    requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    return {
      ...common,
      status: "blocked" as const,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: timestamp,
    };
  }
  if (input.command === "resume") {
    requireStatus(current, ["waiting", "blocked"], input.command);
    if (current.status === "waiting") {
      requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
      return { ...common, status: "running" as const, lastHeartbeatAt: timestamp };
    }
    const leaseGeneration = current.lease_generation + 1;
    return {
      ...common,
      status: "running" as const,
      leaseGeneration,
      leaseOwnerId: input.actor.id,
      leaseExpiresAt: addSeconds(now, input.leaseSeconds),
      lastHeartbeatAt: timestamp,
    };
  }
  if (input.command === "succeed") {
    requireStatus(current, ["starting", "running", "waiting", "blocked"], input.command);
    if (leasedStatuses.includes(current.status)) {
      requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    }
    return {
      ...common,
      status: "succeeded" as const,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      endedAt: timestamp,
    };
  }
  if (input.command === "fail") {
    requireStatus(current, ["starting", "running", "waiting", "blocked"], input.command);
    if (leasedStatuses.includes(current.status)) {
      requireLiveLease(current, input.actor.id, input.expectedLeaseGeneration, now);
    }
    const retryAttempt = current.retry_attempt + 1;
    const nextRetryAt = retryAttempt < current.max_attempts
      ? addSeconds(now, current.retry_backoff_seconds * Math.max(retryAttempt, 1))
      : null;
    return {
      ...common,
      status: "failed" as const,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      retryAttempt,
      nextRetryAt,
      endedAt: timestamp,
    };
  }
  if (input.command === "retry") {
    requireStatus(current, ["failed"], input.command);
    if (!current.next_retry_at || Date.parse(current.next_retry_at) > now.getTime()) {
      throw new ConflictError("Run is not eligible for retry yet");
    }
    if (current.retry_attempt >= current.max_attempts) {
      throw new ConflictError("Run retry budget is exhausted");
    }
    return {
      ...common,
      status: "queued" as const,
      leaseGeneration: current.lease_generation + 1,
      leaseOwnerId: input.actor.id,
      leaseExpiresAt: addSeconds(now, input.leaseSeconds),
      lastHeartbeatAt: null,
      outcome: null,
      nextRetryAt: null,
      startedAt: null,
      endedAt: null,
    };
  }
  if (input.command === "cancel") {
    requireStatus(current, ["queued", "starting", "running", "waiting", "blocked", "failed"], input.command);
    return {
      ...common,
      status: "cancelled" as const,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      endedAt: timestamp,
    };
  }
  throw new TypeError("Run command is unsupported");
}

function requireStatus(current: RunRow, statuses: WorkRunStatus[], command: WorkRunCommand): void {
  if (!statuses.includes(current.status)) throw new ConflictError(`Run cannot ${command} while ${current.status}`);
}

function requireGeneration(current: RunRow, expected: number): void {
  if (current.generation !== expected) {
    throw new ConflictError(`Run generation changed from ${expected} to ${current.generation}`);
  }
}

function requireLiveLease(current: RunRow, actorId: string, expectedLeaseGeneration: number, now: Date): void {
  if (current.lease_generation !== expectedLeaseGeneration) {
    throw new ConflictError(
      `Run lease generation changed from ${expectedLeaseGeneration} to ${current.lease_generation}`,
    );
  }
  if (current.lease_owner_id !== actorId) throw new ConflictError("Only the current run lease owner can perform this action");
  if (!current.lease_expires_at || Date.parse(current.lease_expires_at) <= now.getTime()) {
    throw new ConflictError("Run lease has expired");
  }
}

function findLiveRun(store: StensiblyStore, itemId: string): RunRow | null {
  return store.db
    .query<RunRow, [string]>(`
      SELECT *
      FROM work_runs
      WHERE item_id = ?1
        AND (
          status IN ('queued', 'starting', 'running', 'waiting', 'blocked')
          OR (status = 'failed' AND next_retry_at IS NOT NULL)
        )
      LIMIT 1
    `)
    .get(itemId);
}

function replayCommand(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  runId: string,
  command: string,
  requestJson: string,
): WorkRun | null {
  if (!idempotencyKey) return null;
  const existing = store.db
    .query<CommandRow, [string]>(
      "SELECT run_id, command, request_json, result_json FROM run_commands WHERE idempotency_key = ?1",
    )
    .get(idempotencyKey);
  if (!existing) return null;
  if (existing.run_id !== runId || existing.command !== command || existing.request_json !== requestJson) {
    throw new ConflictError("Idempotency key was already used for a different run command");
  }
  return JSON.parse(existing.result_json) as WorkRun;
}

function storeCommandReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  runId: string,
  command: string,
  requestJson: string,
  result: WorkRun,
  now: string,
): void {
  if (!idempotencyKey) return;
  store.db
    .query(`
      INSERT INTO run_commands (
        idempotency_key, run_id, command, request_json, result_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `)
    .run(idempotencyKey, runId, command, requestJson, JSON.stringify(result), now);
}

function getRunRow(store: StensiblyStore, id: string): RunRow {
  const row = store.db.query<RunRow, [string]>("SELECT * FROM work_runs WHERE id = ?1").get(id);
  if (!row) throw new NotFoundError(`Run ${id} does not exist`);
  return row;
}

function appendRunEvent(
  store: StensiblyStore,
  input: {
    itemId: string;
    actorId: string | null;
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

function touchItem(store: StensiblyStore, itemId: string, now: string): void {
  const result = store.db
    .query("UPDATE items SET version = version + 1, updated_at = ?1 WHERE id = ?2")
    .run(now, itemId);
  if (result.changes !== 1) throw new NotFoundError(`Item ${itemId} does not exist`);
}

function upsertActor(store: StensiblyStore, rawActor: ActorInput, now: string): ActorInput {
  const actor = actorSchema.parse(rawActor);
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

function normalizeCreateInput(raw: CreateWorkRunInput) {
  const externalRunId = optionalText(raw.externalRunId, "External run ID", 240);
  const continuationRef = optionalText(raw.continuationRef, "Continuation reference", 500);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    itemId: requiredText(raw.itemId, "Item ID", 240),
    actor: actorSchema.parse(raw.actor),
    runnerType: requiredText(raw.runnerType, "Runner type", 80),
    runnerProfile: requiredText(raw.runnerProfile, "Runner profile", 160),
    ...(externalRunId ? { externalRunId } : {}),
    ...(continuationRef ? { continuationRef } : {}),
    leaseSeconds: leaseSeconds(raw.leaseSeconds),
    maxAttempts: positiveInteger(raw.maxAttempts ?? 3, "Maximum attempts", 20),
    retryBackoffSeconds: nonNegativeInteger(raw.retryBackoffSeconds ?? 60, "Retry backoff seconds", 86_400),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function normalizeHeartbeatInput(raw: HeartbeatWorkRunInput) {
  const checkpoint = optionalText(raw.checkpoint, "Checkpoint", 10_000);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    id: requiredText(raw.id, "Run ID", 240),
    actor: actorSchema.parse(raw.actor),
    expectedGeneration: positiveInteger(raw.expectedGeneration, "Expected generation"),
    expectedLeaseGeneration: positiveInteger(raw.expectedLeaseGeneration, "Expected lease generation"),
    leaseSeconds: leaseSeconds(raw.leaseSeconds),
    ...(checkpoint ? { checkpoint } : {}),
    usage: normalizeUsage(raw.usage),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function normalizeTransitionInput(raw: TransitionWorkRunInput) {
  const checkpoint = optionalText(raw.checkpoint, "Checkpoint", 10_000);
  const outcome = optionalText(raw.outcome, "Outcome", 10_000);
  const continuationRef = optionalText(raw.continuationRef, "Continuation reference", 500);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    id: requiredText(raw.id, "Run ID", 240),
    actor: actorSchema.parse(raw.actor),
    command: enumValue(raw.command, runCommands, "Run command"),
    expectedGeneration: positiveInteger(raw.expectedGeneration, "Expected generation"),
    expectedLeaseGeneration: positiveInteger(raw.expectedLeaseGeneration, "Expected lease generation"),
    leaseSeconds: leaseSeconds(raw.leaseSeconds),
    ...(checkpoint ? { checkpoint } : {}),
    ...(outcome ? { outcome } : {}),
    ...(continuationRef ? { continuationRef } : {}),
    usage: normalizeUsage(raw.usage),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function createRequest(input: ReturnType<typeof normalizeCreateInput>) {
  return {
    itemId: input.itemId,
    actor: input.actor,
    runnerType: input.runnerType,
    runnerProfile: input.runnerProfile,
    externalRunId: input.externalRunId ?? null,
    continuationRef: input.continuationRef ?? null,
    leaseSeconds: input.leaseSeconds,
    maxAttempts: input.maxAttempts,
    retryBackoffSeconds: input.retryBackoffSeconds,
  };
}

function heartbeatRequest(input: ReturnType<typeof normalizeHeartbeatInput>) {
  return {
    id: input.id,
    actor: input.actor,
    expectedGeneration: input.expectedGeneration,
    expectedLeaseGeneration: input.expectedLeaseGeneration,
    leaseSeconds: input.leaseSeconds,
    checkpoint: input.checkpoint ?? null,
    usage: input.usage,
  };
}

function transitionRequest(input: ReturnType<typeof normalizeTransitionInput>) {
  return {
    id: input.id,
    actor: input.actor,
    command: input.command,
    expectedGeneration: input.expectedGeneration,
    expectedLeaseGeneration: input.expectedLeaseGeneration,
    leaseSeconds: input.leaseSeconds,
    checkpoint: input.checkpoint ?? null,
    outcome: input.outcome ?? null,
    continuationRef: input.continuationRef ?? null,
    usage: input.usage,
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

function normalizeUsage(raw: RunUsage | undefined): RunUsage {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Run usage must be an object");
  const output: RunUsage = {};
  if (raw.inputTokens !== undefined) output.inputTokens = nonNegativeInteger(raw.inputTokens, "Input tokens");
  if (raw.outputTokens !== undefined) output.outputTokens = nonNegativeInteger(raw.outputTokens, "Output tokens");
  if (raw.toolCalls !== undefined) output.toolCalls = nonNegativeInteger(raw.toolCalls, "Tool calls");
  if (raw.childAgents !== undefined) output.childAgents = nonNegativeInteger(raw.childAgents, "Child agents");
  return output;
}

function mergeUsage(current: RunUsage, patch: RunUsage): RunUsage {
  return { ...current, ...patch };
}

function parseUsage(json: string): RunUsage {
  return normalizeUsage(JSON.parse(json) as RunUsage);
}

function leaseSeconds(value: unknown): number {
  return positiveInteger(value ?? 900, "Lease seconds", 86_400, 30);
}

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function positiveInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER, minimum = 1): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) {
    throw new TypeError(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return output;
}

function nonNegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  return positiveInteger(value, label, maximum, 0);
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

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, label: string): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${label} is invalid`);
  return value as Values[number];
}
