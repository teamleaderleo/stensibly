import { Hono } from "hono";
import { createApiV1 } from "./api-v1.js";
import { createConvexWorkLedgerFromEnv } from "./convex-ledger.js";
import { createCorsMiddleware } from "./cors.js";
import type { StensiblyEnv } from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { handleMcpHttpRequest } from "./mcp-http.js";
import {
  ConvexTokenProvider,
  type ApiTokenAuthenticator,
} from "./token-provider.js";

export interface HostedAppOptions {
  ledger: WorkLedger;
  authenticator: ApiTokenAuthenticator;
  allowedOrigins?: string[];
  allowedHosts?: string[];
}

export function createHostedApp(options: HostedAppOptions): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const allowedOrigins = options.allowedOrigins ?? [];

  app.use("/api/*", createCorsMiddleware(allowedOrigins));
  app.get("/health", (context) => context.json({
    ok: true,
    service: "stensibly",
    backend: "convex",
    surfaces: ["api-v1", "mcp"],
  }));
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
    createApiV1(options.authenticator, options.ledger, { required: true }),
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
    allowedOrigins: splitList(env.STENSIBLY_ALLOWED_ORIGINS),
    allowedHosts: splitList(env.STENSIBLY_ALLOWED_HOSTS),
  });
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
