import { Hono } from "hono";
import {
  actorActionSchema,
  claimItemSchema,
  createItemSchema,
  itemStatuses,
  recordEventSchema,
} from "./schemas.ts";
import {
  ConflictError,
  NotFoundError,
  type ItemStatus,
  StensiblyStore,
} from "./store.ts";
import { renderBoard } from "./view.ts";

export function createApp(store: StensiblyStore): Hono {
  const app = new Hono();

  app.onError((error, context) => {
    if (error instanceof NotFoundError) {
      return context.json({ error: error.message }, 404);
    }
    if (error instanceof ConflictError) {
      return context.json({ error: error.message }, 409);
    }

    console.error(error);
    return context.json({ error: "Something went catastrophically off the rails" }, 500);
  });

  app.get("/", (context) => context.html(renderBoard(store.listItems())));

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "stensibly",
    }),
  );

  app.get("/api/items", (context) => {
    const project = context.req.query("project");
    const statusValue = context.req.query("status");
    const status = statusValue && itemStatuses.includes(statusValue as ItemStatus)
      ? (statusValue as ItemStatus)
      : undefined;

    if (statusValue && !status) {
      return context.json({ error: `Unknown status: ${statusValue}` }, 400);
    }

    return context.json({ items: store.listItems({ project, status }) });
  });

  app.post("/api/items", async (context) => {
    const parsed = createItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);

    const item = store.createItem(parsed.data, context.req.header("Idempotency-Key"));
    return context.json({ item }, 201);
  });

  app.get("/api/items/:id", (context) =>
    context.json({
      item: store.getItem(context.req.param("id")),
      events: store.listEvents(context.req.param("id")),
    }),
  );

  app.post("/api/items/:id/claim", async (context) => {
    const parsed = claimItemSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);

    const item = store.claimItem(
      context.req.param("id"),
      parsed.data.actor,
      parsed.data.leaseSeconds,
      context.req.header("Idempotency-Key"),
    );
    return context.json({ item });
  });

  app.post("/api/items/:id/release", async (context) => {
    const parsed = actorActionSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);

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
  context: Parameters<Parameters<Hono["onError"]>[0]>[1],
  issues: Array<{ path: PropertyKey[]; message: string }>,
) {
  return context.json(
    {
      error: "Invalid request",
      issues: issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    400,
  );
}
