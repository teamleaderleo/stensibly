import { z } from "zod";
import {
  continuationApprovalModes,
  continuationCommands,
  continuationDeliveryModes,
  continuationStatuses,
  type ContinuationProposal,
  type ListContinuationsInput,
  type ProposeContinuationInput,
  type ResolveContinuationInput,
} from "./continuations.js";
import { actorSchema } from "./schemas.js";

const identifier = z.string().trim().min(1).max(240);
const optionalIdentifier = z.string().trim().min(1).max(240).optional();

export const continuationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_item"),
    project: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug"),
  }),
  z.object({ kind: z.literal("resume_item"), itemId: identifier }),
  z.object({
    kind: z.literal("dispatch_item"),
    itemId: identifier,
    runnerProfile: optionalIdentifier,
  }),
  z.object({
    kind: z.literal("request_decision"),
    decisionType: z.string().trim().min(1).max(120),
  }),
]);

export const continuationEvidenceSchema = z.object({
  kind: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(240),
  uri: z.string().trim().min(1).max(4096),
});

export const proposeContinuationSchema = z.object({
  sourceRunId: optionalIdentifier,
  title: z.string().trim().min(1).max(240),
  rationale: z.string().trim().min(1).max(10_000),
  instruction: z.string().trim().min(1).max(10_000),
  action: continuationActionSchema,
  evidence: z.array(continuationEvidenceSchema).max(100).default([]),
  actor: actorSchema,
  approvalMode: z.enum(continuationApprovalModes).default("human"),
  deliveryMode: z.enum(continuationDeliveryModes).default("human_inbox"),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

export const resolveContinuationSchema = z.object({
  actor: actorSchema,
  command: z.enum(continuationCommands),
  expectedGeneration: z.number().int().min(1),
  note: z.string().trim().max(10_000).optional(),
});

export const listContinuationsSchema = z.object({
  status: z.enum(continuationStatuses).optional(),
  deliveryMode: z.enum(continuationDeliveryModes).optional(),
});

export interface ContinuationLedger {
  proposeContinuation(input: ProposeContinuationInput): Promise<ContinuationProposal>;
  getContinuation(id: string): Promise<ContinuationProposal>;
  listContinuations(input?: ListContinuationsInput): Promise<ContinuationProposal[]>;
  resolveContinuation(input: ResolveContinuationInput): Promise<ContinuationProposal>;
}

export function continuationLedger(value: unknown): ContinuationLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof ContinuationLedger, unknown>>;
  return typeof candidate.proposeContinuation === "function" &&
      typeof candidate.getContinuation === "function" &&
      typeof candidate.listContinuations === "function" &&
      typeof candidate.resolveContinuation === "function"
    ? value as ContinuationLedger
    : null;
}
