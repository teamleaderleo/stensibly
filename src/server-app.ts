import { Hono } from "hono";
import { createApiV1 } from "./api-v1.ts";
import { createApp } from "./app.ts";
import { createCorsMiddleware } from "./cors.ts";
import type { HttpAuthOptions, StensiblyEnv } from "./http-auth.ts";
import type { WorkLedger } from "./ledger.ts";
import {
  handleMcpHttpRequest,
  type McpHttpOptions,
} from "./mcp-http.ts";
import { SqliteWorkLedger } from "./sqlite-ledger.ts";
import { StensiblyStore } from "./store.ts";
import {
  SqliteTokenProvider,
  type ApiTokenAuthenticator,
} from "./token-provider.ts";

export interface ServerAppOptions {
  httpAuth?: HttpAuthOptions;
  mcp?: Omit<McpHttpOptions, "ledger" | "authenticator">;
  ledger?: WorkLedger;
  authenticator?: ApiTokenAuthenticator;
  corsOrigins?: string[];
}

export function createServerApp(
  store: StensiblyStore,
  options: ServerAppOptions = {},
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const ledger = options.ledger ?? new SqliteWorkLedger(store);
  const authenticator = options.authenticator ?? new SqliteTokenProvider(store);
  const authOptions = options.httpAuth ?? { required: false };

  app.use("/api/*", createCorsMiddleware(options.corsOrigins ?? []));

  app.all("/mcp", (context) =>
    handleMcpHttpRequest(context.req.raw, {
      ...options.mcp,
      ledger,
      authenticator,
    }),
  );

  app.route("/api/v1", createApiV1(authenticator, ledger, authOptions));
  app.route("/", createApp(store, authOptions));
  return app;
}
