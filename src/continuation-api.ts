import type { Hono } from "hono";
import {
  continuationLedger,
  listContinuationsSchema,
  proposeContinuationSchema,
  resolveContinuationSchema,
} from "./continuation-contracts.js";
import {
  requireHttpAccess,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";

export function registerContinuationApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
): void {
  app.post("/items/:id/continuations", async (context) => {
    const continuations = continuationLedger(ledger);
    if (!continuations) return unavailable(context);
    const sourceItemId = context.req.param("id");
    const detail = await ledger.getItem(sourceItemId);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = proposeContinuationSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const continuation = await continuations.proposeContinuation({
      sourceItemId,
      ...parsed.data,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ continuation }, 201);
  });

  app.get("/items/:id/continuations", async (context) => {
    const continuations = continuationLedger(ledger);
    if (!continuations) return unavailable(context);
    const sourceItemId = context.req.param("id");
    const detail = await ledger.getItem(sourceItemId);
    const denied = requireHttpAccess(context, "read", detail.item.project);
    if (denied) return denied;
    const parsed = listContinuationsSchema.safeParse({
      status: context.req.query("status"),
      deliveryMode: context.req.query("deliveryMode"),
    });
    if (!parsed.success) return validationError(context, parsed.error.issues);
    return context.json({
      continuations: await continuations.listContinuations({
        sourceItemId,
        ...parsed.data,
      }),
    });
  });

  app.get("/continuations/:id", async (context) => {
    const continuations = continuationLedger(ledger);
    if (!continuations) return unavailable(context);
    const continuation = await continuations.getContinuation(context.req.param("id"));
    const detail = await ledger.getItem(continuation.sourceItemId);
    const denied = requireHttpAccess(context, "read", detail.item.project);
    if (denied) return denied;
    return context.json({ continuation });
  });

  app.post("/continuations/:id/resolve", async (context) => {
    const continuations = continuationLedger(ledger);
    if (!continuations) return unavailable(context);
    const id = context.req.param("id");
    const current = await continuations.getContinuation(id);
    const detail = await ledger.getItem(current.sourceItemId);
    const denied = requireHttpAccess(context, "write", detail.item.project);
    if (denied) return denied;
    const parsed = resolveContinuationSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    const continuation = await continuations.resolveContinuation({
      id,
      ...parsed.data,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return context.json({ continuation });
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validationError(
  context: Parameters<Hono<StensiblyEnv>["get"]>[1] extends (...args: infer A) => unknown ? A[0] : never,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
) {
  return context.json({
    error: "Invalid request",
    code: "invalid_request",
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  }, 400);
}

function unavailable(
  context: Parameters<Hono<StensiblyEnv>["get"]>[1] extends (...args: infer A) => unknown ? A[0] : never,
) {
  return context.json({
    error: "Continuation proposals are unavailable on this backend",
    code: "unsupported_feature",
  }, 501);
}
