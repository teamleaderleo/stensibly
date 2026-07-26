import { z } from "zod";
import {
  EXECUTION_ENVELOPE_SCHEMA_VERSION,
  executionScopeClasses,
} from "./execution-envelope.js";

const boundedMinutes = z.number().finite().min(0).max(525_600);
const boundedCount = z.number().int().min(0).max(1_000_000);
const boundedText = z.string().trim().min(1).max(500);

export const executionEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXECUTION_ENVELOPE_SCHEMA_VERSION),
  objective: z.string().trim().min(1).max(2_000),
  scopeClass: z.enum(executionScopeClasses),
  estimate: z.object({
    lowMinutes: boundedMinutes,
    likelyMinutes: boundedMinutes,
    highMinutes: boundedMinutes,
    confidence: z.number().finite().min(0).max(1),
  }).strict(),
  budget: z.object({
    expectedMessages: boundedCount,
    expectedToolCalls: boundedCount,
    expectedReviewMinutes: boundedCount,
  }).strict(),
  boundaries: z.object({
    softCheckpointMinutes: boundedMinutes,
    forcedHandoffMinutes: boundedMinutes,
    hardRecoveryMinutes: boundedMinutes,
  }).strict(),
  completion: z.object({
    requiredOutputs: z.array(boundedText).min(1).max(50),
    verificationRequired: z.boolean(),
    continuationStateRequired: z.boolean(),
    acceptanceChecks: z.array(boundedText).min(1).max(50),
  }).strict(),
  durableState: z.object({
    accessClass: z.enum(["private", "project", "workspace"]),
    retentionClass: z.enum(["ephemeral", "standard", "extended", "indefinite"]),
    redactionRequired: z.boolean(),
    deleteAfter: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (
    value.estimate.lowMinutes > value.estimate.likelyMinutes
    || value.estimate.likelyMinutes > value.estimate.highMinutes
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["estimate"],
      message: "Execution estimate must satisfy lowMinutes <= likelyMinutes <= highMinutes",
    });
  }
  if (
    value.boundaries.softCheckpointMinutes > value.boundaries.forcedHandoffMinutes
    || value.boundaries.forcedHandoffMinutes > value.boundaries.hardRecoveryMinutes
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["boundaries"],
      message: "Execution boundaries must satisfy softCheckpointMinutes <= forcedHandoffMinutes <= hardRecoveryMinutes",
    });
  }
});

export const executionActualSchema = z.object({
  durationMinutes: boundedMinutes.optional(),
  messagesConsumed: boundedCount.optional(),
  toolCalls: boundedCount.optional(),
  filesChanged: boundedCount.optional(),
  reviewMinutes: boundedMinutes.optional(),
  estimateErrorReasons: z.array(boundedText).max(20).optional(),
}).strict();
