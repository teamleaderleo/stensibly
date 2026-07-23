import { Hono, type Context } from "hono";
import {
  attachArtifact,
  attachArtifactSchema,
  listArtifacts,
} from "./artifacts.ts";
import { getProjectBrief } from "./briefs.ts";
import {
  actorActionSchema,
  blockItemSchema,
  claimItemSchema,
  createItemSchema,
  handoffItemSchema,
  itemStatuses,
  recordEventSchema,
  unblockItemSchema,
} from "./schemas.ts";
import { expireClaims, renewClaim } from "./leases.ts";
import {
  ConflictError,
  NotFoundError,
  StensiblyStore,
  type ItemStatus,
} from "./store.ts";
import { blockWork, handoffWork, unblockWork } from "./transitions.ts";
import { renderBoard } from "./view.ts";

export function createApp(store: StensiblyStore): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    if (error instanceof NotFoundError) return context.json({ error: error.message }, 404);
    if (error instanceof ConflictError) return context.json({ error: error.message }, 409);
    console.error(error);
    return context.json({ error: "Unexpected server error" }, 500);
  });

  app.get("/", (context) => {
    expireClaims(store);
    return context.html(renderBoard(store.listItems()));
  });
  app.get("/health", (context) => context.json({ ok: true, service: "stensibly" }));

  app.get("/api/projects/:project/brief", (context) => {
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return context.json({ error: "Brief limit must be between 1 and 100" }, 400);
    }
    return context.json({ brief: getProjectBrief(store, context.req.param("project"), limit) });
  });

  app.get("/api/items", (context) => {
    expireClaims(store);
    const project = context.req.query("project");
    const rawStatus = context.req.query("status");
    const status = rawStatus && itemStatuses.includes(rawStatus as ItemStatus)
      ? (rawStatus as ItemStatus)
      : undefined;

    if (rawStatus && !status) return context.json({ error: `Unknown status: ${rawStatus}` }, 400);
    return context.json({ items: store.listItems({ project, status }) });
  });

  app.post("/api/items", async (context) => {
    const parsed = createItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const item = store.createItem(parsed.data, context.req.header("Idempotency-Key"));
    return context.json({ item }, 201);
  });

  app.get("/api/items/:id", (context) => {
    expireClaims(store);
    const id = context.req.param("id");
    return context.json({
      item: store.getItem(id),
      events: store.listEvents(id),
      artifacts: listArtifacts(store, id),
    });
  });

  app.get("/api/items/:id/artifacts", (context) =>
    context.json({ artifacts: listArtifacts(store, context.req.param("id")) }),
  );

  app.post("/api/items/:id/artifacts", async (context) => {
    const parsed = attachArtifactSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const artifact = attachArtifact(store, {
      itemId: context.req.param("id"),
      actor: parsed.data.actor,
      kind: parsed.data.kind,
      label: parsed.data.label,
      uri: parsed.data.uri,
      metadata: parsed.data.metadata,
      ...(parsed.data.mimeType ? { mimeType: parsed.data.mimeType } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ artifact }, 201);
  });

  app.post("/api/items/:id/claim", async (context) => {
    const parsed = claimItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    expireClaims(store);
    const item = store.claimItem(
      context.req.param("id"),
      parsed.data.actor,
      parsed.data.leaseSeconds,
      context.req.header("Idempotency-Key"),
    );
    return context.json({ item });
  });

  app.post("/api/items/:id/renew", async (context) => {
    const parsed = claimItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const item = renewClaim(
      store,
      context.req.param("id"),
      parsed.data.actor,
      parsed.data.leaseSeconds,
      context.req.header("Idempotency-Key"),
    );
    return context.json({ item });
  });

  app.post("/api/items/:id/handoff", async (context) => {
    const parsed = handoffItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const item = handoffWork(store, {
      id: context.req.param("id"),
      actor: parsed.data.actor,
      summary: parsed.data.summary,
      nextAction: parsed.data.nextAction,
      ...(parsed.data.toActorId ? { toActorId: parsed.data.toActorId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ item });
  });

  app.post("/api/items/:id/block", async (context) => {
    const parsed = blockItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const item = blockWork(store, {
      id: context.req.param("id"),
      actor: parsed.data.actor,
      reason: parsed.data.reason,
      ...(parsed.data.nextAction ? { nextAction: parsed.data.nextAction } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ item });
  });

  app.post("/api/items/:id/unblock", async (context) => {
    const parsed = unblockItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const item = unblockWork(store, {
      id: context.req.param("id"),
      actor: parsed.data.actor,
      ...(parsed.data.nextAction ? { nextAction: parsed.data.nextAction } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ item });
  });

  app.post("/api/items/:id/release", async (context) => {
    const parsed = actorActionSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    expireClaims(store);
    const item = store.releaseItem(
      context.req.param("id"),
      parsed.data.actor,
      context.req.header("Idempotency-Key"),
    );
    return context.json({ item });
  });

  app.post("/api/items/:id/complete", async (context) => {
    const parsed = actorActionSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    expireClaims(store);
    const item = store.completeItem(
      context.req.param("id"),
      parsed.data.actor,
      parsed.data.summary,
      context.req.header("Idempotency-Key"),
    );
    return context.json({ item });
  });

  app.post("/api/items/:id/events", async (context) => {
    const parsed = recordEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const event = store.recordEvent({
      itemId: context.req.param("id"),
      actor: parsed.data.actor,
      type: parsed.data.type,
      payload: parsed.data.payload,
      idempotencyKey: context.req.header("Idempotency-Key"),
    });
    return context.json({ event }, 201);
  });

  return app;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validationError(
  context: Context,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
) {
  return context.json({
    error: "Invalid request",
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  }, 400);
}
