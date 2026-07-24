import { randomUUID } from "node:crypto";
import { actorSchema, itemStatuses, type ActorInput } from "./schemas.js";
import { ConflictError, NotFoundError, StensiblyStore, type ItemStatus } from "./store.js";

export const promiseStatuses = [
  "pending",
  "satisfied",
  "superseded",
  "cancelled",
  "missed",
  "escalated",
] as const;

export const promiseCommands = ["satisfy", "supersede", "cancel", "escalate"] as const;

export type WorkPromiseStatus = typeof promiseStatuses[number];
export type WorkPromiseCommand = typeof promiseCommands[number];

export type PromiseWakeCondition =
  | { kind: "at_time"; at: string }
  | { kind: "after_event"; eventType: string; delaySeconds: number }
  | { kind: "item_status"; itemId: string; status: ItemStatus }
  | { kind: "manual" };

export interface PromiseEvidence {
  kind: string;
  label: string;
  uri?: string;
  note?: string;
}

export interface WorkPromise {
  id: string;
  itemId: string;
  responsibleActorId: string;
  runnerProfile: string | null;
  action: string;
  question: string | null;
  wakeCondition: PromiseWakeCondition;
  status: WorkPromiseStatus;
  generation: number;
  expectedCheckInAt: string;
  lastHeartbeatAt: string | null;
  evidence: PromiseEvidence[];
  resolutionActorId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface PromiseWakeup {
  id: string;
  promiseId: string;
  promiseGeneration: number;
  itemId: string;
  state: "ready";
  createdAt: string;
}

export interface CreateWorkPromiseInput {
  itemId: string;
  actor: ActorInput;
  runnerProfile?: string;
  action: string;
  question?: string;
  wakeCondition: PromiseWakeCondition;
  expectedCheckInAt: string;
  evidence?: PromiseEvidence[];
  idempotencyKey?: string;
}

export interface HeartbeatWorkPromiseInput {
  id: string;
  actor: ActorInput;
  expectedGeneration: number;
  nextCheckInAt: string;
  evidence?: PromiseEvidence[];
  idempotencyKey?: string;
}

export interface ResolveWorkPromiseInput {
  id: string;
  actor: ActorInput;
  command: WorkPromiseCommand;
  expectedGeneration: number;
  note?: string;
  evidence?: PromiseEvidence[];
  idempotencyKey?: string;
}

export interface ListWorkPromisesInput {
  itemId?: string;
  responsibleActorId?: string;
  status?: WorkPromiseStatus;
}

export interface ReconcileWorkPromisesResult {
  satisfied: WorkPromise[];
  missed: WorkPromise[];
  wakeups: PromiseWakeup[];
}

interface PromiseRow {
  id: string;
  item_id: string;
  responsible_actor_id: string;
  runner_profile: string | null;
  action: string;
  question: string | null;
  wake_json: string;
  status: WorkPromiseStatus;
  generation: number;
  expected_check_in_at: string;
  last_heartbeat_at: string | null;
  evidence_json: string;
  resolution_actor_id: string | null;
  resolution_note: string | null;
  creation_request_json: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface CommandRow {
  promise_id: string;
  command: string;
  request_json: string;
  result_json: string;
}

interface WakeupRow {
  id: string;
  promise_id: string;
  promise_generation: number;
  item_id: string;
  state: "ready";
  created_at: string;
}

const initializedStores = new WeakSet<StensiblyStore>();
const heartbeatStatuses: WorkPromiseStatus[] = ["pending", "missed"];

const transitions: Record<WorkPromiseCommand, Partial<Record<WorkPromiseStatus, WorkPromiseStatus>>> = {
  satisfy: { pending: "satisfied", missed: "satisfied", escalated: "satisfied" },
  supersede: { pending: "superseded", missed: "superseded", escalated: "superseded" },
  cancel: { pending: "cancelled", missed: "cancelled", escalated: "cancelled" },
  escalate: { pending: "escalated", missed: "escalated" },
};

export function createWorkPromise(
  store: StensiblyStore,
  rawInput: CreateWorkPromiseInput,
  now = new Date(),
): WorkPromise {
  ensurePromiseSchema(store);
  const input = normalizeCreateInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(createRequest(input));

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = store.db
        .query<PromiseRow, [string]>("SELECT * FROM work_promises WHERE idempotency_key = ?1")
        .get(input.idempotencyKey);
      if (existing) {
        if (existing.creation_request_json !== requestJson) {
          throw new ConflictError("Idempotency key was already used for a different promise");
        }
        return existing;
      }
    }

    store.getItem(input.itemId);
    upsertActor(store, input.actor, timestamp);
    const id = `promise_${randomUUID()}`;
    store.db
      .query(`
        INSERT INTO work_promises (
          id, item_id, responsible_actor_id, runner_profile, action, question,
          wake_json, status, generation, expected_check_in_at, last_heartbeat_at,
          evidence_json, creation_request_json, idempotency_key,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          ?7, 'pending', 1, ?8, NULL,
          ?9, ?10, ?11,
          ?12, ?12
        )
      `)
      .run(
        id,
        input.itemId,
        input.actor.id,
        input.runnerProfile ?? null,
        input.action,
        input.question ?? null,
        JSON.stringify(input.wakeCondition),
        input.expectedCheckInAt,
        JSON.stringify(input.evidence),
        requestJson,
        input.idempotencyKey ?? null,
        timestamp,
      );

    appendPromiseEvent(store, {
      itemId: input.itemId,
      actorId: input.actor.id,
      type: "promise.created",
      payload: {
        promiseId: id,
        generation: 1,
        wakeKind: input.wakeCondition.kind,
        expectedCheckInAt: input.expectedCheckInAt,
        ...(input.runnerProfile ? { runnerProfile: input.runnerProfile } : {}),
      },
      now: timestamp,
    });
    touchItem(store, input.itemId, timestamp);
    return getPromiseRow(store, id);
  });

  return mapPromise(transaction());
}

export function getWorkPromise(
  store: StensiblyStore,
  id: string,
  now = new Date(),
): WorkPromise {
  ensurePromiseSchema(store);
  reconcileWorkPromises(store, now);
  return mapPromise(getPromiseRow(store, requiredText(id, "Promise ID", 240)));
}

export function listWorkPromises(
  store: StensiblyStore,
  input: ListWorkPromisesInput = {},
  now = new Date(),
): WorkPromise[] {
  ensurePromiseSchema(store);
  reconcileWorkPromises(store, now);
  const itemId = input.itemId ? requiredText(input.itemId, "Item ID", 240) : null;
  const actorId = input.responsibleActorId
    ? requiredText(input.responsibleActorId, "Responsible actor ID", 120)
    : null;
  const status = input.status ? enumValue(input.status, promiseStatuses, "Promise status") : null;
  return store.db
    .query<PromiseRow, [string | null, string | null, string | null]>(`
      SELECT *
      FROM work_promises
      WHERE (?1 IS NULL OR item_id = ?1)
        AND (?2 IS NULL OR responsible_actor_id = ?2)
        AND (?3 IS NULL OR status = ?3)
      ORDER BY created_at DESC, id DESC
    `)
    .all(itemId, actorId, status)
    .map(mapPromise);
}

export function recordPromiseHeartbeat(
  store: StensiblyStore,
  rawInput: HeartbeatWorkPromiseInput,
  now = new Date(),
): WorkPromise {
  ensurePromiseSchema(store);
  const input = normalizeHeartbeatInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(heartbeatRequest(input));

  const transaction = store.db.transaction(() => {
    const replay = replayCommand(store, input.idempotencyKey, input.id, "heartbeat", requestJson);
    if (replay) return replay;

    const current = getPromiseRow(store, input.id);
    if (!heartbeatStatuses.includes(current.status)) {
      throw new ConflictError(`Promise cannot receive a heartbeat while ${current.status}`);
    }
    if (current.generation !== input.expectedGeneration) {
      throw generationConflict(input.expectedGeneration, current.generation);
    }

    upsertActor(store, input.actor, timestamp);
    const nextEvidence = mergeEvidence(parseEvidence(current.evidence_json), input.evidence);
    const recovering = current.status === "missed";
    const nextGeneration = recovering ? current.generation + 1 : current.generation;
    const result = store.db
      .query(`
        UPDATE work_promises
        SET status = 'pending',
            generation = ?1,
            expected_check_in_at = ?2,
            last_heartbeat_at = ?3,
            evidence_json = ?4,
            resolution_actor_id = NULL,
            resolution_note = NULL,
            resolved_at = NULL,
            updated_at = ?3
        WHERE id = ?5 AND generation = ?6 AND status = ?7
      `)
      .run(
        nextGeneration,
        input.nextCheckInAt,
        timestamp,
        JSON.stringify(nextEvidence),
        input.id,
        input.expectedGeneration,
        current.status,
      );
    if (result.changes !== 1) throw new ConflictError("Promise changed while the heartbeat was being applied");

    appendPromiseEvent(store, {
      itemId: current.item_id,
      actorId: input.actor.id,
      type: recovering ? "promise.recovered" : "promise.heartbeat",
      payload: {
        promiseId: input.id,
        generation: nextGeneration,
        nextCheckInAt: input.nextCheckInAt,
        evidenceCount: input.evidence.length,
      },
      now: timestamp,
    });
    touchItem(store, current.item_id, timestamp);
    const updated = mapPromise(getPromiseRow(store, input.id));
    storeCommandReplay(store, input.idempotencyKey, input.id, "heartbeat", requestJson, updated, timestamp);
    return updated;
  });

  return transaction();
}

export function resolveWorkPromise(
  store: StensiblyStore,
  rawInput: ResolveWorkPromiseInput,
  now = new Date(),
): WorkPromise {
  ensurePromiseSchema(store);
  const input = normalizeResolveInput(rawInput);
  const timestamp = isoNow(now);
  const requestJson = JSON.stringify(resolveRequest(input));

  const transaction = store.db.transaction(() => {
    const replay = replayCommand(store, input.idempotencyKey, input.id, input.command, requestJson);
    if (replay) return replay;

    const current = getPromiseRow(store, input.id);
    if (current.generation !== input.expectedGeneration) {
      throw generationConflict(input.expectedGeneration, current.generation);
    }
    const nextStatus = transitions[input.command][current.status];
    if (!nextStatus) {
      throw new ConflictError(`Promise cannot ${input.command} while ${current.status}`);
    }

    upsertActor(store, input.actor, timestamp);
    const nextGeneration = current.generation + 1;
    const nextEvidence = mergeEvidence(parseEvidence(current.evidence_json), input.evidence);
    const result = store.db
      .query(`
        UPDATE work_promises
        SET status = ?1,
            generation = ?2,
            evidence_json = ?3,
            resolution_actor_id = ?4,
            resolution_note = ?5,
            resolved_at = ?6,
            updated_at = ?6
        WHERE id = ?7 AND generation = ?8 AND status = ?9
      `)
      .run(
        nextStatus,
        nextGeneration,
        JSON.stringify(nextEvidence),
        input.actor.id,
        input.note ?? null,
        timestamp,
        input.id,
        input.expectedGeneration,
        current.status,
      );
    if (result.changes !== 1) throw new ConflictError("Promise changed while the command was being applied");

    appendPromiseEvent(store, {
      itemId: current.item_id,
      actorId: input.actor.id,
      type: `promise.${nextStatus}`,
      payload: {
        promiseId: input.id,
        command: input.command,
        fromStatus: current.status,
        toStatus: nextStatus,
        generation: nextGeneration,
        evidenceCount: input.evidence.length,
        ...(input.note ? { note: input.note } : {}),
      },
      now: timestamp,
    });
    if (nextStatus === "satisfied") {
      ensureWakeup(store, input.id, nextGeneration, current.item_id, timestamp);
    }
    touchItem(store, current.item_id, timestamp);
    const updated = mapPromise(getPromiseRow(store, input.id));
    storeCommandReplay(store, input.idempotencyKey, input.id, input.command, requestJson, updated, timestamp);
    return updated;
  });

  return transaction();
}

export function reconcileWorkPromises(
  store: StensiblyStore,
  now = new Date(),
): ReconcileWorkPromisesResult {
  ensurePromiseSchema(store);
  const timestamp = isoNow(now);
  const satisfied: WorkPromise[] = [];
  const missed: WorkPromise[] = [];
  const wakeups: PromiseWakeup[] = [];

  const transaction = store.db.transaction(() => {
    const rows = store.db
      .query<PromiseRow, []>("SELECT * FROM work_promises WHERE status = 'pending' ORDER BY created_at ASC, id ASC")
      .all();
    for (const row of rows) {
      if (isWakeDue(store, row, now)) {
        const updated = applyAutomaticStatus(store, row, "satisfied", timestamp, "wake_condition");
        if (updated) {
          satisfied.push(updated);
          const wakeup = getWakeupForGeneration(store, updated.id, updated.generation);
          if (wakeup) wakeups.push(mapWakeup(wakeup));
        }
        continue;
      }
      if (Date.parse(row.expected_check_in_at) <= now.getTime()) {
        const updated = applyAutomaticStatus(store, row, "missed", timestamp, "check_in_overdue");
        if (updated) missed.push(updated);
      }
    }
  });
  transaction();
  return { satisfied, missed, wakeups };
}

export function listReadyPromiseWakeups(store: StensiblyStore, now = new Date()): PromiseWakeup[] {
  ensurePromiseSchema(store);
  reconcileWorkPromises(store, now);
  return store.db
    .query<WakeupRow, []>("SELECT * FROM promise_wakeups WHERE state = 'ready' ORDER BY created_at ASC, id ASC")
    .all()
    .map(mapWakeup);
}

export function ensurePromiseSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS work_promises (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      responsible_actor_id TEXT NOT NULL REFERENCES actors(id),
      runner_profile TEXT,
      action TEXT NOT NULL,
      question TEXT,
      wake_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'satisfied', 'superseded', 'cancelled', 'missed', 'escalated')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      expected_check_in_at TEXT NOT NULL,
      last_heartbeat_at TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      resolution_actor_id TEXT REFERENCES actors(id),
      resolution_note TEXT,
      creation_request_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS promise_commands (
      idempotency_key TEXT PRIMARY KEY,
      promise_id TEXT NOT NULL REFERENCES work_promises(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promise_wakeups (
      id TEXT PRIMARY KEY,
      promise_id TEXT NOT NULL REFERENCES work_promises(id) ON DELETE CASCADE,
      promise_generation INTEGER NOT NULL,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state = 'ready'),
      created_at TEXT NOT NULL,
      UNIQUE (promise_id, promise_generation)
    );

    CREATE INDEX IF NOT EXISTS idx_work_promises_item_status
      ON work_promises(item_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_promises_check_in
      ON work_promises(status, expected_check_in_at);
    CREATE INDEX IF NOT EXISTS idx_promise_wakeups_state_created
      ON promise_wakeups(state, created_at ASC);
  `);
  initializedStores.add(store);
}

function applyAutomaticStatus(
  store: StensiblyStore,
  current: PromiseRow,
  nextStatus: "satisfied" | "missed",
  now: string,
  reason: string,
): WorkPromise | null {
  const nextGeneration = current.generation + 1;
  const result = store.db
    .query(`
      UPDATE work_promises
      SET status = ?1,
          generation = ?2,
          resolution_actor_id = NULL,
          resolution_note = ?3,
          resolved_at = ?4,
          updated_at = ?4
      WHERE id = ?5 AND status = 'pending' AND generation = ?6
    `)
    .run(nextStatus, nextGeneration, reason, now, current.id, current.generation);
  if (result.changes !== 1) return null;

  appendPromiseEvent(store, {
    itemId: current.item_id,
    actorId: null,
    type: `promise.${nextStatus}`,
    payload: {
      promiseId: current.id,
      fromStatus: current.status,
      toStatus: nextStatus,
      generation: nextGeneration,
      reason,
    },
    now,
  });
  if (nextStatus === "satisfied") {
    ensureWakeup(store, current.id, nextGeneration, current.item_id, now);
  }
  touchItem(store, current.item_id, now);
  return mapPromise(getPromiseRow(store, current.id));
}

function isWakeDue(store: StensiblyStore, promise: PromiseRow, now: Date): boolean {
  const wake = parseWakeCondition(promise.wake_json);
  if (wake.kind === "manual") return false;
  if (wake.kind === "at_time") return Date.parse(wake.at) <= now.getTime();
  if (wake.kind === "item_status") {
    try {
      return store.getItem(wake.itemId).status === wake.status;
    } catch (cause) {
      if (cause instanceof NotFoundError) return false;
      throw cause;
    }
  }
  const event = store.db
    .query<{ created_at: string }, [string, string]>(`
      SELECT created_at
      FROM events
      WHERE item_id = ?1 AND type = ?2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `)
    .get(promise.item_id, wake.eventType);
  if (!event) return false;
  return Date.parse(event.created_at) + wake.delaySeconds * 1000 <= now.getTime();
}

function ensureWakeup(
  store: StensiblyStore,
  promiseId: string,
  generation: number,
  itemId: string,
  now: string,
): void {
  store.db
    .query(`
      INSERT OR IGNORE INTO promise_wakeups (
        id, promise_id, promise_generation, item_id, state, created_at
      ) VALUES (?1, ?2, ?3, ?4, 'ready', ?5)
    `)
    .run(`wake_${randomUUID()}`, promiseId, generation, itemId, now);
}

function getWakeupForGeneration(
  store: StensiblyStore,
  promiseId: string,
  generation: number,
): WakeupRow | null {
  return store.db
    .query<WakeupRow, [string, number]>(
      "SELECT * FROM promise_wakeups WHERE promise_id = ?1 AND promise_generation = ?2",
    )
    .get(promiseId, generation);
}

function replayCommand(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  promiseId: string,
  command: string,
  requestJson: string,
): WorkPromise | null {
  if (!idempotencyKey) return null;
  const existing = store.db
    .query<CommandRow, [string]>(
      "SELECT promise_id, command, request_json, result_json FROM promise_commands WHERE idempotency_key = ?1",
    )
    .get(idempotencyKey);
  if (!existing) return null;
  if (
    existing.promise_id !== promiseId ||
    existing.command !== command ||
    existing.request_json !== requestJson
  ) {
    throw new ConflictError("Idempotency key was already used for a different promise command");
  }
  return JSON.parse(existing.result_json) as WorkPromise;
}

function storeCommandReplay(
  store: StensiblyStore,
  idempotencyKey: string | undefined,
  promiseId: string,
  command: string,
  requestJson: string,
  result: WorkPromise,
  now: string,
): void {
  if (!idempotencyKey) return;
  store.db
    .query(`
      INSERT INTO promise_commands (
        idempotency_key, promise_id, command, request_json, result_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `)
    .run(idempotencyKey, promiseId, command, requestJson, JSON.stringify(result), now);
}

function getPromiseRow(store: StensiblyStore, id: string): PromiseRow {
  const row = store.db.query<PromiseRow, [string]>("SELECT * FROM work_promises WHERE id = ?1").get(id);
  if (!row) throw new NotFoundError(`Promise ${id} does not exist`);
  return row;
}

function appendPromiseEvent(
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
      `event_${randomUUID()}`,
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

function normalizeCreateInput(raw: CreateWorkPromiseInput): Required<Omit<CreateWorkPromiseInput, "runnerProfile" | "question" | "evidence" | "idempotencyKey">> & {
  runnerProfile?: string;
  question?: string;
  evidence: PromiseEvidence[];
  idempotencyKey?: string;
} {
  const runnerProfile = optionalText(raw.runnerProfile, "Runner profile", 120);
  const question = optionalText(raw.question, "Promise question", 2_000);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    itemId: requiredText(raw.itemId, "Item ID", 240),
    actor: actorSchema.parse(raw.actor),
    ...(runnerProfile ? { runnerProfile } : {}),
    action: requiredText(raw.action, "Promised action", 5_000),
    ...(question ? { question } : {}),
    wakeCondition: normalizeWakeCondition(raw.wakeCondition),
    expectedCheckInAt: isoText(raw.expectedCheckInAt, "Expected check-in time"),
    evidence: normalizeEvidence(raw.evidence),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function normalizeHeartbeatInput(raw: HeartbeatWorkPromiseInput): HeartbeatWorkPromiseInput & { evidence: PromiseEvidence[] } {
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    id: requiredText(raw.id, "Promise ID", 240),
    actor: actorSchema.parse(raw.actor),
    expectedGeneration: generation(raw.expectedGeneration),
    nextCheckInAt: isoText(raw.nextCheckInAt, "Next check-in time"),
    evidence: normalizeEvidence(raw.evidence),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function normalizeResolveInput(raw: ResolveWorkPromiseInput): ResolveWorkPromiseInput & { evidence: PromiseEvidence[] } {
  const note = optionalText(raw.note, "Resolution note", 2_000);
  const idempotencyKey = optionalText(raw.idempotencyKey, "Idempotency key", 240);
  return {
    id: requiredText(raw.id, "Promise ID", 240),
    actor: actorSchema.parse(raw.actor),
    command: enumValue(raw.command, promiseCommands, "Promise command"),
    expectedGeneration: generation(raw.expectedGeneration),
    ...(note ? { note } : {}),
    evidence: normalizeEvidence(raw.evidence),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function normalizeWakeCondition(raw: PromiseWakeCondition): PromiseWakeCondition {
  if (!raw || typeof raw !== "object") throw new TypeError("Wake condition is required");
  if (raw.kind === "manual") return { kind: "manual" };
  if (raw.kind === "at_time") return { kind: "at_time", at: isoText(raw.at, "Wake time") };
  if (raw.kind === "after_event") {
    const delay = Number(raw.delaySeconds);
    if (!Number.isInteger(delay) || delay < 0 || delay > 31_536_000) {
      throw new TypeError("Wake delay must be a whole number from 0 to 31536000 seconds");
    }
    return {
      kind: "after_event",
      eventType: eventType(raw.eventType),
      delaySeconds: delay,
    };
  }
  if (raw.kind === "item_status") {
    return {
      kind: "item_status",
      itemId: requiredText(raw.itemId, "Wake item ID", 240),
      status: enumValue(raw.status, itemStatuses, "Wake item status"),
    };
  }
  throw new TypeError("Wake condition kind is unsupported");
}

function normalizeEvidence(raw: PromiseEvidence[] | undefined): PromiseEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new TypeError("Promise evidence may contain at most 20 entries");
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") throw new TypeError("Promise evidence entries must be objects");
    const uri = optionalText(entry.uri, "Evidence URI", 2_000);
    const note = optionalText(entry.note, "Evidence note", 2_000);
    return {
      kind: requiredText(entry.kind, "Evidence kind", 80),
      label: requiredText(entry.label, "Evidence label", 240),
      ...(uri ? { uri } : {}),
      ...(note ? { note } : {}),
    };
  });
}

function mergeEvidence(current: PromiseEvidence[], additions: PromiseEvidence[]): PromiseEvidence[] {
  const merged = [...current, ...additions];
  return merged.length <= 100 ? merged : merged.slice(merged.length - 100);
}

function createRequest(input: ReturnType<typeof normalizeCreateInput>) {
  return {
    itemId: input.itemId,
    actor: input.actor,
    runnerProfile: input.runnerProfile ?? null,
    action: input.action,
    question: input.question ?? null,
    wakeCondition: input.wakeCondition,
    expectedCheckInAt: input.expectedCheckInAt,
    evidence: input.evidence,
  };
}

function heartbeatRequest(input: ReturnType<typeof normalizeHeartbeatInput>) {
  return {
    id: input.id,
    actor: input.actor,
    expectedGeneration: input.expectedGeneration,
    nextCheckInAt: input.nextCheckInAt,
    evidence: input.evidence,
  };
}

function resolveRequest(input: ReturnType<typeof normalizeResolveInput>) {
  return {
    id: input.id,
    actor: input.actor,
    command: input.command,
    expectedGeneration: input.expectedGeneration,
    note: input.note ?? null,
    evidence: input.evidence,
  };
}

function mapPromise(row: PromiseRow): WorkPromise {
  return {
    id: row.id,
    itemId: row.item_id,
    responsibleActorId: row.responsible_actor_id,
    runnerProfile: row.runner_profile,
    action: row.action,
    question: row.question,
    wakeCondition: parseWakeCondition(row.wake_json),
    status: row.status,
    generation: row.generation,
    expectedCheckInAt: row.expected_check_in_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    evidence: parseEvidence(row.evidence_json),
    resolutionActorId: row.resolution_actor_id,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapWakeup(row: WakeupRow): PromiseWakeup {
  return {
    id: row.id,
    promiseId: row.promise_id,
    promiseGeneration: row.promise_generation,
    itemId: row.item_id,
    state: row.state,
    createdAt: row.created_at,
  };
}

function parseWakeCondition(json: string): PromiseWakeCondition {
  return normalizeWakeCondition(JSON.parse(json) as PromiseWakeCondition);
}

function parseEvidence(json: string): PromiseEvidence[] {
  return normalizeEvidence(JSON.parse(json) as PromiseEvidence[]);
}

function generation(value: unknown): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < 1) throw new TypeError("Expected generation must be a positive integer");
  return output;
}

function eventType(value: unknown): string {
  const output = requiredText(value, "Wake event type", 120);
  if (!/^[a-z0-9._-]+$/.test(output)) throw new TypeError("Wake event type is invalid");
  return output;
}

function isoText(value: unknown, label: string): string {
  const output = requiredText(value, label, 120);
  const parsed = Date.parse(output);
  if (Number.isNaN(parsed)) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
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

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Values[number];
}

function generationConflict(expected: number, actual: number): ConflictError {
  return new ConflictError(`Promise generation changed from ${expected} to ${actual}`);
}
