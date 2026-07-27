import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  createHttpAuthMiddleware,
  currentPrincipal,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import {
  MAX_PROVIDER_EVENT_LIST,
  ProviderEventConflictError,
  ProviderEventNotFoundError,
  SqliteProviderEventStore,
  type ProviderEventStatus,
} from "./provider-events.js";
import type { StensiblyStore } from "./store.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export const DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export interface GitHubWebhookOptions {
  secret: string;
  maxBodyBytes?: number;
  now?: () => number;
}

const githubDeliveryPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const githubRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const githubLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const gitRevisionPattern = /^[0-9a-f]{40}$/i;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/u;

const pullRequestReviewSchema = z.object({
  action: z.enum(["submitted", "edited", "dismissed"]),
  repository: z.object({
    full_name: z.string().min(3).max(200).regex(githubRepositoryPattern),
  }).passthrough(),
  pull_request: z.object({
    number: z.number().int().positive(),
  }).passthrough(),
  review: z.object({
    id: z.number().int().positive().safe(),
    commit_id: z.string().regex(gitRevisionPattern),
    state: z.enum([
      "approved",
      "changes_requested",
      "commented",
      "dismissed",
      "pending",
    ]),
  }).passthrough(),
  sender: z.object({
    login: z.string().regex(githubLoginPattern),
  }).passthrough().optional(),
}).passthrough();

const acknowledgementActorSchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .refine((value) => !controlPattern.test(value), "Actor contains control characters");

const acknowledgementSchema = z.object({
  actor: acknowledgementActorSchema.optional(),
}).strict();

export function registerGitHubProviderEventRoutes(
  app: Hono<StensiblyEnv>,
  store: StensiblyStore,
  authenticator: ApiTokenAuthenticator,
  authOptions: HttpAuthOptions,
  options: GitHubWebhookOptions,
): void {
  const normalized = normalizeOptions(options);
  const events = new SqliteProviderEventStore(store);

  app.post("/webhooks/github", async (context) => {
    const deliveryId = context.req.header("X-GitHub-Delivery");
    if (!deliveryId || !githubDeliveryPattern.test(deliveryId)) {
      return context.json({
        error: "X-GitHub-Delivery must be a bounded delivery identity",
        code: "invalid_request",
      }, 400);
    }

    const eventType = context.req.header("X-GitHub-Event");
    if (!eventType || eventType.length > 64 || controlPattern.test(eventType)) {
      return context.json({
        error: "X-GitHub-Event must be a bounded event type",
        code: "invalid_request",
      }, 400);
    }

    const contentType = context.req.header("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return context.json({
        error: "GitHub webhook content type must be application/json",
        code: "unsupported_media_type",
      }, 415);
    }

    const bodyResult = await readBoundedBody(context.req.raw, normalized.maxBodyBytes);
    if (bodyResult instanceof Response) return bodyResult;

    const signature = context.req.header("X-Hub-Signature-256");
    if (!verifySignature(normalized.secret, bodyResult, signature)) {
      context.header("WWW-Authenticate", "GitHub-HMAC-SHA256");
      return context.json({
        error: "GitHub webhook signature is invalid",
        code: "unauthorized",
      }, 401);
    }

    if (eventType !== "pull_request_review") {
      return context.json({
        accepted: false,
        ignored: true,
        reason: "unsupported_event_type",
      }, 202);
    }

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyResult));
    } catch {
      return context.json({
        error: "GitHub webhook body must be valid UTF-8 JSON",
        code: "invalid_request",
      }, 400);
    }

    const parsed = pullRequestReviewSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return context.json({
        error: "GitHub pull_request_review payload is malformed",
        code: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }, 400);
    }

    const payload = parsed.data;
    const externalObjectId = String(payload.review.id);
    const repository = payload.repository.full_name;
    const subjectNumber = payload.pull_request.number;
    const revision = payload.review.commit_id.toLowerCase();
    const actor = payload.sender?.login ?? null;
    const summary = boundedSummary(
      `GitHub pull request review ${payload.action} on ${repository}#${subjectNumber} (${payload.review.state})`,
    );

    try {
      const result = events.ingestGitHubPullRequestReview({
        deliveryId,
        payloadDigest: createHash("sha256").update(bodyResult).digest("hex"),
        externalObjectId,
        repository,
        subjectNumber,
        action: payload.action,
        revision,
        actor,
        summary,
        receivedAt: new Date(normalized.now()).toISOString(),
      });
      return context.json({
        accepted: true,
        duplicate: result.duplicate,
        event: result.event,
      }, result.duplicate ? 200 : 202);
    } catch (error) {
      return providerEventError(context, error);
    }
  });

  const api = new Hono<StensiblyEnv>();
  api.use("*", createHttpAuthMiddleware(authenticator, authOptions));

  api.get("/provider-events", (context) => {
    const denied = requireHttpAccess(context, "admin");
    if (denied) return denied;

    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROVIDER_EVENT_LIST) {
      return context.json({
        error: `Provider event limit must be between 1 and ${MAX_PROVIDER_EVENT_LIST}`,
        code: "invalid_request",
      }, 400);
    }

    const rawStatus = context.req.query("status");
    const status = rawStatus === undefined
      ? undefined
      : parseProviderEventStatus(rawStatus);
    if (rawStatus !== undefined && status === null) {
      return context.json({
        error: `Unknown provider event status: ${rawStatus}`,
        code: "invalid_request",
      }, 400);
    }

    return context.json({
      events: events.list({
        limit,
        ...(status ? { status } : {}),
      }),
    });
  });

  api.post("/provider-events/:id/acknowledge", async (context) => {
    const denied = requireHttpAccess(context, "admin");
    if (denied) return denied;

    let rawPayload: unknown;
    try {
      rawPayload = await context.req.json();
    } catch {
      return context.json({
        error: "Acknowledgement body must be valid JSON",
        code: "invalid_request",
      }, 400);
    }

    const parsed = acknowledgementSchema.safeParse(rawPayload);
    if (!parsed.success) {
      return context.json({
        error: "Acknowledgement body is malformed",
        code: "invalid_request",
      }, 400);
    }

    const principal = currentPrincipal(context);
    const principalActor = principal
      ? `${principal.kind}:${principal.name}`
      : null;
    if (principalActor && !acknowledgementActorSchema.safeParse(principalActor).success) {
      return context.json({
        error: "Authenticated principal cannot be represented as a bounded acknowledgement actor",
        code: "invalid_operation",
      }, 400);
    }
    if (principalActor && parsed.data.actor && parsed.data.actor !== principalActor) {
      return context.json({
        error: "Acknowledgement actor must match the authenticated principal",
        code: "invalid_request",
      }, 400);
    }
    const actor = principalActor ?? parsed.data.actor;
    if (!actor) {
      return context.json({
        error: "Acknowledgement actor is required when HTTP authentication is disabled",
        code: "invalid_request",
      }, 400);
    }

    try {
      return context.json({
        event: events.acknowledge(
          context.req.param("id"),
          actor,
          new Date(normalized.now()).toISOString(),
        ),
      });
    } catch (error) {
      return providerEventError(context, error);
    }
  });

  app.route("/api/v1", api);
}

function normalizeOptions(options: GitHubWebhookOptions): {
  secret: string;
  maxBodyBytes: number;
  now: () => number;
} {
  const secretBytes = Buffer.byteLength(options.secret, "utf8");
  if (secretBytes < 16 || secretBytes > 1024) {
    throw new Error("GitHub webhook secret must contain between 16 and 1024 UTF-8 bytes");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_GITHUB_WEBHOOK_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1024 * 1024) {
    throw new Error("GitHub webhook body bound must be between 1024 and 1048576 bytes");
  }
  return {
    secret: options.secret,
    maxBodyBytes,
    now: options.now ?? Date.now,
  };
}

async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
): Promise<Uint8Array | Response> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isInteger(parsedLength) || parsedLength < 0) {
      return Response.json({
        error: "Content-Length must be a non-negative integer",
        code: "invalid_request",
      }, { status: 400 });
    }
    if (parsedLength > maxBodyBytes) {
      return Response.json({
        error: "GitHub webhook body exceeds the configured bound",
        code: "payload_too_large",
      }, { status: 413 });
    }
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBodyBytes) {
    return Response.json({
      error: "GitHub webhook body exceeds the configured bound",
      code: "payload_too_large",
    }, { status: 413 });
  }
  return bytes;
}

function verifySignature(
  secret: string,
  body: Uint8Array,
  signature: string | undefined,
): boolean {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "");
  if (!match?.[1]) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function parseProviderEventStatus(value: string): ProviderEventStatus | null {
  return value === "pending" || value === "acknowledged" ? value : null;
}

function boundedSummary(summary: string): string {
  return summary.length <= 300 ? summary : `${summary.slice(0, 299)}…`;
}

function providerEventError(
  context: Context<StensiblyEnv>,
  error: unknown,
): Response {
  if (error instanceof ProviderEventConflictError) {
    return context.json({ error: error.message, code: "conflict" }, 409);
  }
  if (error instanceof ProviderEventNotFoundError) {
    return context.json({ error: error.message, code: "not_found" }, 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  return context.json({ error: message, code: "invalid_operation" }, 400);
}
