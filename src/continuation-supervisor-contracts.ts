import { z } from "zod";
import type {
  ContinuationSupervisorPolicyResult,
  QueueContinuationForSupervisorInput,
  RunContinuationSupervisorPolicyInput,
  SupervisorContinuationResult,
} from "./continuation-supervisor.js";
import { executionEnvelopeSchema } from "./execution-envelope-contracts.js";
import { actorSchema } from "./schemas.js";

const defaultSupervisor = {
  id: "service:supervisor",
  name: "Supervisor",
  kind: "service" as const,
};

export const queueContinuationForSupervisorSchema = z.object({
  actor: actorSchema,
  supervisor: actorSchema.default(defaultSupervisor),
  expectedGeneration: z.number().int().min(1),
  runnerType: z.string().trim().min(1).max(80).default("generic-mcp"),
  runnerProfile: z.string().trim().min(1).max(160).default("codex-default"),
  leaseSeconds: z.number().int().min(30).max(86_400).default(900),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  retryBackoffSeconds: z.number().int().min(0).max(86_400).default(60),
  executionEnvelope: executionEnvelopeSchema.optional(),
}).strict();

export const runContinuationSupervisorPolicySchema = z.object({
  supervisor: actorSchema.default(defaultSupervisor),
  runnerType: z.string().trim().min(1).max(80).default("generic-mcp"),
  runnerProfile: z.string().trim().min(1).max(160).default("codex-default"),
  project: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug")
    .optional(),
  limit: z.number().int().min(1).max(100).default(20),
  leaseSeconds: z.number().int().min(30).max(86_400).default(900),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  retryBackoffSeconds: z.number().int().min(0).max(86_400).default(60),
}).strict();

export interface ContinuationSupervisorLedger {
  queueContinuationForSupervisor(
    input: QueueContinuationForSupervisorInput,
  ): Promise<SupervisorContinuationResult>;
  runContinuationSupervisorPolicy(
    input: RunContinuationSupervisorPolicyInput,
  ): Promise<ContinuationSupervisorPolicyResult>;
}

export function continuationSupervisorLedger(
  value: unknown,
): ContinuationSupervisorLedger | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Record<keyof ContinuationSupervisorLedger, unknown>>;
  return typeof candidate.queueContinuationForSupervisor === "function"
      && typeof candidate.runContinuationSupervisorPolicy === "function"
    ? value as ContinuationSupervisorLedger
    : null;
}
