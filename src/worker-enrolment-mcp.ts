import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  callsignBootstrapCandidates,
  callsignBootstrapCategories,
  type CallsignBootstrapCategory,
} from "./callsign-bootstrap.js";
import { callsignSigil } from "./callsign-sigils.js";
import { captureDataMethod } from "./captured-data-method.js";
import type { WorkLedger } from "./ledger.js";
import type { McpRequestContext } from "./mcp-context.js";
import { asToolResult } from "./mcp-tool-result.js";
import {
  principalAuthorizationId,
  principalCanAccessProject,
  principalHasScope,
} from "./token-contracts.js";
import {
  buildWorkerEnrolmentRequest,
  type WorkerEnrolmentRequest,
} from "./worker-enrolment.js";

const REMOTE_MCP_ADAPTER = "remote-mcp";
const REMOTE_MCP_PROFILE = "authenticated-generalist";
const ENROLMENT_BUCKET_MS = 24 * 60 * 60 * 1_000;
const ENROLMENT_LIFETIME_MS = 2 * ENROLMENT_BUCKET_MS;
const HEARTBEAT_SECONDS = 3_600;
const AUTOMATIC_CALLSIGN_ATTEMPTS = 12;

export interface WorkerEnrolmentProviderInput {
  actorId: string;
  clientId: string;
  oauthAccountId?: string;
  request: WorkerEnrolmentRequest;
  idempotencyKey: string;
}

export interface WorkerEnrolmentProvider {
  enrolWorker(input: WorkerEnrolmentProviderInput): Promise<unknown>;
}

export interface WorkerEnrolmentResolutionInput {
  actorId: string;
  clientId: string;
  project: string;
  workerRef: string;
}

export interface WorkerEnrolmentResolver {
  resolveWorkerEnrolment(input: WorkerEnrolmentResolutionInput): Promise<unknown>;
}

export interface ResolvedWorkerAttribution {
  workerRef: string;
  workerSessionId: string;
  callsign: string;
  callsignLeaseGeneration: number;
  expiresAt: string;
}

export interface RemoteMcpWorkerEnrolment {
  actorId: string;
  clientId: string;
  oauthAccountId?: string;
  request: WorkerEnrolmentRequest;
  idempotencyKey: string;
}

interface RemoteMcpWorkerEnrolmentInput {
  project: string;
  workerSessionId: string;
  callsign?: string;
  callsignCategory?: CallsignBootstrapCategory;
  context: McpRequestContext;
  now?: number;
}

const backendWorkerSchema = z.object({
  workerRef: z.string().min(1).max(240),
  adapter: z.string(),
  profile: z.string(),
  workerSessionId: z.string(),
  capabilities: z.array(z.string()),
  toolAllowlist: z.array(z.string()),
  projectScope: z.array(z.string()),
  preferredStances: z.array(z.string()),
  startedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  heartbeatSeconds: z.number().int(),
  correlationId: z.string().nullable(),
  causationId: z.string().nullable(),
  requestFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["active", "released", "expired"]),
  acceptedAt: z.string().datetime(),
  lastHeartbeatAt: z.string().datetime(),
  releasedAt: z.string().datetime().nullable(),
  expiredAt: z.string().datetime().nullable(),
  callsign: z.string().nullable(),
  callsignLeaseId: z.string().nullable(),
  callsignLeaseGeneration: z.number().int().min(1).nullable(),
  grantsAuthority: z.literal(false),
}).strict();

const backendResultSchema = z.object({
  version: z.literal(1),
  operation: z.literal("enrol"),
  outcome: z.enum(["accepted", "rejected"]),
  reason: z.enum([
    "project_not_found",
    "expired_request",
    "active_session_exists",
    "callsign_invalid",
    "callsign_active_collision",
    "callsign_lifetime_too_long",
    "worker_not_found",
    "worker_not_active",
  ]).nullable(),
  worker: backendWorkerSchema.nullable(),
  grantsAuthority: z.literal(false),
  missingProject: z.string().optional(),
}).strict();

/**
 * Compiles the first private durable enrolment request. When no callsign is
 * supplied, the first deterministic pool candidate is returned; the MCP tool
 * itself may advance through more candidates if the hosted lease boundary
 * reports an active collision.
 */
export function buildRemoteMcpWorkerEnrolment(
  input: RemoteMcpWorkerEnrolmentInput,
): RemoteMcpWorkerEnrolment {
  const prepared = buildRemoteMcpWorkerEnrolmentCandidates(input)[0];
  if (!prepared) throw new Error("Worker enrolment produced no callsign candidate");
  return prepared;
}

function buildRemoteMcpWorkerEnrolmentCandidates(
  input: RemoteMcpWorkerEnrolmentInput,
): RemoteMcpWorkerEnrolment[] {
  const principal = input.context.principal;
  if (!principal) {
    throw new Error("Worker enrolment requires an authenticated remote MCP principal");
  }
  if (!principalHasScope(principal, "write")) {
    throw new Error("Worker enrolment requires write scope");
  }
  if (!principalCanAccessProject(principal, input.project)) {
    throw new Error("Worker enrolment is outside this principal's project scope");
  }
  if (input.callsign !== undefined && input.callsignCategory !== undefined) {
    throw new Error("Choose either an explicit callsign or a callsign category, not both");
  }

  const actorId = `api-token:${principalAuthorizationId(principal)}`;
  const clientId = `mcp:${actorId}`;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Worker enrolment clock is invalid");
  const startedAtMs = Math.floor(now / ENROLMENT_BUCKET_MS) * ENROLMENT_BUCKET_MS;
  const callsigns = input.callsign === undefined
    ? callsignBootstrapCandidates({
      seed: automaticCallsignSeed({
        actorId,
        project: input.project,
        workerSessionId: input.workerSessionId,
        category: input.callsignCategory,
      }),
      ...(input.callsignCategory === undefined ? {} : { category: input.callsignCategory }),
      count: AUTOMATIC_CALLSIGN_ATTEMPTS,
    }).candidates.map((candidate) => candidate.callsign)
    : [input.callsign];

  return callsigns.map((callsign) => {
    const request = buildWorkerEnrolmentRequest({
      adapter: REMOTE_MCP_ADAPTER,
      profile: REMOTE_MCP_PROFILE,
      workerSessionId: input.workerSessionId,
      callsign,
      capabilities: ["coordination"],
      toolAllowlist: [],
      projectScope: [input.project],
      preferredStances: [],
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(startedAtMs + ENROLMENT_LIFETIME_MS).toISOString(),
      heartbeatSeconds: HEARTBEAT_SECONDS,
    });
    const idempotencyKey = `enrol_worker:v1:${createHash("sha256")
      .update(`${actorId}\n${request.fingerprint}`)
      .digest("hex")}`;
    return {
      actorId,
      clientId,
      ...(principal.oauthAccountId ? { oauthAccountId: principal.oauthAccountId } : {}),
      request,
      idempotencyKey,
    };
  });
}

export function registerWorkerEnrolmentTools(
  server: McpServer,
  ledger: WorkLedger,
  context: McpRequestContext,
): void {
  const provider = workerEnrolmentProvider(ledger);
  if (!provider) return;

  server.registerTool(
    "enrol_worker",
    {
      description: "Enrol this authenticated MCP session as a short-lived Stensibly worker for one project. Supply a stable session ID once per chat. Omit callsign to receive a pool-backed name automatically, or optionally choose one broad callsignCategory. An explicit callsign remains supported. Stensibly derives ownership, replay protection, scope, capabilities, expiry, and callsign lease attribution. Enrolment records presence only and grants no work, tool, repository, or execution authority.",
      inputSchema: {
        project: z.string().trim().min(1).max(80)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a lowercase project slug"),
        workerSessionId: z.string().trim().min(1).max(160)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        callsign: z.string().trim().min(1).max(80).optional(),
        callsignCategory: z.enum(callsignBootstrapCategories).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => asToolResult(async () => {
      const automatic = input.callsign === undefined;
      const preparedCandidates = buildRemoteMcpWorkerEnrolmentCandidates({ ...input, context });
      for (const prepared of preparedCandidates) {
        const result = backendResultSchema.parse(await provider.enrolWorker(prepared));
        const active = activeWorkerForRequest(
          result.worker,
          prepared.request,
          automatic && result.reason === "active_session_exists",
        );
        if (result.outcome === "accepted") {
          if (
            !active
            || result.reason !== null
            || active.requestFingerprint !== prepared.request.fingerprint
            || active.startedAt !== prepared.request.startedAt
            || active.expiresAt !== prepared.request.expiresAt
          ) {
            throw new Error("Hosted worker enrolment response does not match the request");
          }
          return publicResult(active, false);
        }
        if (result.reason === "active_session_exists" && active) {
          return publicResult(active, true);
        }
        if (automatic && result.reason === "callsign_active_collision") {
          continue;
        }
        return rejectedPublicResult(result.reason);
      }
      return rejectedPublicResult("callsign_candidate_limit");
    }),
  );
}

export function hasWorkerEnrolmentProvider(value: unknown): boolean {
  return workerEnrolmentProvider(value) !== null;
}

export async function resolveWorkerAttribution(
  value: unknown,
  input: WorkerEnrolmentResolutionInput,
  now: number = Date.now(),
): Promise<ResolvedWorkerAttribution | null> {
  const resolve = captureDataMethod(value, "resolveWorkerEnrolment");
  if (!resolve) throw new Error("Durable worker attribution is unavailable on this backend");
  const raw = await Promise.resolve(resolve(input));
  if (raw === null) return null;
  const worker = backendWorkerSchema.parse(raw);
  if (
    worker.workerRef !== input.workerRef
    || worker.status !== "active"
    || worker.grantsAuthority !== false
    || !worker.projectScope.includes(input.project)
    || worker.callsign === null
    || worker.callsignLeaseId === null
    || worker.callsignLeaseGeneration === null
    || !Number.isFinite(now)
    || Date.parse(worker.expiresAt) <= now
  ) {
    throw new Error("Hosted worker attribution does not match the authenticated request");
  }
  return Object.freeze({
    workerRef: worker.workerRef,
    workerSessionId: worker.workerSessionId,
    callsign: worker.callsign,
    callsignLeaseGeneration: worker.callsignLeaseGeneration,
    expiresAt: worker.expiresAt,
  });
}

function workerEnrolmentProvider(value: unknown): WorkerEnrolmentProvider | null {
  const enrol = captureDataMethod(value, "resolveWorkerEnrolment");
  if (!enrol) return null;
  return Object.freeze({
    enrolWorker: (input: WorkerEnrolmentProviderInput) =>
      Promise.resolve(enrol(input)),
  });
}

function activeWorkerForRequest(
  worker: z.infer<typeof backendWorkerSchema> | null,
  request: WorkerEnrolmentRequest,
  allowExistingAssignedCallsign = false,
): z.infer<typeof backendWorkerSchema> | null {
  const callsignMatches = worker !== null && (
    worker.callsign === request.callsign
    || (
      allowExistingAssignedCallsign
      && worker.callsign !== null
      && worker.callsignLeaseId !== null
      && worker.callsignLeaseGeneration !== null
    )
  );
  if (
    !worker
    || worker.status !== "active"
    || worker.adapter !== request.adapter
    || worker.profile !== request.profile
    || worker.workerSessionId !== request.workerSessionId
    || !callsignMatches
    || worker.heartbeatSeconds !== request.heartbeatSeconds
    || !sameStrings(worker.capabilities, request.capabilities)
    || !sameStrings(worker.toolAllowlist, request.toolAllowlist)
    || !sameStrings(worker.preferredStances, request.preferredStances)
    || worker.correlationId !== request.correlationId
    || worker.causationId !== request.causationId
    || worker.grantsAuthority !== false
    || worker.projectScope.length !== 1
    || worker.projectScope[0] !== request.projectScope[0]
  ) return null;
  return worker;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function publicResult(
  worker: z.infer<typeof backendWorkerSchema>,
  reused: boolean,
) {
  if (worker.callsign === null || worker.callsignLeaseGeneration === null) {
    throw new Error("Hosted worker enrolment is missing callsign attribution");
  }
  const sigil = callsignSigil(worker.callsign).sigil;
  return {
    version: 1,
    outcome: "accepted" as const,
    reason: null,
    worker: {
      workerRef: worker.workerRef,
      workerSessionId: worker.workerSessionId,
      callsign: worker.callsign,
      sigil,
      callsignLeaseGeneration: worker.callsignLeaseGeneration,
      status: "active" as const,
      startedAt: worker.startedAt,
      expiresAt: worker.expiresAt,
      acceptedAt: worker.acceptedAt,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      grantsAuthority: false as const,
    },
    reused,
    grantsAuthority: false as const,
  };
}

function rejectedPublicResult(reason: string | null) {
  return {
    version: 1,
    outcome: "rejected" as const,
    reason,
    worker: null,
    reused: false,
    grantsAuthority: false as const,
  };
}

function automaticCallsignSeed(input: {
  actorId: string;
  project: string;
  workerSessionId: string;
  category?: CallsignBootstrapCategory;
}): string {
  return [
    "stensibly-auto-callsign/v1",
    input.actorId,
    input.project.trim().toLowerCase(),
    input.workerSessionId.trim(),
    input.category ?? "any",
  ].join("\0");
}
