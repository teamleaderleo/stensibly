import { randomUUID } from "node:crypto";
import type { ActorInput } from "./schemas.js";
import { ConflictError, NotFoundError, StensiblyStore } from "./store.js";

export const continuationStatuses = [
  "proposed",
  "approved",
  "rejected",
  "deferred",
  "queued",
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
  "expired",
] as const;

export const continuationApprovalModes = ["automatic", "notify", "human"] as const;
export const continuationDeliveryModes = [
  "current_conversation",
  "human_inbox",
  "supervisor",
] as const;
export const continuationCommands = [
  "approve",
  "reject",
  "defer",
  "queue",
  "start",
  "succeed",
  "fail",
  "cancel",
  "supersede",
] as const;

export type ContinuationStatus = typeof continuationStatuses[number];
export type ContinuationApprovalMode = typeof continuationApprovalModes[number];
export type ContinuationDeliveryMode = typeof continuationDeliveryModes[number];
export type ContinuationCommand = typeof continuationCommands[number];

export type ContinuationAction =
  | { kind: "create_item"; project: string }
  | { kind: "resume_item"; itemId: string }
  | { kind: "dispatch_item"; itemId: string; runnerProfile?: string }
  | { kind: "request_decision"; decisionType: string };

export interface ContinuationEvidence {
  kind: string;
  label: string;
  uri: string;
}

export interface ContinuationProposal {
  id: string;
  sourceItemId: string;
  sourceEventId: string;
  sourceRunId: string | null;
  title: string;
  rationale: string;
  instruction: string;
  action: ContinuationAction;
  evidence: ContinuationEvidence[];
  suggestedBy: string;
  approvalMode: ContinuationApprovalMode;
  deliveryMode: ContinuationDeliveryMode;
  status: ContinuationStatus;
  generation: number;
  expiresAt: string | null;
  resolutionActorId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeContinuationInput {
  sourceItemId: string;
  sourceRunId?: string;
  title: string;
  rationale: string;
  instruction: string;
  action: ContinuationAction;
  evidence?: ContinuationEvidence[];
  actor: ActorInput;
  approvalMode?: ContinuationApprovalMode;
  deliveryMode?: ContinuationDeliveryMode;
  expiresAt?: string;
  idempotencyKey?: string;
}

export interface ResolveContinuationInput {
  id: string;
  actor: ActorInput;
  command: ContinuationCommand;
  expectedGeneration: number;
  note?: string;
  idempotencyKey?: string;
}

export interface ListContinuationsInput {
  sourceItemId?: string;
  status?: ContinuationStatus;
  deliveryMode?: ContinuationDeliveryMode;
}

interface ContinuationRow {
  id: string;
  source_item_id: string;
  source_event_id: string;
  source_run_id: string | null;
  title: string;
  rationale: string;
  instruction: string;
  action_json: string;
  evidence_json: string;
  suggested_by: string;
  approval_mode: ContinuationApprovalMode;
  delivery_mode: ContinuationDeliveryMode;
  status: ContinuationStatus;
  generation: number;
  expires_at: string | null;
  resolution_actor_id: string | null;
  resolution_note: string | null;
  request_json: string;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

interface CommandRow {
  continuation_id: string;
  command: ContinuationCommand;
  request_json: string;
  result_json: string;
}

const initializedStores = new WeakSet<StensiblyStore>();
const liveExpirableStatuses: ContinuationStatus[] = [
  "proposed",
  "deferred",
  "approved",
  "queued",
];

const transitions: Record<ContinuationCommand, Partial<Record<ContinuationStatus, ContinuationStatus>>> = {
  approve: { proposed: "approved", deferred: "approved" },
  reject: { proposed: "rejected", deferred: "rejected" },
  defer: { proposed: "deferred" },
  queue: { approved: "queued" },
  start: { approved: "started", queued: "started" },
  succeed: { started: "succeeded" },
  fail: { queued: "failed", started: "failed" },
  cancel: {
    proposed: "cancelled",
    deferred: "cancelled",
    approved: "cancelled",
    queued: "cancelled",
  },
  supersede: {
    proposed: "superseded",
    deferred: "superseded",
    approved: "superseded",
    queued: "superseded",
  },
};

export function proposeContinuation(
  store: StensiblyStore,
  rawInput: ProposeContinuationInput,
): ContinuationProposal {
  ensureContinuationSchema(store);
  const input = normalizeProposalInput(rawInput);
  const requestJson = JSON.stringify(proposalRequest(input));

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = store.db
        .query<ContinuationRow, [string]>(
          "SELECT * FROM continuations WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey);
      if (existing) {
        if (existing.request_json !== requestJson) {
          throw new ConflictError(
            "Idempotency key was already used for a different continuation proposal",
          );
        }
        return existing;
      }
    }

    store.getItem(input.sourceItemId);
    const now = new Date().toISOString();
    upsertActor(store, input.actor, now);
    const id = `cont_${randomUUID()}`;
    const eventId = appendContinuationEvent(store, {
      itemId: input.sourceItemId,
      actorId: input.actor.id,
      type: "continuation.proposed",
      payload: {
        continuationId: id,
        title: input.title,
        actionKind: input.action.kind,
        approvalMode: input.approvalMode,
        deliveryMode: input.deliveryMode,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
      now,
    });

    store.db
      .query(`
        INSERT INTO continuations (
          id, source_item_id, source_event_id, source_run_id,
          title, rationale, instruction, action_json, evidence_json,
          suggested_by, approval_mode, delivery_mode, status, generation,
          expires_at, request_json, idempotency_key, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4,
          ?5, ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, 'proposed', 1,
          ?13, ?14, ?15, ?16, ?16
        )
      `)
      .run(
        id,
        input.sourceItemId,
        eventId,
        input.sourceRunId ?? null,
        input.title,
        input.rationale,
        input.instruction,
        JSON.stringify(input.action),
        JSON.stringify(input.evidence),
        input.actor.id,
        input.approvalMode,
        input.deliveryMode,
        input.expiresAt ?? null,
        requestJson,
        input.idempotencyKey ?? null,
        now,
      );

    touchItem(store, input.sourceItemId, now);
    return getContinuationRow(store, id);
  });

  return mapContinuation(transaction());
}

export function getContinuation(
  store: StensiblyStore,
  id: string,
): ContinuationProposal {
  ensureContinuationSchema(store);
  expireContinuations(store);
  return mapContinuation(getContinuationRow(store, requiredText(id, "Continuation ID", 240)));
}

export function listContinuations(
  store: StensiblyStore,
  input: ListContinuationsInput = {},
): ContinuationProposal[] {
  ensureContinuationSchema(store);
  expireContinuations(store);
  const sourceItemId = input.sourceItemId
    ? requiredText(input.sourceItemId, "Source item ID", 240)
    : null;
  const status = input.status ? enumValue(input.status, continuationStatuses, "Continuation status") : null;
  const deliveryMode = input.deliveryMode
    ? enumValue(input.deliveryMode, continuationDeliveryModes, "Delivery mode")
    : null;
  const rows = store.db
    .query<ContinuationRow, [string | null, string | null, string | null]>(`
      SELECT *
      FROM continuations
      WHERE (?1 IS NULL OR source_item_id = ?1)
        AND (?2 IS NULL OR status = ?2)
        AND (?3 IS NULL OR delivery_mode = ?3)
      ORDER BY created_at DESC, id DESC
    `)
    .all(sourceItemId, status, deliveryMode);
  return rows.map(mapContinuation);
}

export function resolveContinuation(
  store: StensiblyStore,
  rawInput: ResolveContinuationInput,
): ContinuationProposal {
  ensureContinuationSchema(store);
  const input = normalizeResolutionInput(rawInput);
  const requestJson = JSON.stringify(resolutionRequest(input));

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existing = store.db
        .query<CommandRow, [string]>(
          "SELECT continuation_id, command, request_json, result_json FROM continuation_commands WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey);
      if (existing) {
        if (
          existing.continuation_id !== input.id ||
          existing.command !== input.command ||
          existing.request_json !== requestJson
        ) {
          throw new ConflictError(
            "Idempotency key was already used for a different continuation command",
          );
        }
        return JSON.parse(existing.result_json) as ContinuationProposal;
      }
    }

    expireContinuationInTransaction(store, input.id);
    const current = getContinuationRow(store, input.id);
    if (current.generation !== input.expectedGeneration) {
      throw new ConflictError(
        `Continuation generation changed from ${input.expectedGeneration} to ${current.generation}`,
      );
    }
    const nextStatus = transitions[input.command][current.status];
    if (!nextStatus) {
      throw new ConflictError(
        `Continuation cannot ${input.command} while ${current.status}`,
      );
    }

    const now = new Date().toISOString();
    upsertActor(store, input.actor, now);
    const nextGeneration = current.generation + 1;
    const result = store.db
      .query(`
        UPDATE continuations
        SET status = ?1,
            generation = ?2,
            resolution_actor_id = ?3,
            resolution_note = ?4,
            updated_at = ?5
        WHERE id = ?6 AND generation = ?7 AND status = ?8
      `)
      .run(
        nextStatus,
        nextGeneration,
        input.actor.id,
        input.note ?? null,
        now,
        input.id,
        input.expectedGeneration,
        current.status,
      );
    if (result.changes !== 1) {
      throw new ConflictError("Continuation changed while the command was being applied");
    }

    appendContinuationEvent(store, {
      itemId: current.source_item_id,
      actorId: input.actor.id,
      type: `continuation.${nextStatus}`,
      payload: {
        continuationId: input.id,
        command: input.command,
        fromStatus: current.status,
        toStatus: nextStatus,
        generation: nextGeneration,
        ...(input.note ? { note: input.note } : {}),
      },
      now,
    });
    touchItem(store, current.source_item_id, now);

    const updated = mapContinuation(getContinuationRow(store, input.id));
    if (input.idempotencyKey) {
      store.db
        .query(`
          INSERT INTO continuation_commands (
            idempotency_key, continuation_id, command, request_json, result_json, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        `)
        .run(
          input.idempotencyKey,
          input.id,
          input.command,
          requestJson,
          JSON.stringify(updated),
          now,
        );
    }
    return updated;
  });

  return transaction();
}

export function ensureContinuationSchema(store: StensiblyStore): void {
  if (initializedStores.has(store)) return;
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS continuations (
      id TEXT PRIMARY KEY,
      source_item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL,
      source_run_id TEXT,
      title TEXT NOT NULL,
      rationale TEXT NOT NULL,
      instruction TEXT NOT NULL,
      action_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      suggested_by TEXT NOT NULL REFERENCES actors(id),
      approval_mode TEXT NOT NULL CHECK (approval_mode IN ('automatic', 'notify', 'human')),
      delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('current_conversation', 'human_inbox', 'supervisor')),
      status TEXT NOT NULL CHECK (status IN (
        'proposed', 'approved', 'rejected', 'deferred', 'queued', 'started',
        'succeeded', 'failed', 'cancelled', 'superseded', 'expired'
      )),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      expires_at TEXT,
      resolution_actor_id TEXT REFERENCES actors(id),
      resolution_note TEXT,
      request_json TEXT NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS continuation_commands (
      idempotency_key TEXT PRIMARY KEY,
      continuation_id TEXT NOT NULL REFERENCES continuations(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_continuations_source_status
      ON continuations(source_item_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_continuations_delivery_status
      ON continuations(delivery_mode, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_continuations_expiry
      ON continuations(expires_at)
      WHERE status IN ('proposed', 'deferred', 'approved', 'queued');
  `);
  initializedStores.add(store);
}

function expireContinuations(store: StensiblyStore): void {
  const rows = store.db
    .query<{ id: string }, [string]>(`
      SELECT id FROM continuations
      WHERE status IN ('proposed', 'deferred', 'approved', 'queued')
        AND expires_at IS NOT NULL
        AND expires_at <= ?1
      ORDER BY expires_at ASC
    `)
    .all(new Date().toISOString());
  for (const row of rows) expireContinuationIfNeeded(store, row.id);
}

function expireContinuationIfNeeded(
  store: StensiblyStore,
  id: string,
): ContinuationRow {
  const transaction = store.db.transaction(() =>
    expireContinuationInTransaction(store, id)
  );
  return transaction();
}

function expireContinuationInTransaction(
  store: StensiblyStore,
  id: string,
): ContinuationRow {
  const fresh = getContinuationRow(store, id);
  const now = new Date().toISOString();
  if (
    !fresh.expires_at ||
    !liveExpirableStatuses.includes(fresh.status) ||
    fresh.expires_at > now
  ) {
    return fresh;
  }
  const nextGeneration = fresh.generation + 1;
  const result = store.db
    .query(`
      UPDATE continuations
      SET status = 'expired', generation = ?1, updated_at = ?2
      WHERE id = ?3 AND generation = ?4 AND status = ?5
    `)
    .run(nextGeneration, now, id, fresh.generation, fresh.status);
  if (result.changes !== 1) return getContinuationRow(store, id);

  appendContinuationEvent(store, {
    itemId: fresh.source_item_id,
    actorId: null,
    type: "continuation.expired",
    payload: {
      continuationId: id,
      fromStatus: fresh.status,
      toStatus: "expired",
      generation: nextGeneration,
    },
    now,
  });
  touchItem(store, fresh.source_item_id, now);
  return getContinuationRow(store, id);
}

function getContinuationRow(store: StensiblyStore, id: string): ContinuationRow {
  const row = store.db
    .query<ContinuationRow, [string]>("SELECT * FROM continuations WHERE id = ?1")
    .get(id);
  if (!row) throw new NotFoundError(`Continuation ${id} does not exist`);
  return row;
}

function normalizeProposalInput(input: ProposeContinuationInput) {
  const actor = normalizeActor(input.actor);
  const expiresAt = input.expiresAt
    ? validTimestamp(input.expiresAt, "Continuation expiry")
    : undefined;
  return {
    sourceItemId: requiredText(input.sourceItemId, "Source item ID", 240),
    sourceRunId: optionalText(input.sourceRunId, "Source run ID", 240),
    title: requiredText(input.title, "Title", 240),
    rationale: requiredText(input.rationale, "Rationale", 10_000),
    instruction: requiredText(input.instruction, "Instruction", 10_000),
    action: normalizeAction(input.action),
    evidence: normalizeEvidence(input.evidence ?? []),
    actor,
    approvalMode: enumValue(
      input.approvalMode ?? "human",
      continuationApprovalModes,
      "Approval mode",
    ),
    deliveryMode: enumValue(
      input.deliveryMode ?? "human_inbox",
      continuationDeliveryModes,
      "Delivery mode",
    ),
    expiresAt,
    idempotencyKey: optionalText(input.idempotencyKey, "Idempotency key", 240),
  };
}

function normalizeResolutionInput(input: ResolveContinuationInput) {
  const generation = Number(input.expectedGeneration);
  if (!Number.isInteger(generation) || generation < 1) {
    throw new TypeError("Expected generation must be a positive integer");
  }
  return {
    id: requiredText(input.id, "Continuation ID", 240),
    actor: normalizeActor(input.actor),
    command: enumValue(input.command, continuationCommands, "Continuation command"),
    expectedGeneration: generation,
    note: optionalText(input.note, "Resolution note", 10_000),
    idempotencyKey: optionalText(input.idempotencyKey, "Idempotency key", 240),
  };
}

function normalizeActor(actor: ActorInput): ActorInput {
  if (!actor || typeof actor !== "object") throw new TypeError("Actor is required");
  const kind = enumValue(actor.kind, ["human", "agent", "service"] as const, "Actor kind");
  return {
    id: requiredText(actor.id, "Actor ID", 120),
    name: requiredText(actor.name, "Actor name", 160),
    kind,
  };
}

function normalizeAction(action: ContinuationAction): ContinuationAction {
  if (!action || typeof action !== "object") throw new TypeError("Continuation action is required");
  if (action.kind === "create_item") {
    const project = requiredText(action.project, "Action project", 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(project)) {
      throw new TypeError("Action project must be a lowercase slug");
    }
    return { kind: action.kind, project };
  }
  if (action.kind === "resume_item") {
    return { kind: action.kind, itemId: requiredText(action.itemId, "Action item ID", 240) };
  }
  if (action.kind === "dispatch_item") {
    return {
      kind: action.kind,
      itemId: requiredText(action.itemId, "Action item ID", 240),
      ...(action.runnerProfile
        ? { runnerProfile: requiredText(action.runnerProfile, "Runner profile", 240) }
        : {}),
    };
  }
  if (action.kind === "request_decision") {
    return {
      kind: action.kind,
      decisionType: requiredText(action.decisionType, "Decision type", 120),
    };
  }
  throw new TypeError("Unknown continuation action kind");
}

function normalizeEvidence(evidence: ContinuationEvidence[]): ContinuationEvidence[] {
  if (!Array.isArray(evidence)) throw new TypeError("Evidence must be an array");
  if (evidence.length > 50) throw new TypeError("Evidence may contain at most 50 references");
  return evidence.map((entry) => {
    if (!entry || typeof entry !== "object") throw new TypeError("Evidence entries must be objects");
    return {
      kind: requiredText(entry.kind, "Evidence kind", 80),
      label: requiredText(entry.label, "Evidence label", 240),
      uri: requiredText(entry.uri, "Evidence URI", 4096),
    };
  });
}

function proposalRequest(input: ReturnType<typeof normalizeProposalInput>) {
  return {
    sourceItemId: input.sourceItemId,
    sourceRunId: input.sourceRunId ?? null,
    title: input.title,
    rationale: input.rationale,
    instruction: input.instruction,
    action: input.action,
    evidence: input.evidence,
    actor: input.actor,
    approvalMode: input.approvalMode,
    deliveryMode: input.deliveryMode,
    expiresAt: input.expiresAt ?? null,
  };
}

function resolutionRequest(input: ReturnType<typeof normalizeResolutionInput>) {
  return {
    id: input.id,
    actor: input.actor,
    command: input.command,
    expectedGeneration: input.expectedGeneration,
    note: input.note ?? null,
  };
}

function upsertActor(store: StensiblyStore, actor: ActorInput, now: string): void {
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
}

function appendContinuationEvent(
  store: StensiblyStore,
  input: {
    itemId: string;
    actorId: string | null;
    type: string;
    payload: Record<string, unknown>;
    now: string;
  },
): string {
  const id = `evt_${randomUUID()}`;
  store.db
    .query(`
      INSERT INTO events (
        id, item_id, actor_id, type, payload_json, idempotency_key, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
    `)
    .run(
      id,
      input.itemId,
      input.actorId,
      input.type,
      JSON.stringify(input.payload),
      input.now,
    );
  return id;
}

function touchItem(store: StensiblyStore, itemId: string, now: string): void {
  store.db
    .query(`
      UPDATE items
      SET version = version + 1, updated_at = ?1
      WHERE id = ?2
    `)
    .run(now, itemId);
}

function mapContinuation(row: ContinuationRow): ContinuationProposal {
  return {
    id: row.id,
    sourceItemId: row.source_item_id,
    sourceEventId: row.source_event_id,
    sourceRunId: row.source_run_id,
    title: row.title,
    rationale: row.rationale,
    instruction: row.instruction,
    action: JSON.parse(row.action_json) as ContinuationAction,
    evidence: JSON.parse(row.evidence_json) as ContinuationEvidence[],
    suggestedBy: row.suggested_by,
    approvalMode: row.approval_mode,
    deliveryMode: row.delivery_mode,
    status: row.status,
    generation: row.generation,
    expiresAt: row.expires_at,
    resolutionActorId: row.resolution_actor_id,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maxLength) throw new TypeError(`${label} may contain at most ${maxLength} characters`);
  if (/stn\.tok_/i.test(output)) throw new TypeError(`${label} cannot contain credential-shaped text`);
  return output;
}

function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, label, maxLength);
}

function validTimestamp(value: unknown, label: string): string {
  const output = requiredText(value, label, 120);
  const parsed = Date.parse(output);
  if (Number.isNaN(parsed)) throw new TypeError(`${label} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new TypeError(`${label} must be one of: ${values.join(", ")}`);
  }
  return value as T[number];
}
