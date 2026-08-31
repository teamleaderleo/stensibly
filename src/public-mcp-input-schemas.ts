import { z } from "zod";
import { compatibilityExecutionEnvelope } from "./execution-envelope-default.js";
import { publicMcpArtifactKinds } from "./public-mcp-output-schemas.js";
import { actorSchema } from "./schemas.js";

type InputSchema = Readonly<Record<string, z.ZodType>>;

const projectSchema = z.string().trim().min(1).max(80)
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Use a lowercase project slug");
const idSchema = z.string().trim().min(1);
const idempotencyKeySchema = z.string().trim().min(1).max(240);

const compactInputSchemas: Readonly<Record<string, InputSchema>> = Object.freeze({
  attach_artifact: Object.freeze({
    id: idSchema,
    actor: actorSchema,
    kind: z.enum(publicMcpArtifactKinds),
    label: z.string().trim().min(1).max(240),
    uri: z.string().trim().min(1).max(4096),
    mimeType: z.string().trim().min(1).max(255).optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  }),
  complete_work: Object.freeze({
    id: idSchema,
    actor: actorSchema,
    expectedClaimGeneration: z.number().int().min(0),
    summary: z.string().trim().max(10_000).optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  }),
  dispatch_work: Object.freeze({
    project: projectSchema,
    itemId: idSchema,
    expectedClaimGeneration: z.number().int().min(0),
    actor: actorSchema,
    runnerType: z.string().trim().min(1).max(80),
    runnerProfile: z.string().trim().min(1).max(240),
    runnerProfileVersion: z.string().trim().min(1).max(240).nullable(),
    objective: z.string().trim().min(1).max(2_000).optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  get_project_attachment: Object.freeze({
    project: projectSchema,
  }),
});

export function publicMcpInputSchema(
  toolName: string,
  fallback: unknown,
): unknown {
  return compactInputSchemas[toolName] ?? fallback;
}

export function expandPublicMcpInput(
  toolName: string,
  value: unknown,
): unknown {
  if (!isRecord(value)) return value;
  switch (toolName) {
    case "attach_artifact":
      return { ...value, metadata: {} };
    case "dispatch_work": {
      const runnerProfile = requiredString(value.runnerProfile, "runnerProfile");
      const itemId = requiredString(value.itemId, "itemId");
      const objective = typeof value.objective === "string"
        ? value.objective
        : `Dispatch work item ${itemId} with runner profile ${runnerProfile}`;
      const { objective: _objective, ...input } = value;
      return {
        ...input,
        executionEnvelope: compatibilityExecutionEnvelope(objective),
        leaseSeconds: 900,
        maxAttempts: 3,
        retryBackoffSeconds: 60,
      };
    }
    default:
      return value;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Public MCP ${label} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
