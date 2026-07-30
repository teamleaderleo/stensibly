import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  createGitHubWebhookIngress,
  GitHubWebhookIngressError,
  type GitHubWebhookIngress,
} from "./github-webhook-ingress.js";
import type { GitHubRepositoryObservation } from "./github-repository-observation.js";
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

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const actorPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[bot\])?$/;

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

export interface HostedGitHubRepositoryObservationInput {
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly receivedAt: string;
  readonly observation: GitHubRepositoryObservation;
}

export interface HostedGitHubRepositoryObservationResult {
  readonly duplicate: boolean;
}

export interface HostedGitHubRepositoryObservationSink {
  ingestRepositoryObservation(
    input: HostedGitHubRepositoryObservationInput,
  ): Promise<HostedGitHubRepositoryObservationResult>;
}

export interface HostedProviderCapacityOptions {
  service: ProviderCapacityService;
  githubWebhookSecret: string;
  repositoryObservationSink?: HostedGitHubRepositoryObservationSink;
  now?: () => number;
  maxBodyBytes?: number;
}

interface NormalizedOptions {
  service: ProviderCapacityService;
  repositoryObservationSink?: HostedGitHubRepositoryObservationSink;
  ingress: GitHubWebhookIngress;
  now: () => number;
}

export function registerHostedProviderCapacityRoutes(
  app: Hono<StensiblyEnv>,
  authenticator: ApiTokenAuthenticator,
  authOptions: HttpAuthOptions,
  options: HostedProviderCapacityOptions,
): void {
  const normalized = normalizeOptions(options);

  app.post("/webhooks/github", async (context) => {
    let delivery;
    try {
      delivery = await normalized.ingress(context.req.raw);
    } catch (error) {
      return ingressError(context, error);
    }

    let repositoryResult: HostedGitHubRepositoryObservationResult | null = null;
    if (delivery.observation && normalized.repositoryObservationSink) {
      try {
        const result = await normalized.repositoryObservationSink
          .ingestRepositoryObservation(Object.freeze({
            deliveryId: delivery.deliveryId,
            eventType: delivery.eventType,
            payloadDigest: delivery.payloadDigest,
            receivedAt: delivery.receivedAt,
            observation: delivery.observation,
          }));
        if (!result || typeof result.duplicate !== "boolean") {
          throw new Error("Repository observation sink returned an invalid result");
        }
        repositoryResult = Object.freeze({ duplicate: result.duplicate });
      } catch {
        return repositoryObservationError(context);
      }
    }

    if (delivery.eventType !== "issue_comment") {
      return repositoryResult
        ? repositoryAccepted(context, repositoryResult)
        : ignored(context, "unsupported_event_type");
    }

    const parsed = issueComment.safeParse(delivery.payload);
    if (!parsed.success) {
      return context.json({
        error: "GitHub issue_comment payload is malformed",
        code: "invalid_request",
      }, 400);
    }
    const payload = parsed.data;
    if (!payload.issue.pull_request || payload.action === "deleted") {
      return ignored(
        context,
        "not_pull_request_capacity_observation",
        repositoryResult,
      );
    }
    if (
      payload.comment.user.login !== "coderabbitai[bot]"
      || payload.sender.login !== "coderabbitai[bot]"
    ) {
      return ignored(
        context,
        "not_coderabbit_capacity_observation",
        repositoryResult,
      );
    }
    if (payload.comment.body === null) {
      return ignored(
        context,
        "missing_coderabbit_capacity_body",
        repositoryResult,
      );
    }
    const capacity = parseCodeRabbitCapacityComment(
      payload.comment.body,
      payload.comment.updated_at,
    );
    if (!capacity) {
      return ignored(
        context,
        "unrecognised_coderabbit_capacity_observation",
        repositoryResult,
      );
    }

    try {
      const result = await normalized.service.ingestCodeRabbit({
        deliveryId: delivery.deliveryId,
        payloadDigest: legacyPayloadDigest(delivery.payloadDigest),
        sourceCommentId: String(payload.comment.id),
        repository: payload.repository.full_name,
        pullRequestNumber: payload.issue.number,
        subjectLogin: payload.issue.user.login,
        state: capacity.state,
        remaining: capacity.remaining,
        limit: capacity.limit,
        refillAt: capacity.refillAt,
        observedAt: payload.comment.updated_at,
        receivedAt: delivery.receivedAt,
      });
      const allDuplicate = result.duplicate
        && (repositoryResult?.duplicate ?? true);
      return context.json({
        accepted: true,
        duplicate: result.duplicate,
        ...(repositoryResult
          ? { repositoryObservation: repositoryAcceptedBody(repositoryResult) }
          : {}),
        capacityObservation: result.observation,
      }, allDuplicate ? 200 : 202);
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

function normalizeOptions(options: HostedProviderCapacityOptions): NormalizedOptions {
  const now = options.now ?? Date.now;
  return {
    service: options.service,
    ...(options.repositoryObservationSink
      ? { repositoryObservationSink: options.repositoryObservationSink }
      : {}),
    ingress: createGitHubWebhookIngress({
      secret: options.githubWebhookSecret,
      ...(options.maxBodyBytes === undefined
        ? {}
        : { maxBodyBytes: options.maxBodyBytes }),
      now,
    }),
    now,
  };
}

function legacyPayloadDigest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error("Prepared GitHub webhook digest is invalid");
  }
  return value.slice("sha256:".length);
}

function ingressError(
  context: Context<StensiblyEnv>,
  error: unknown,
): Response {
  if (!(error instanceof GitHubWebhookIngressError)) throw error;
  if (error.authenticate) {
    context.header("WWW-Authenticate", "GitHub-HMAC-SHA256");
  }
  return context.json({
    error: error.message,
    code: error.code,
    ...(error.detailCode ? { detailCode: error.detailCode } : {}),
    ...(error.path ? { path: error.path } : {}),
  }, error.status);
}

function repositoryAcceptedBody(
  result: HostedGitHubRepositoryObservationResult,
) {
  return {
    accepted: true,
    duplicate: result.duplicate,
  };
}

function repositoryAccepted(
  context: Context<StensiblyEnv>,
  result: HostedGitHubRepositoryObservationResult,
): Response {
  return context.json({
    accepted: true,
    duplicate: result.duplicate,
    repositoryObservation: repositoryAcceptedBody(result),
  }, result.duplicate ? 200 : 202);
}

function ignored(
  context: Context<StensiblyEnv>,
  reason: string,
  repositoryResult: HostedGitHubRepositoryObservationResult | null = null,
): Response {
  if (!repositoryResult) {
    return context.json({ accepted: false, ignored: true, reason }, 202);
  }
  return context.json({
    accepted: true,
    duplicate: repositoryResult.duplicate,
    repositoryObservation: repositoryAcceptedBody(repositoryResult),
    capacityObservation: {
      accepted: false,
      ignored: true,
      reason,
    },
  }, repositoryResult.duplicate ? 200 : 202);
}

function repositoryObservationError(
  context: Context<StensiblyEnv>,
): Response {
  return context.json({
    error: "GitHub repository observation storage failed",
    code: "backend_failure",
  }, 500);
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
