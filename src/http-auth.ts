import type { Context, MiddlewareHandler } from "hono";
import {
  principalCanAccessProject,
  principalHasScope,
  type TokenPrincipal,
} from "./token-contracts.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export interface StensiblyEnv {
  Variables: {
    principal: TokenPrincipal | null;
  };
}

export interface HttpAuthOptions {
  required: boolean;
}

export function createHttpAuthMiddleware(
  authenticator: ApiTokenAuthenticator,
  options: HttpAuthOptions,
): MiddlewareHandler<StensiblyEnv> {
  return async (context, next) => {
    if (!options.required || context.req.path === "/health") {
      if (context.get("principal") === undefined) {
        context.set("principal", null);
      }
      await next();
      return;
    }

    context.set("principal", null);
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
