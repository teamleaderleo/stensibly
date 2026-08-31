import { z } from "zod";
import { artifactKinds } from "./artifacts.js";
import { runStatuses } from "./run-statuses.js";
import { itemKinds, itemStatuses } from "./schemas.js";

const jsonRecordSchema = z.record(z.string(), z.unknown());
const nullableStringSchema = z.string().nullable();

const itemSchema = z.object({
  id: z.string(),
  project: z.string(),
  kind: z.enum(itemKinds),
  title: z.string(),
  summary: nullableStringSchema,
  status: z.enum(itemStatuses),
  priority: z.number(),
  nextAction: nullableStringSchema,
  claimedBy: nullableStringSchema,
  claimExpiresAt: nullableStringSchema,
  claimGeneration: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const artifactSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  actorId: z.string(),
  kind: z.enum(artifactKinds),
  label: z.string(),
  uri: z.string(),
  mimeType: nullableStringSchema,
  metadata: jsonRecordSchema,
  createdAt: z.string(),
});

const briefItemSchema = itemSchema.pick({
  id: true,
  kind: true,
  title: true,
  status: true,
  priority: true,
  summary: true,
  nextAction: true,
  claimedBy: true,
  claimExpiresAt: true,
  updatedAt: true,
});

const briefArtifactSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  itemTitle: z.string(),
  actorId: z.string(),
  kind: z.enum(artifactKinds),
  label: z.string(),
  uri: z.string(),
  createdAt: z.string(),
});

const projectBriefSchema = z.object({
  project: z.string(),
  generatedAt: z.string(),
  counts: z.object({
    total: z.number().int(),
    byStatus: z.object(Object.fromEntries(
      itemStatuses.map((status) => [status, z.number().int()]),
    ) as Record<(typeof itemStatuses)[number], z.ZodNumber>),
    byKind: z.object(Object.fromEntries(
      itemKinds.map((kind) => [kind, z.number().int()]),
    ) as Record<(typeof itemKinds)[number], z.ZodNumber>),
  }),
  ready: z.array(briefItemSchema),
  active: z.array(briefItemSchema),
  blocked: z.array(briefItemSchema),
  knowledge: z.array(briefItemSchema),
  recentlyCompleted: z.array(briefItemSchema),
  recentArtifacts: z.array(briefArtifactSchema),
});

const workRunSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  actorId: z.string(),
  runnerType: z.string(),
  runnerProfile: z.string(),
  externalRunId: nullableStringSchema,
  status: z.enum(runStatuses),
  generation: z.number().int(),
  leaseGeneration: z.number().int(),
  leaseOwnerId: nullableStringSchema,
  leaseExpiresAt: nullableStringSchema,
  lastHeartbeatAt: nullableStringSchema,
  checkpoint: nullableStringSchema,
  outcome: nullableStringSchema,
  continuationRef: nullableStringSchema,
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    toolCalls: z.number().optional(),
    childAgents: z.number().optional(),
  }),
  retryAttempt: z.number().int(),
  maxAttempts: z.number().int(),
  retryBackoffSeconds: z.number().int(),
  nextRetryAt: nullableStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: nullableStringSchema,
  endedAt: nullableStringSchema,
});

const dispatchResultSchema = z.object({
  status: z.literal("dispatched"),
  replay: z.boolean(),
  expectedClaimGeneration: z.number().int(),
  claimedGeneration: z.number().int(),
  item: itemSchema,
  run: workRunSchema,
});

const runnerContextSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  packetFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  item: itemSchema,
  intent: z.object({
    objective: z.string(),
    summary: nullableStringSchema,
    nextAction: nullableStringSchema,
  }),
  events: z.array(z.object({
    id: z.string(),
    type: z.string(),
    actorId: nullableStringSchema,
    payload: jsonRecordSchema,
    createdAt: z.string(),
    protected: z.boolean(),
  })),
  artifacts: z.array(z.object({
    id: z.string(),
    kind: z.string(),
    label: z.string(),
    uri: z.string(),
    mimeType: nullableStringSchema,
    metadata: jsonRecordSchema,
    createdAt: z.string(),
  })),
  runs: z.array(z.object({ id: z.string() }).passthrough()),
  dependencies: z.array(z.object({ id: z.string() }).passthrough()),
  sourceReferences: z.array(z.string()),
  omitted: z.object({
    events: z.number().int(),
    artifacts: z.number().int(),
    runs: z.number().int(),
    dependencies: z.number().int(),
  }),
  characterCount: z.number().int(),
});

const genericJsonEnvelope = Object.freeze({ data: z.unknown() });
const preciseSchemas: Readonly<Record<string, { data: z.ZodType }>> = Object.freeze({
  attach_artifact: { data: artifactSchema },
  block_work: { data: itemSchema },
  claim_work: { data: itemSchema },
  create_item: { data: itemSchema },
  dispatch_work: { data: dispatchResultSchema },
  get_brief: { data: projectBriefSchema },
  get_runner_context: { data: runnerContextSchema },
  handoff_work: { data: itemSchema },
  list_work: { data: z.array(itemSchema) },
  unblock_work: { data: itemSchema },
});

export function publicMcpOutputSchema(toolName: string): { data: z.ZodType } {
  return preciseSchemas[toolName] ?? genericJsonEnvelope;
}
