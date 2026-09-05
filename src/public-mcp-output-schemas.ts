import { z } from "zod";

// Keep this Worker-safe: importing artifacts.ts pulls the SQLite implementation.
export const publicMcpArtifactKinds = [
  "file",
  "url",
  "commit",
  "issue",
  "document",
  "image",
  "log",
  "dataset",
  "other",
] as const;
// Public output schemas describe the fields that route the next model action.
// Durable records may add bounded evidence without copying their entire storage
// contract into every tool declaration.
const routingItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  claimGeneration: z.number().int(),
  version: z.number().int(),
}).passthrough();

const briefItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
}).passthrough();

const projectBriefSchema = z.object({
  project: z.string(),
  counts: z.object({
    total: z.number().int(),
  }).passthrough(),
  ready: z.array(briefItemSchema),
  active: z.array(briefItemSchema),
  blocked: z.array(briefItemSchema),
}).passthrough();

const routingRunSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  runnerProfile: z.string(),
  status: z.string(),
  generation: z.number().int(),
}).passthrough();

const dispatchResultSchema = z.object({
  status: z.literal("dispatched"),
  replay: z.boolean(),
  expectedClaimGeneration: z.number().int(),
  claimedGeneration: z.number().int(),
  item: routingItemSchema,
  run: routingRunSchema,
}).passthrough();

const runnerContextSchema = z.object({
  packetFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  item: routingItemSchema,
  claimHandoff: z.object({
    claimGeneration: z.number().int(),
    claimedBy: z.string().nullable(),
    claimExpiresAt: z.string().nullable(),
    leaseLive: z.boolean(),
    useAs: z.literal("expectedClaimGeneration"),
  }).passthrough(),
  sourceReferences: z.array(z.string()),
  characterCount: z.number().int(),
}).passthrough();

const genericJsonEnvelope = Object.freeze({ data: z.unknown() });
const preciseSchemas: Readonly<Record<string, { data: z.ZodType }>> = Object.freeze({
  dispatch_work: { data: dispatchResultSchema },
  get_brief: { data: projectBriefSchema },
  get_runner_context: { data: runnerContextSchema },
  list_work: { data: z.array(routingItemSchema) },
});

export function publicMcpOutputSchema(toolName: string): { data: z.ZodType } {
  return preciseSchemas[toolName] ?? genericJsonEnvelope;
}
