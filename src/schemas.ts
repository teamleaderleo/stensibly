import { z } from "zod";

export const itemKinds = [
  "task",
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
] as const;

export const itemStatuses = ["ready", "active", "blocked", "done", "archived"] as const;
export const actorKinds = ["human", "agent", "service"] as const;

export const actorSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(actorKinds).default("agent"),
});

export const createItemSchema = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
  kind: z.enum(itemKinds).default("task"),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(10_000).optional(),
  nextAction: z.string().trim().max(2_000).optional(),
  priority: z.number().int().min(0).max(100).default(50),
  actor: actorSchema.optional(),
});

export const claimItemSchema = z.object({
  actor: actorSchema,
  leaseSeconds: z.number().int().min(30).max(86_400).default(900),
});

export const actorActionSchema = z.object({
  actor: actorSchema,
  summary: z.string().trim().max(10_000).optional(),
});

export const recordEventSchema = z.object({
  actor: actorSchema.optional(),
  type: z.string().trim().min(1).max(120).regex(/^[a-z0-9._-]+$/),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type ActorInput = z.infer<typeof actorSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
