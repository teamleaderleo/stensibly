import { Hono, type Context } from "hono";
import { attachArtifactSchema } from "./artifact-contracts.js";
import {
  completeWithContinuationsSchema,
  completionContinuationLedger,
} from "./completion-continuation-contracts.js";
import { registerContinuationApi } from "./continuation-api.js";
import {
  filterItemsForPrincipal,
  principalHasScope,
} from "./token-contracts.js";
import {
  createHttpAuthMiddleware,
  currentPrincipal,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import {
  blockItemSchema,
  claimActionSchema,
  claimItemSchema,
  createItemSchema,
  handoffItemSchema,
  itemStatuses,
  recordEventSchema,
  renewClaimSchema,
  unblockItemSchema,
} from "./schemas.js";
import type { ItemStatus } from "./store.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";
import {
  FAILURE_CATEGORY_HEADER,
  type FailureCategory,
} from "./worker-observability.js";

export interface ApiV1Options extends HttpAuthOptions {
  workspace?: string | null;
}

export function createApiV1(
  authenticator: ApiTokenAuthenticator,
  ledger: WorkLedger,
  options: ApiV1Options = { required: false },
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();

  app.onError((error, context) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|not found/i.test(message)) {
      return context.json({ error: message, code: "not_found" }, 404);
    }
    if (/held by another|current claimant|already|unavailable|capacity|reserved|only blocked|generation changed|cannot .* while|changed while/i.test(message)) {
      return context.json({ error: message, code: "conflict" }, 409);
    }
    if (/unauthorized|STENSIBLY_SERVICE_SECRET is not configured/i.test(message)) {
      return backendFailure(context);
    }
    const category = apiFailureCategory(error, message);
    if (category === "convex_failure") return backendFailure(context);
    context.header(FAILURE_CATEGORY_HEADER, category);
    return context.json({ error: message, code: "invalid_operation" }, 400);
  });

  app.use("*", createHttpAuthMiddleware(authenticator, options));

  app.get("/principal", (context) => {
    const principal = currentPrincipal(context);
    if (!principal) {
      context.header("WWW-Authenticate", "Bearer");
      context.header(FAILURE_CATEGORY_HEADER, "auth_failure");
      return context.json({
        error: options.hostedSession
          ? "A valid Bearer token or hosted session is required"
          : "A valid Bearer token is required",
        code: "unauthorized",
      }, 401);
    }

    const publicPrincipal = principal.kind === "account"
      ? {
        kind: "account" as const,
        name: principal.name,
        workspace: principal.workspace,
        role: principal.role,
        scopes: [...principal.scopes],
        projects: principal.projects === null ? null : [...principal.projects],
      }
      : {
        kind: "api_token" as const,
        name: principal.name,
        workspace: options.workspace ?? null,
        scopes: [...principal.scopes],
        projects: principal.projects === null ? null : [...principal.projects],
      };

    return context.json({
      principal: publicPrincipal,
      capabilities: {
        read: principalHasScope(principal, "read"),
        write: principalHasScope(principal, "write"),
        admin: principal.scopes.includes("admin"),
      },
    });
  });

  app.get("/projects/:project/brief", async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return context.json({ error: "Brief limit must be between 1 and 100", code: "invalid_request" }, 400);
    }
    return context.json({ brief: await ledger.getBrief(project, limit) });
  });

  app.get("/items", async (context) => {
    const project = context.req.query("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    const rawStatus = context.req.query("status");
    const status = rawStatus && itemStatuses.includes(rawStatus as ItemStatus)
      ? rawStatus as ItemStatus
      : undefined;
    if (rawStatus && !status) {
      return context.json({ error: `Unknown status: ${rawStatus}`, code: "invalid_request" }, 400);
    }
    let items = await ledger.listWork({
      ...(project ? { project } : {}),
      ...(status ? { status } : {}),
    });
    const principal = currentPrincipal(context);
    if (principal && !project) items = filterItemsForPrincipal(principal, items);
    return context.json({ items });
  });

  app.post("/items", async (context) => {
    const parsed = createItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const denied = requireHttpAccess(context, "write", parsed.data.project);
    if (denied) return denied;
    const idempotencyKey = context.req.header("Idempotency-Key");
    const item = await ledger.createItem({
      ...parsed.data,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ item }, 201);
  });

  app.get("/items/:id", async (context) => {
    const detail = await ledger.getItem(context.req.param("id"));
    const denied = requireHttpAccess(context, "read", detail.item.project);
    if (denied) return denied;
    return context.json(detail);
  });

  app.get("/items/:id/artifacts", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "read", detail.item.project);
    if (denied) return denied;
    return context.json({ artifacts: await ledger.listArtifacts(id) });
  });

  app.post("/items/:id/artifacts", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = attachArtifactSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const artifact = await ledger.attachArtifact({
      id,
      ...parsed.data,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ artifact }, 201);
  });

  app.post("/items/:id/claim", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = claimItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({ item: await ledger.claimWork(actionInput(context, id, parsed.data)) });
  });

  app.post("/items/:id/renew", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = renewClaimSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({ item: await ledger.renewClaim(actionInput(context, id, parsed.data)) });
  });

  app.post("/items/:id/handoff", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = handoffItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({ item: await ledger.handoffWork(actionInput(context, id, parsed.data)) });
  });

  app.post("/items/:id/block", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = blockItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({ item: await ledger.blockWork(actionInput(context, id, parsed.data)) });
  });

  app.post("/items/:id/unblock", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = unblockItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({ item: await ledger.unblockWork(actionInput(context, id, parsed.data)) });
  });

  app.post("/items/:id/release", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = claimActionSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({ item: await ledger.releaseWork(actionInput(context, id, parsed.data)) });
  });

  app.post("/items/:id/complete", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = completeWithContinuationsSchema.safeParse(
      await readJson(context.req.raw),
    );
    if (!parsed.success) return validationError(context, parsed.error.issues);
    if (parsed.data.continuations?.length) {
      const atomic = completionContinuationLedger(ledger);
      if (!atomic) return unsupportedFeature(context);
      return context.json(await atomic.completeWorkWithContinuations(
        actionInput(context, id, {
          ...parsed.data,
          continuations: parsed.data.continuations,
        }),
      ));
    }
    return context.json({
      item: await ledger.completeWork(actionInput(context, id, {
        actor: parsed.data.actor,
        ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
      })),
    });
  });

  app.post("/items/:id/events", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = recordEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const event = await ledger.recordEvent(actionInput(context, id, parsed.data));
    return context.json({ event }, 201);
  });

  registerContinuationApi(app, ledger);
  return app;
}

function actionInput<T extends object>(
  context: Context<StensiblyEnv>,
  id: string,
  input: T,
): T & { id: string; idempotencyKey?: string } {
  const idempotencyKey = context.req.header("Idempotency-Key");
  return {
    id,
    ...input,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validationError(
  context: Context<StensiblyEnv>,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
) {
  return context.json({
    error: "Invalid request",
    code: "invalid_request",
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  }, 400);
}

function unsupportedFeature(context: Context<StensiblyEnv>) {
  return context.json({
    error: "Atomic completion continuations are unavailable on this backend",
    code: "unsupported_feature",
  }, 501);
}

function backendFailure(context: Context<StensiblyEnv>): Response {
  context.header(FAILURE_CATEGORY_HEADER, "convex_failure");
  return context.json({
    error: "Hosted backend request failed",
    code: "backend_failure",
  }, 502);
}

function apiFailureCategory(error: unknown, message: string): FailureCategory {
  if (error instanceof TypeError) return "convex_failure";
  if (/fetch failed|failed to fetch|network|ECONN|ENOTFOUND|timed? out|timeout|internal server error/i.test(message)) {
    return "convex_failure";
  }
  return "request_failure";
}
