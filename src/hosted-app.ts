import { Hono } from "hono";
import { createApiV1 } from "./api-v1.js";
import { createConvexWorkLedgerFromEnv, type ConvexWorkLedger } from "./convex-ledger.js";
import { createCorsMiddleware } from "./cors.js";
import {
  ConvexHostedAccountService,
  type AccountRole,
} from "./hosted-account-service.js";
import {
  createHostedAuth,
  HttpGitHubOAuthClient,
  type HostedAuthOptions,
} from "./hosted-auth.js";
import type { HostedSessionHttpAuthOptions, StensiblyEnv } from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { handleMcpHttpRequest } from "./mcp-http.js";
import {
  ConvexTokenProvider,
  type ApiTokenAuthenticator,
} from "./token-provider.js";
import {
  FAILURE_CATEGORY_HEADER,
  type FailureCategory,
} from "./worker-observability.js";

export interface HostedAppOptions {
  ledger: WorkLedger;
  authenticator: ApiTokenAuthenticator;
  workspace?: string | null;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  hostedAuth?: HostedAuthOptions;
}

export function createHostedApp(options: HostedAppOptions): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const allowedOrigins = options.allowedOrigins ?? [];
  const sessionOrigins = options.hostedAuth?.allowedReturnOrigins ?? [];
  const hostedSession = hostedSessionOptions(options.hostedAuth);

  app.onError((_error, context) => {
    const category = failureCategoryForPath(context.req.path);
    context.header(FAILURE_CATEGORY_HEADER, category);
    return context.json({
      error: "Hosted gateway request failed",
      code: category,
    }, 500);
  });

  app.use("/api/*", createCorsMiddleware(allowedOrigins, sessionOrigins));
  app.get("/health", (context) => context.json({
    ok: true,
    service: "stensibly",
    backend: "convex",
    surfaces: options.hostedAuth ? ["api-v1", "mcp", "auth"] : ["api-v1", "mcp"],
  }));
  if (options.hostedAuth) app.route("/auth", createHostedAuth(options.hostedAuth));
  app.all("/mcp", (context) =>
    handleMcpHttpRequest(context.req.raw, {
      ledger: options.ledger,
      authenticator: options.authenticator,
      allowedOrigins,
      allowedHosts: options.allowedHosts,
    }),
  );
  app.route(
    "/api/v1",
    createApiV1(options.authenticator, options.ledger, {
      required: true,
      workspace: options.workspace ?? null,
      ...(hostedSession ? { hostedSession } : {}),
    }),
  );
  app.notFound((context) => context.json({
    error: "Not found",
    code: "not_found",
  }, 404));
  return app;
}

export function createHostedAppFromEnv(
  env: Record<string, string | undefined> = process.env,
): Hono<StensiblyEnv> {
  const ledger = createConvexWorkLedgerFromEnv(env);
  const authenticator = new ConvexTokenProvider({
    client: ledger.client,
    serviceSecret: ledger.serviceSecret,
    workspace: ledger.workspace,
  });
  return createHostedApp({
    ledger,
    authenticator,
    workspace: ledger.workspace,
    allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS),
    allowedHosts: splitList(env.STENSIBLY_ALLOWED_HOSTS),
    hostedAuth: hostedAuthFromEnv(ledger, env),
  });
}

function hostedSessionOptions(
  hostedAuth: HostedAuthOptions | undefined,
): HostedSessionHttpAuthOptions | undefined {
  if (!hostedAuth) return undefined;
  return {
    accountService: hostedAuth.accountService,
    allowedOrigins: hostedAuth.allowedReturnOrigins,
    ...(hostedAuth.now ? { now: hostedAuth.now } : {}),
  };
}

function hostedAuthFromEnv(
  ledger: ConvexWorkLedger,
  env: Record<string, string | undefined>,
): HostedAuthOptions | undefined {
  const clientId = trimmed(env.GITHUB_OAUTH_CLIENT_ID);
  const clientSecret = trimmed(env.GITHUB_OAUTH_CLIENT_SECRET);
  const authOrigin = trimmed(env.STENSIBLY_AUTH_ORIGIN);
  const returnOrigins = splitList(env.STENSIBLY_AUTH_RETURN_ORIGINS);
  const allowedGitHubSubjects = splitList(env.STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS);
  const configured = Boolean(
    clientId
    || clientSecret
    || authOrigin
    || env.STENSIBLY_AUTH_RETURN_ORIGINS
    || env.STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS
    || env.STENSIBLY_AUTH_BOOTSTRAP_ROLE
    || env.STENSIBLY_SESSION_MAX_AGE_SECONDS
  );
  if (!configured) return undefined;
  if (!clientId || !clientSecret || !authOrigin || !returnOrigins.length || !allowedGitHubSubjects.length) {
    throw new Error(
      "Hosted auth requires GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, "
      + "STENSIBLY_AUTH_ORIGIN, STENSIBLY_AUTH_RETURN_ORIGINS, and "
      + "STENSIBLY_AUTH_ALLOWED_GITHUB_SUBJECTS",
    );
  }

  return {
    accountService: new ConvexHostedAccountService({
      client: ledger.client,
      serviceSecret: ledger.serviceSecret,
      workspace: ledger.workspace,
    }),
    githubClient: new HttpGitHubOAuthClient({ clientId, clientSecret }),
    githubClientId: clientId,
    authOrigin,
    allowedReturnOrigins: returnOrigins,
    allowedGitHubSubjects,
    bootstrapRole: parseAccountRole(env.STENSIBLY_AUTH_BOOTSTRAP_ROLE),
    sessionMaxAgeSeconds: parseOptionalInteger(
      env.STENSIBLY_SESSION_MAX_AGE_SECONDS,
      "STENSIBLY_SESSION_MAX_AGE_SECONDS",
    ),
  };
}

function failureCategoryForPath(path: string): FailureCategory {
  if (path === "/mcp") return "mcp_failure";
  if (path === "/auth" || path.startsWith("/auth/")) return "auth_failure";
  if (path === "/api/v1" || path.startsWith("/api/v1/")) {
    return "convex_failure";
  }
  return "gateway_failure";
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function trimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseAccountRole(value: string | undefined): AccountRole {
  const normalized = trimmed(value)?.toLowerCase() ?? "owner";
  if (["owner", "admin", "member", "viewer"].includes(normalized)) {
    return normalized as AccountRole;
  }
  throw new Error("STENSIBLY_AUTH_BOOTSTRAP_ROLE must be owner, admin, member, or viewer");
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  const normalized = trimmed(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}
