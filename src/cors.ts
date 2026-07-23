import type { MiddlewareHandler } from "hono";
import type { StensiblyEnv } from "./http-auth.js";

export function createCorsMiddleware(
  allowedOrigins: string[],
): MiddlewareHandler<StensiblyEnv> {
  const allowed = new Set(allowedOrigins);

  return async (context, next) => {
    const origin = context.req.header("Origin");
    if (!origin) {
      await next();
      return;
    }

    if (!allowed.has(origin)) {
      return context.json({ error: `Origin is not allowed: ${origin}` }, 403);
    }

    context.header("Access-Control-Allow-Origin", origin);
    context.header("Access-Control-Allow-Credentials", "false");
    context.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    context.header("Access-Control-Max-Age", "600");
    context.header("Vary", "Origin");

    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  };
}
