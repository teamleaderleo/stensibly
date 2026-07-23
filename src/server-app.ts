import { Hono } from "hono";
import { createApiV1 } from "./api-v1.ts";
import { createApp } from "./app.ts";
import { createCorsMiddleware } from "./cors.ts";
import {
  createHttpAuthMiddleware,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.ts";
import type { WorkLedger } from "./ledger.ts";
import {
  handleMcpHttpRequest,
  type McpHttpOptions,
} from "./mcp-http.ts";
import { SqliteWorkLedger } from "./sqlite-ledger.ts";
import { StensiblyStore } from "./store.ts";
import type { ApiTokenAuthenticator } from "./token-provider.ts";

export interface ServerAppOptions {
  httpAuth?: HttpAuthOptions;
  mcp?: McpHttpOptions;
  ledger?: WorkLedger;
  authenticator?: ApiTokenAuthenticator;
  corsOrigins?: string[];
}

export function createServerApp(
  store: StensiblyStore,
  options: ServerAppOptions = {},
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const ledger = options.ledger ?? options.mcp?.ledger ?? new SqliteWorkLedger(store);
  const authOptions = options.httpAuth ?? { required: false };

  app.use("/api/*", createCorsMiddleware(options.corsOrigins ?? []));
  if (options.authenticator) {
    app.use(
      "/api/v1/*",
      createHttpAuthMiddleware(options.authenticator, authOptions),
    );
  }

  app.all("/mcp", (context) =>
    handleMcpHttpRequest(store, context.req.raw, {
      ...options.mcp,
      ledger,
      authenticator: options.authenticator ?? options.mcp?.authenticator,
    }),
  );

  app.route(
    "/api/v1",
    createApiV1(
      store,
      ledger,
      options.authenticator ? { required: false } : authOptions,
    ),
  );
  app.route("/", createApp(store, authOptions));
  return app;
}
