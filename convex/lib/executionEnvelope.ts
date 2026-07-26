import { v } from "convex/values";
import {
  EXECUTION_ENVELOPE_SCHEMA_VERSION,
  parseExecutionActual,
  parseExecutionEnvelope,
  type ExecutionActual,
  type ExecutionEnvelope,
} from "../../src/execution-envelope";
import { compatibilityExecutionEnvelope } from "../../src/execution-envelope-default";
import { MAX_EXECUTION_RECORDS_PER_RUN } from "../../src/execution-record-limits";
import { appendEvent } from "./domain";

const EXECUTION_ENVELOPE_EVENT_PREFIX = "run.execution_envelope:";
const EXECUTION_ACTUAL_EVENT_PREFIX = "run.execution_actual:";
const EXECUTION_ENVELOPE_EVENT_UPPER_BOUND = "run.execution_envelope;";
const EXECUTION_ACTUAL_EVENT_UPPER_BOUND = "run.execution_actual;";

export const executionEnvelopeValidator = v.object({
  schemaVersion: v.literal(EXECUTION_ENVELOPE_SCHEMA_VERSION),
  objective: v.string(),
  scopeClass: v.union(
    v.literal("atomic"),
    v.literal("segmented"),
    v.literal("exploratory"),
    v.literal("long-running"),
    v.literal("portfolio"),
    v.literal("review"),
  ),
  estimate: v.object({
    lowMinutes: v.number(),
    likelyMinutes: v.number(),
    highMinutes: v.number(),
    confidence: v.number(),
  }),
  budget: v.object({
    expectedMessages: v.number(),
    expectedToolCalls: v.number(),
    expectedReviewMinutes: v.number(),
  }),
  boundaries: v.object({
    softCheckpointMinutes: v.number(),
    forcedHandoffMinutes: v.number(),
    hardRecoveryMinutes: v.number(),
  }),
  completion: v.object({
    requiredOutputs: v.array(v.string()),
    verificationRequired: v.boolean(),
    continuationStateRequired: v.boolean(),
    acceptanceChecks: v.array(v.string()),
  }),
  durableState: v.object({
    accessClass: v.union(
      v.literal("private"),
      v.literal("project"),
      v.literal("workspace"),
    ),
    retentionClass: v.union(
      v.literal("ephemeral"),
      v.literal("standard"),
      v.literal("extended"),
      v.literal("indefinite"),
    ),
    redactionRequired: v.boolean(),
    deleteAfter: v.union(v.string(), v.null()),
  }),
});

export const executionActualValidator = v.object({
  durationMinutes: v.optional(v.number()),
  messagesConsumed: v.optional(v.number()),
  toolCalls: v.optional(v.number()),
  filesChanged: v.optional(v.number()),
  reviewMinutes: v.optional(v.number()),
  estimateErrorReasons: v.optional(v.array(v.string())),
});

export interface HostedExecutionRecord {
  id: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  transition: string;
  actual: ExecutionActual;
  createdAt: string;
}

interface HostedEnvelopeRecord {
  envelope: ExecutionEnvelope;
  runGeneration: number;
  leaseGeneration: number;
}

export function normalizeExecutionEnvelope(
  value: unknown,
  fallbackObjective: string,
): ExecutionEnvelope {
  return parseExecutionEnvelope(
    value ?? compatibilityExecutionEnvelope(fallbackObjective),
  );
}

export function normalizeExecutionActual(value: unknown): ExecutionActual {
  return parseExecutionActual(value);
}

export function isPrivateExecutionEventType(value: unknown): boolean {
  return typeof value === "string" && (
    value.startsWith(EXECUTION_ENVELOPE_EVENT_PREFIX)
    || value.startsWith(EXECUTION_ACTUAL_EVENT_PREFIX)
  );
}

export function publicExecutionEventFilter(q: any): any {
  const type = q.field("type");
  return q.and(
    q.or(
      q.lt(type, EXECUTION_ENVELOPE_EVENT_PREFIX),
      q.gte(type, EXECUTION_ENVELOPE_EVENT_UPPER_BOUND),
    ),
    q.or(
      q.lt(type, EXECUTION_ACTUAL_EVENT_PREFIX),
      q.gte(type, EXECUTION_ACTUAL_EVENT_UPPER_BOUND),
    ),
  );
}

export async function appendExecutionEnvelopeEvent(
  ctx: any,
  input: {
    workspaceId: any;
    projectId: any;
    itemId: any;
    actorId?: any;
    actorExternalId?: string;
    runId: string;
    runGeneration: number;
    leaseGeneration: number;
    envelope: ExecutionEnvelope;
    createdAt: number;
  },
): Promise<void> {
  const runId = boundedRunId(input.runId);
  const runGeneration = positiveInteger(input.runGeneration, "Run generation");
  const leaseGeneration = positiveInteger(input.leaseGeneration, "Lease generation");
  const envelope = parseExecutionEnvelope(input.envelope);
  const createdAt = validTimestamp(input.createdAt, "Execution envelope creation time");
  await appendEvent(ctx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    itemId: input.itemId,
    actorId: input.actorId,
    actorExternalId: input.actorExternalId,
    type: executionEnvelopeEventType(runId),
    payload: {
      runId,
      generation: runGeneration,
      leaseGeneration,
      envelopeSchemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
      envelope,
    },
    createdAt,
  });
  await appendEvent(ctx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    itemId: input.itemId,
    actorId: input.actorId,
    actorExternalId: input.actorExternalId,
    type: "run.envelope_reference",
    payload: {
      runId,
      generation: runGeneration,
      leaseGeneration,
      envelopeSchemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
      lifecycleEventType: "run.created",
      lifecycleEventCreatedAt: createdAt,
    },
    idempotencyKey: `run-envelope-ref:${runId}:${runGeneration}:${leaseGeneration}`,
    createdAt,
  });
}

export async function appendExecutionActualEvent(
  ctx: any,
  input: {
    workspaceId: any;
    projectId: any;
    itemId: any;
    actorId?: any;
    actorExternalId?: string;
    runId: string;
    runGeneration: number;
    leaseGeneration: number;
    transition: string;
    actual: ExecutionActual;
    createdAt: number;
  },
): Promise<HostedExecutionRecord> {
  const runId = boundedRunId(input.runId);
  const runGeneration = positiveInteger(input.runGeneration, "Run generation");
  const leaseGeneration = positiveInteger(input.leaseGeneration, "Lease generation");
  const transition = requiredText(input.transition, "Execution transition", 160);
  const actual = parseExecutionActual(input.actual);
  const createdAt = validTimestamp(input.createdAt, "Execution result creation time");
  const event = await appendEvent(ctx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    itemId: input.itemId,
    actorId: input.actorId,
    actorExternalId: input.actorExternalId,
    type: executionActualEventType(runId),
    payload: {
      runId,
      generation: runGeneration,
      leaseGeneration,
      transition,
      actual,
    },
    createdAt,
  });
  return {
    id: event.id,
    runId,
    runGeneration,
    leaseGeneration,
    transition,
    actual,
    createdAt: new Date(createdAt).toISOString(),
  };
}

export async function readHostedRunExecution(
  ctx: any,
  itemId: any,
  rawRunId: string,
): Promise<{
  executionEnvelope: ExecutionEnvelope | null;
  executionRecords: HostedExecutionRecord[];
  runGeneration: number | null;
  leaseGeneration: number | null;
}> {
  const runId = boundedRunId(rawRunId);
  const [envelopeEvents, actualEvents] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_item_type_created", (q: any) =>
        q.eq("itemId", itemId).eq("type", executionEnvelopeEventType(runId))
      )
      .order("asc")
      .take(2),
    ctx.db
      .query("events")
      .withIndex("by_item_type_created", (q: any) =>
        q.eq("itemId", itemId).eq("type", executionActualEventType(runId))
      )
      .order("asc")
      .take(MAX_EXECUTION_RECORDS_PER_RUN + 1),
  ]);
  if (envelopeEvents.length > 1) {
    throw new Error("Run has conflicting execution-envelope history");
  }
  if (actualEvents.length > MAX_EXECUTION_RECORDS_PER_RUN) {
    throw new Error("Run execution-result history exceeds the bounded projection");
  }

  const envelopeEvent = envelopeEvents[0];
  const envelopeRecord = envelopeEvent === undefined
    ? null
    : parseEnvelopeEvent(envelopeEvent, runId);
  const executionRecords = actualEvents.map((event: any) =>
    parseActualEvent(event, runId)
  );
  validateExecutionRecordOrder(envelopeRecord, executionRecords);
  const latest = executionRecords.at(-1);
  return {
    executionEnvelope: envelopeRecord?.envelope ?? null,
    executionRecords,
    runGeneration: latest?.runGeneration ?? envelopeRecord?.runGeneration ?? null,
    leaseGeneration: latest?.leaseGeneration ?? envelopeRecord?.leaseGeneration ?? null,
  };
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function parseEnvelopeEvent(event: any, runId: string): HostedEnvelopeRecord {
  const payload = record(event?.payload);
  if (!payload || payload.runId !== runId) {
    throw new Error("Stored execution envelope does not match its run");
  }
  const runGeneration = positiveInteger(payload.generation, "Run generation");
  const leaseGeneration = positiveInteger(payload.leaseGeneration, "Lease generation");
  if (payload.envelopeSchemaVersion !== EXECUTION_ENVELOPE_SCHEMA_VERSION) {
    throw new Error("Stored execution envelope schema version is unsupported");
  }
  const envelope = parseExecutionEnvelope(payload.envelope);
  if (envelope.schemaVersion !== payload.envelopeSchemaVersion) {
    throw new Error("Stored execution envelope schema metadata is inconsistent");
  }
  validTimestamp(event.createdAt, "Stored execution envelope creation time");
  return { envelope, runGeneration, leaseGeneration };
}

function parseActualEvent(event: any, runId: string): HostedExecutionRecord {
  const payload = record(event?.payload);
  if (!payload || payload.runId !== runId) {
    throw new Error("Stored execution record does not match its run");
  }
  return {
    id: requiredText(event.externalId, "Execution record ID", 240),
    runId,
    runGeneration: positiveInteger(payload.generation, "Run generation"),
    leaseGeneration: positiveInteger(payload.leaseGeneration, "Lease generation"),
    transition: requiredText(payload.transition, "Execution transition", 160),
    actual: parseExecutionActual(payload.actual),
    createdAt: new Date(
      validTimestamp(event.createdAt, "Stored execution result creation time"),
    ).toISOString(),
  };
}

function validateExecutionRecordOrder(
  envelope: HostedEnvelopeRecord | null,
  records: HostedExecutionRecord[],
): void {
  let previousGeneration = envelope?.runGeneration ?? 0;
  let previousLeaseGeneration = envelope?.leaseGeneration ?? 0;
  for (const entry of records) {
    if (entry.runGeneration <= previousGeneration) {
      throw new Error("Stored execution-result generations are not strictly increasing");
    }
    if (entry.leaseGeneration < previousLeaseGeneration) {
      throw new Error("Stored execution-result lease generations moved backwards");
    }
    previousGeneration = entry.runGeneration;
    previousLeaseGeneration = entry.leaseGeneration;
  }
}

function executionEnvelopeEventType(runId: string): string {
  return `${EXECUTION_ENVELOPE_EVENT_PREFIX}${boundedRunId(runId)}`;
}

function executionActualEventType(runId: string): string {
  return `${EXECUTION_ACTUAL_EVENT_PREFIX}${boundedRunId(runId)}`;
}

function boundedRunId(value: string): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output || output.length > 180 || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new TypeError("Run id is invalid for execution records");
  }
  return output;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function validTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid`);
  return value;
}

function requiredText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const output = typeof value === "string" ? value.trim() : "";
  if (!output) throw new TypeError(`${label} is required`);
  if (output.length > maximum) {
    throw new TypeError(`${label} may contain at most ${maximum} characters`);
  }
  return output;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
