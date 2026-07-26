import { v } from "convex/values";
import {
  EXECUTION_ENVELOPE_SCHEMA_VERSION,
  parseExecutionActual,
  parseExecutionEnvelope,
  type ExecutionActual,
  type ExecutionEnvelope,
} from "../../src/execution-envelope";
import { compatibilityExecutionEnvelope } from "../../src/execution-envelope-default";
import { appendEvent } from "./domain";

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
  await appendEvent(ctx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    itemId: input.itemId,
    actorId: input.actorId,
    actorExternalId: input.actorExternalId,
    type: executionEnvelopeEventType(input.runId),
    payload: {
      runId: input.runId,
      generation: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      envelopeSchemaVersion: EXECUTION_ENVELOPE_SCHEMA_VERSION,
      envelope: input.envelope,
    },
    createdAt: input.createdAt,
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
): Promise<void> {
  await appendEvent(ctx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    itemId: input.itemId,
    actorId: input.actorId,
    actorExternalId: input.actorExternalId,
    type: executionActualEventType(input.runId),
    payload: {
      runId: input.runId,
      generation: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      transition: input.transition,
      actual: input.actual,
    },
    createdAt: input.createdAt,
  });
}

export async function readHostedRunExecution(
  ctx: any,
  itemId: any,
  runId: string,
): Promise<{
  executionEnvelope: ExecutionEnvelope | null;
  executionRecords: HostedExecutionRecord[];
}> {
  const [envelopeEvent, actualEvents] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_item_type_created", (q: any) =>
        q.eq("itemId", itemId).eq("type", executionEnvelopeEventType(runId))
      )
      .order("desc")
      .first(),
    ctx.db
      .query("events")
      .withIndex("by_item_type_created", (q: any) =>
        q.eq("itemId", itemId).eq("type", executionActualEventType(runId))
      )
      .order("asc")
      .take(100),
  ]);
  const envelopePayload = record(envelopeEvent?.payload);
  const executionEnvelope = envelopePayload?.envelope === undefined
    ? null
    : parseExecutionEnvelope(envelopePayload.envelope);
  const executionRecords = actualEvents.map((event: any) => {
    const payload = record(event.payload);
    if (!payload || payload.runId !== runId) {
      throw new Error("Stored execution record does not match its run");
    }
    return {
      id: event.externalId,
      runId,
      runGeneration: positiveInteger(payload.generation, "Run generation"),
      leaseGeneration: positiveInteger(payload.leaseGeneration, "Lease generation"),
      transition: requiredText(payload.transition, "Execution transition"),
      actual: parseExecutionActual(payload.actual),
      createdAt: new Date(event.createdAt).toISOString(),
    };
  });
  return { executionEnvelope, executionRecords };
}

export function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function executionEnvelopeEventType(runId: string): string {
  return `run.execution_envelope:${boundedRunId(runId)}`;
}

function executionActualEventType(runId: string): string {
  return `run.execution_actual:${boundedRunId(runId)}`;
}

function boundedRunId(value: string): string {
  const output = value.trim();
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

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required`);
  }
  return value.trim();
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
