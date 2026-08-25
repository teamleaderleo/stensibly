import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callsignSigil } from "./callsign-sigils.js";
import { callsignPools } from "./callsign-suggestions.js";
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
const AUTOMATIC_CALLSIGN_VERSION = 1;
const CURATED_CALLSIGNS = Object.freeze(Object.values(callsignPools).flat());

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
 * Compiles the private durable request from the public enrolment inputs. The
 * UTC-day bucket makes ordinary response-loss retries byte-identical; the
 * two-day expiry leaves at least one day of useful life. A later bucket gets a
 * new command key and converges on an already-active session in the MCP adapter.
 */
export function buildRemoteMcpWorkerEnrolment(input: {
  project: string;
  workerSessionId: string;
  callsign: string;
  context: McpRequestContext;
  now?: number;
}): RemoteMcpWorkerEnrolment {
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

  const actorId = `api-token:${principalAuthorizationId(principal)}`;
  const clientId = `mcp:${actorId}`;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Worker enrolment clock is invalid");
  const startedAtMs = Math.floor(now / ENROLMENT_BUCKET_MS) * ENROLMENT_BUCKET_MS;
  const request = buildWorkerEnrolmentRequest({
    adapter: REMOTE_MCP_ADAPTER,
    profile: REMOTE_MCP_PROFILE,
    workerSessionId: input.workerSessionId,
    callsign: input.callsign,
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
      description: "Enrol this authenticated MCP session as a short-lived Stensibly worker for one project. Supply a stable session ID once per chat; omit callsign to let Stensibly choose one deterministically from its curated pool. Enrolment records attribution only and grants no work, tool, repository, or execution authority.",
      inputSchema: {
        project: z.string().trim().min(1).max(80)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "Use a lowercase project slug"),
        workerSessionId: z.string().trim().min(1).max(160)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        callsign: z.string().trim().min(1).max(80).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => asToolResult(async () => {
      const now = Date.now();
      const automatic = input.callsign === undefined;
      const candidates = automatic
        ? automaticCallsignOrder({
          project: input.project,
          workerSessionId: input.workerSessionId,
          context,
          now,
        })
        : [input.callsign];

      for (const callsign of candidates) {
        const prepared = buildRemoteMcpWorkerEnrolment({
          project: input.project,
          workerSessionId: input.workerSessionId,
          callsign,
          context,
          now,
        });
        const result = backendResultSchema.parse(await provider.enrolWorker(prepared));
        const active = automatic
          ? activeWorkerForAutomaticRequest(result.worker, prepared.request)
          : activeWorkerForRequest(result.worker, prepared.request);
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
        if (automatic && result.reason === "callsign_active_collision") continue;
        return {
          version: 1,
          outcome: "rejected" as const,
          reason: result.reason,
          worker: null,
          reused: false,
          grantsAuthority: false as const,
        };
      }

      return {
        version: 1,
        outcome: "rejected" as const,
        reason: "callsign_pool_exhausted" as const,
        worker: null,
        reused: false,
        grantsAuthority: false as const,
      };
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
  const enrol = captureDataMethod(value, "enrolWorker");
  if (!enrol) return null;
  return Object.freeze({
    enrolWorker: (input: WorkerEnrolmentProviderInput) =>
      Promise.resolve(enrol(input)),
  });
}

function automaticCallsignOrder(input: {
  project: string;
  workerSessionId: string;
  context: McpRequestContext;
  now: number;
}): string[] {
  const principal = input.context.principal;
  if (!principal) {
    throw new Error("Worker enrolment requires an authenticated remote MCP principal");
  }
  const bucket = Math.floor(input.now / ENROLMENT_BUCKET_MS);
  const seed = createHash("sha256")
    .update(`stensibly-automatic-callsign/v${AUTOMATIC_CALLSIGN_VERSION}`)
    .update("\0")
    .update(principalAuthorizationId(principal))
    .update("\0")
    .update(input.project)
    .update("\0")
    .update(input.workerSessionId)
    .update("\0")
    .update(String(bucket))
    .digest("hex");
  return [...CURATED_CALLSIGNS].sort((left, right) => {
    const leftScore = automaticCallsignScore(seed, left);
    const rightScore = automaticCallsignScore(seed, right);
    if (leftScore < rightScore) return -1;
    if (leftScore > rightScore) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function automaticCallsignScore(seed: string, callsign: string): string {
  return createHash("sha256")
    .update(seed)
    .update("\0")
    .update(callsign)
    .digest("hex");
}

function activeWorkerForRequest(
  worker: z.infer<typeof backendWorkerSchema> | null,
  request: WorkerEnrolmentRequest,
): z.infer<typeof backendWorkerSchema> | null {
  const active = activeWorkerForAutomaticRequest(worker, request);
  if (!active || active.callsign !== request.callsign) return null;
  return active;
}

function activeWorkerForAutomaticRequest(
  worker: z.infer<typeof backendWorkerSchema> | null,
  request: WorkerEnrolmentRequest,
): z.infer<typeof backendWorkerSchema> | null {
  if (
    !worker
    || worker.status !== "active"
    || worker.adapter !== request.adapter
    || worker.profile !== request.profile
    || worker.workerSessionId !== request.workerSessionId
    || worker.callsign === null
    || worker.callsignLeaseId === null
    || worker.callsignLeaseGeneration === null
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
  const sigil = worker.callsign === null ? null : callsignSigil(worker.callsign).sigil;
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
