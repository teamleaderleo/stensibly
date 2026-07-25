import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type {
  AccountRole,
  HostedAccountService,
} from "./hosted-account-service.js";
import {
  HOSTED_SESSION_COOKIE,
  parseHostedSessionCredential,
} from "./hosted-session-credential.js";
import {
  evaluateSessionRequestSecurity,
  type HttpAuthenticationMode,
} from "./session-request-security.js";
import {
  principalCanAccessProject,
  principalHasScope,
  type AuthorizationPrincipal,
  type TokenPrincipal,
  type TokenScope,
} from "./token-contracts.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";
import { FAILURE_CATEGORY_HEADER } from "./worker-observability.js";

export interface ApiTokenHttpPrincipal extends TokenPrincipal {
  kind: "api_token";
}

export interface AccountHttpPrincipal extends AuthorizationPrincipal {
  kind: "account";
  accountId: string;
  workspace: string;
  role: AccountRole;
}

export type HttpPrincipal = ApiTokenHttpPrincipal | AccountHttpPrincipal;

export interface StensiblyEnv {
  Variables: {
    principal: HttpPrincipal | null;
    authenticationMode: HttpAuthenticationMode;
  };
}

export interface HostedSessionHttpAuthOptions {
  accountService: Pick<HostedAccountService, "authenticateSession">;
  allowedOrigins: readonly string[];
  now?: () => number;
}

export interface HttpAuthOptions {
  required: boolean;
  hostedSession?: HostedSessionHttpAuthOptions;
}

export function createHttpAuthMiddleware(
  authenticator: ApiTokenAuthenticator,
  options: HttpAuthOptions,
): MiddlewareHandler<StensiblyEnv> {
  return async (context, next) => {
    context.set("principal", null);
    context.set("authenticationMode", "anonymous");

    if (!options.required || context.req.path === "/health") {
      await next();
      return;
    }

    const authorization = context.req.header("Authorization");
    if (authorization !== undefined) {
      const token = parseBearerToken(authorization);
      if (!token) return unauthorized(context, false);

      let principal: TokenPrincipal | null;
      try {
        principal = await authenticator.authenticate(token);
      } catch {
        context.header(FAILURE_CATEGORY_HEADER, "convex_failure");
        return context.json({
          error: "Hosted token authority failed",
          code: "backend_failure",
        }, 502);
      }
      if (!principal) return unauthorized(context, false);

      context.set("principal", { kind: "api_token", ...principal });
      context.set("authenticationMode", "bearer");
      await next();
      return;
    }

    if (options.hostedSession) {
      const rawCookie = getCookie(context, HOSTED_SESSION_COOKIE);
      const credential = await parseHostedSessionCredential(rawCookie);
      if (credential) {
        let resolved;
        try {
          resolved = await options.hostedSession.accountService.authenticateSession({
            id: credential.id,
            secretHash: credential.secretHash,
            now: (options.hostedSession.now ?? Date.now)(),
          });
        } catch {
          context.header(FAILURE_CATEGORY_HEADER, "convex_failure");
          return context.json({
            error: "Hosted session authority failed",
            code: "backend_failure",
          }, 502);
        }

        if (resolved) {
          const scopes = resolved.principal.scopes as TokenScope[];
          context.set("principal", {
            kind: "account",
            accountId: resolved.principal.accountId,
            name: resolved.principal.name,
            workspace: resolved.principal.workspace,
            role: resolved.principal.role,
            scopes: [...scopes],
            projects: resolved.principal.projects === null
              ? null
              : [...resolved.principal.projects],
          });
          context.set("authenticationMode", "session");

          const rejection = evaluateSessionRequestSecurity({
            method: context.req.method,
            authenticationMode: "session",
            origin: context.req.header("Origin"),
            allowedOrigins: options.hostedSession.allowedOrigins,
          });
          if (rejection) {
            context.header(FAILURE_CATEGORY_HEADER, "cors_rejection");
            return context.json({ error: rejection.error, code: rejection.code }, rejection.status);
          }

          await next();
          return;
        }
      }
      return unauthorized(context, true);
    }

    return unauthorized(context, false);
  };
}

export function requireHttpAccess(
  context: Context<StensiblyEnv>,
  required: TokenScope,
  project?: string,
): Response | null {
  const principal = context.get("principal");
  if (!principal) return null;

  const label = principal.kind === "account" ? "Account" : "Token";
  const hasRequiredScope = required === "admin"
    ? principal.scopes.includes("admin")
    : principalHasScope(principal, required);
  if (!hasRequiredScope) {
    context.header(FAILURE_CATEGORY_HEADER, "authorization_failure");
    return context.json({ error: `${label} requires ${required} scope` }, 403);
  }
  if (project && !principalCanAccessProject(principal, project)) {
    context.header(FAILURE_CATEGORY_HEADER, "authorization_failure");
    return context.json({ error: `${label} cannot access project ${project}` }, 403);
  }
  return null;
}

export function currentPrincipal(
  context: Context<StensiblyEnv>,
): HttpPrincipal | null {
  return context.get("principal");
}

export function currentAuthenticationMode(
  context: Context<StensiblyEnv>,
): HttpAuthenticationMode {
  return context.get("authenticationMode");
}

function unauthorized(
  context: Context<StensiblyEnv>,
  acceptsHostedSession: boolean,
) {
  context.header("WWW-Authenticate", "Bearer");
  context.header(FAILURE_CATEGORY_HEADER, "auth_failure");
  return context.json({
    error: acceptsHostedSession
      ? "A valid Bearer token or hosted session is required"
      : "A valid Bearer token is required",
  }, 401);
}

function parseBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}
