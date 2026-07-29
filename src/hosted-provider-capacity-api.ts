import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  createHttpAuthMiddleware,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import {
  ProviderCapacityConflictError,
  ProviderCapacityStorageError,
  parseCodeRabbitCapacityComment,
} from "./provider-capacity.js";
import type { ProviderCapacityService } from "./provider-capacity-convex.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

const DEFAULT_MAX_BODY_BYTES = 256 * 1_024;
const deliveryPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[bot\])?$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

const actor = z.string().min(1).max(120).regex(actorPattern);
const timestamp = z.string().min(1).max(64).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "Timestamp must be valid",
);
const issueComment = z.object({
  action: z.enum(["created", "edited", "deleted"]),
  repository: z.object({
    full_name: z.string().min(3).max(200).regex(repositoryPattern),
  }).passthrough(),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({}).passthrough().optional(),
    user: z.object({ login: actor }).passthrough(),
  }).passthrough(),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string().max(100_000).nullable(),
    created_at: timestamp,
    updated_at: timestamp,
    user: z.object({ login: actor }).passthrough(),
  }).passthrough(),
  sender: z.object({ login: actor }).passthrough(),
}).passthrough();

export interface HostedProviderCapacityOptions {
  service: ProviderCapacityService;
  githubWebhookSecret: string;
  now?: () => number;
  maxBodyBytes?: number;
}

export function registerHostedProviderCapacityRoutes(
  app: Hono<StensiblyEnv>,
  authenticator: ApiTokenAuthenticator,
  authOptions: HttpAuthOptions,
  options: HostedProviderCapacityOptions,
): void {
  const normalized = normalizeOptions(options);

  app.post("/webhooks/github", async (context) => {
    const deliveryId = context.req.header("X-GitHub-Delivery");
    if (!deliveryId || !deliveryPattern.test(deliveryId)) {
      return context.json({
        error: "X-GitHub-Delivery must be a bounded delivery identity",
        code: "invalid_request",
      }, 400);
    }
    const eventType = context.req.header("X-GitHub-Event");
    if (!eventType || eventType.length > 64 || unsafeTextPattern.test(eventType)) {
      return context.json({
        error: "X-GitHub-Event must be a bounded event type",
        code: "invalid_request",
      }, 400);
    }
    const contentType = context.req.header("Content-Type")
      ?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return context.json({
        error: "GitHub webhook content type must be application/json",
        code: "unsupported_media_type",
      }, 415);
    }

    const body = await readBoundedBody(context.req.raw, normalized.maxBodyBytes);
    if (body instanceof Response) return body;
    if (!verifySignature(
      normalized.githubWebhookSecret,
      body,
      context.req.header("X-Hub-Signature-256"),
    )) {
      context.header("WWW-Authenticate", "GitHub-HMAC-SHA256");
      return context.json({
        error: "GitHub webhook signature is invalid",
        code: "unauthorized",
      }, 401);
    }
    if (eventType !== "issue_comment") return ignored(context, "unsupported_event_type");

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return context.json({
        error: "GitHub issue_comment body must be valid UTF-8 JSON",
        code: "invalid_request",
      }, 400);
    }
    const parsed = issueComment.safeParse(raw);
    if (!parsed.success) {
      return context.json({
        error: "GitHub issue_comment payload is malformed",
        code: "invalid_request",
      }, 400);
    }
    const payload = parsed.data;
    if (!payload.issue.pull_request || payload.action === "deleted") {
      return ignored(context, "not_pull_request_capacity_observation");
    }
    if (payload.comment.user.login !== "coderabbitai[bot]" || payload.sender.login !== "coderabbitai[bot]") {
      return ignored(context, "not_coderabbit_capacity_observation");
    }
    if (payload.comment.body === null) {
      return ignored(context, "missing_coderabbit_capacity_body");
    }
    const capacity = parseCodeRabbitCapacityComment(payload.comment.body, payload.comment.updated_at);
    if (!capacity) return ignored(context, "unrecognised_coderabbit_capacity_observation");

    try {
      const result = await normalized.service.ingestCodeRabbit({
        deliveryId,
        payloadDigest: createHash("sha256").update(body).digest("hex"),
        sourceCommentId: String(payload.comment.id),
        repository: payload.repository.full_name,
        pullRequestNumber: payload.issue.number,
        subjectLogin: payload.issue.user.login,
        state: capacity.state,
        remaining: capacity.remaining,
        limit: capacity.limit,
        refillAt: capacity.refillAt,
        observedAt: payload.comment.updated_at,
        receivedAt: new Date(normalized.now()).toISOString(),
      });
      return context.json({
        accepted: true,
        duplicate: result.duplicate,
        capacityObservation: result.observation,
      }, result.duplicate ? 200 : 202);
    } catch (error) {
      return capacityError(context, error);
    }
  });

  const api = new Hono<StensiblyEnv>();
  api.use("*", createHttpAuthMiddleware(authenticator, { ...authOptions, required: true }));
  api.get("/provider-capacities/coderabbit", async (context) => {
    const denied = requireHttpAccess(context, "read");
    if (denied) return denied;
    const repository = context.req.query("repository");
    const subject = context.req.query("subject");
    if (!repository || !subject) {
      return context.json({
        error: "CodeRabbit capacity requires repository and subject query parameters",
        code: "invalid_request",
      }, 400);
    }
    try {
      return context.json({
        capacity: await normalized.service.snapshot(repository, subject, normalized.now()),
      });
    } catch (error) {
      return capacityError(context, error);
    }
  });
  app.route("/api/v1", api);
}

function normalizeOptions(options: HostedProviderCapacityOptions) {
  const bytes = Buffer.byteLength(options.githubWebhookSecret, "utf8");
  if (bytes < 16 || bytes > 1_024) {
    throw new Error("GitHub webhook secret must contain between 16 and 1024 UTF-8 bytes");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 1_024 * 1_024) {
    throw new Error("GitHub webhook body bound must be between 1024 and 1048576 bytes");
  }
  return {
    service: options.service,
    githubWebhookSecret: options.githubWebhookSecret,
    maxBodyBytes,
    now: options.now ?? Date.now,
  };
}

async function readBoundedBody(request: Request, maxBodyBytes: number): Promise<Uint8Array | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      return Response.json({
        error: "Content-Length must be a non-negative integer",
        code: "invalid_request",
      }, { status: 400 });
    }
    if (length > maxBodyBytes) return payloadTooLarge();
  }
  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel("GitHub webhook body exceeds the configured bound");
        return payloadTooLarge();
      }
      chunks.push(result.value.slice());
    }
  } catch {
    return Response.json({
      error: "GitHub webhook body could not be read",
      code: "invalid_request",
    }, { status: 400 });
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function payloadTooLarge(): Response {
  return Response.json({
    error: "GitHub webhook body exceeds the configured bound",
    code: "payload_too_large",
  }, { status: 413 });
}

function verifySignature(secret: string, body: Uint8Array, signature: string | undefined): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "");
  if (!match?.[1]) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function ignored(context: Context<StensiblyEnv>, reason: string): Response {
  return context.json({ accepted: false, ignored: true, reason }, 202);
}

function capacityError(context: Context<StensiblyEnv>, error: unknown): Response {
  if (error instanceof ProviderCapacityConflictError) {
    return context.json({ error: error.message, code: "conflict" }, 409);
  }
  if (error instanceof ProviderCapacityStorageError) {
    context.header("Retry-After", "60");
    return context.json({
      error: "Provider capacity observation storage is at capacity",
      code: "temporarily_unavailable",
    }, 503);
  }
  if (error instanceof RangeError) {
    return context.json({
      error: "Provider capacity observation is invalid",
      code: "invalid_request",
    }, 400);
  }
  return context.json({
    error: "Provider capacity observation storage failed",
    code: "backend_failure",
  }, 500);
}
