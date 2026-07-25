import type { MiddlewareHandler } from "hono";
import type { StensiblyEnv } from "./http-auth.js";
import {
  FAILURE_CATEGORY_HEADER,
  REQUEST_ID_HEADER,
} from "./worker-observability.js";

export function createCorsMiddleware(
  allowedOrigins: readonly string[],
  credentialedOrigins: readonly string[] = [],
): MiddlewareHandler<StensiblyEnv> {
  const allowed = normalizedOriginSet([...allowedOrigins, ...credentialedOrigins]);
  const credentialed = normalizedOriginSet(credentialedOrigins);

  return async (context, next) => {
    const rawOrigin = context.req.header("Origin");
    if (!rawOrigin) {
      await next();
      return;
    }

    const origin = normalizeOrigin(rawOrigin);
    if (!origin || !allowed.has(origin)) {
      context.header(FAILURE_CATEGORY_HEADER, "cors_rejection");
      return context.json({ error: "Origin is not allowed" }, 403);
    }

    context.header("Access-Control-Allow-Origin", origin);
    context.header(
      "Access-Control-Allow-Credentials",
      credentialed.has(origin) ? "true" : "false",
    );
    context.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Idempotency-Key, X-Request-ID",
    );
    context.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    context.header("Access-Control-Expose-Headers", REQUEST_ID_HEADER);
    context.header("Access-Control-Max-Age", "600");
    context.header("Vary", "Origin");

    if (context.req.method === "OPTIONS") return context.body(null, 204);
    await next();
  };
}

function normalizedOriginSet(values: readonly string[]): Set<string> {
  const output = new Set<string>();
  for (const value of values) {
    const normalized = normalizeOrigin(value);
    if (normalized) output.add(normalized);
  }
  return output;
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
