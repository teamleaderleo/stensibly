import type { Context, MiddlewareHandler } from "hono";
import {
  principalCanAccessProject,
  principalHasScope,
  type TokenPrincipal,
} from "./auth.ts";
import { StensiblyStore } from "./store.ts";
import {
  SqliteTokenProvider,
  type ApiTokenAuthenticator,
} from "./token-provider.ts";

export interface StensiblyEnv {
  Variables: {
    principal: TokenPrincipal | null;
  };
}

export interface HttpAuthOptions {
  required: boolean;
}

export function createHttpAuthMiddleware(
  source: StensiblyStore | ApiTokenAuthenticator,
  options: HttpAuthOptions,
): MiddlewareHandler<StensiblyEnv> {
  const authenticator = source instanceof StensiblyStore
    ? new SqliteTokenProvider(source)
    : source;
  return async (context, next) => {
    context.set("principal", null);
    if (!options.required || context.req.path === "/health") {
      await next();
      return;
    }

    const authorization = context.req.header("Authorization");
    const token = parseBearerToken(authorization);
    const principal = token ? await authenticator.authenticate(token) : null;
    if (!principal) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: "A valid Bearer token is required" }, 401);
    }

    context.set("principal", principal);
    await next();
  };
}

export function requireHttpAccess(
  context: Context<StensiblyEnv>,
  required: "read" | "write",
  project?: string,
): Response | null {
  const principal = context.get("principal");
  if (!principal) return null;

  if (!principalHasScope(principal, required)) {
    return context.json({ error: `Token requires ${required} scope` }, 403);
  }
  if (project && !principalCanAccessProject(principal, project)) {
    return context.json({ error: `Token cannot access project ${project}` }, 403);
  }
  return null;
}

export function currentPrincipal(
  context: Context<StensiblyEnv>,
): TokenPrincipal | null {
  return context.get("principal");
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}
