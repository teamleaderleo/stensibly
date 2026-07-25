import { Hono, type Context } from "hono";
import { z } from "zod";
import { buildRunnerContextPacket } from "./context-packets.js";
import {
  createHttpAuthMiddleware,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

const contextQuerySchema = z.object({
  maxEvents: optionalInteger(1, 100),
  maxArtifacts: optionalInteger(0, 50),
  maxRuns: optionalInteger(0, 25),
  maxDependencies: optionalInteger(0, 100),
  maxCharacters: optionalInteger(2_000, 50_000),
});

export function createContextPacketApi(
  authenticator: ApiTokenAuthenticator,
  ledger: WorkLedger,
  options: HttpAuthOptions = { required: false },
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();

  app.onError((error, context) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/does not exist|not found/i.test(message)) {
      return context.json({ error: message, code: "not_found" }, 404);
    }
    return context.json({ error: message, code: "invalid_operation" }, 400);
  });

  app.use("*", createHttpAuthMiddleware(authenticator, options));
  app.get("/items/:id/context", async (context) => {
    const id = context.req.param("id");
    const detail = await ledger.getItem(id);
    const denied = requireHttpAccess(context, "read", detail.item.project);
    if (denied) return denied;

    const parsed = contextQuerySchema.safeParse({
      maxEvents: context.req.query("maxEvents"),
      maxArtifacts: context.req.query("maxArtifacts"),
      maxRuns: context.req.query("maxRuns"),
      maxDependencies: context.req.query("maxDependencies"),
      maxCharacters: context.req.query("maxCharacters"),
    });
    if (!parsed.success) return validationError(context, parsed.error.issues);

    return context.json({
      packet: buildRunnerContextPacket(detail, parsed.data),
    });
  });

  return app;
}

function optionalInteger(minimum: number, maximum: number) {
  return z.preprocess(
    (value) => value === undefined || value === "" ? undefined : Number(value),
    z.number().int().min(minimum).max(maximum).optional(),
  );
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
