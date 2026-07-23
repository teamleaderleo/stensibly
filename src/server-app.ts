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

export interface ServerAppOptions {
  httpAuth?: HttpAuthOptions;
  mcp?: McpHttpOptions;
  ledger?: WorkLedger;
  corsOrigins?: string[];
}

export function createServerApp(
  store: StensiblyStore,
  options: ServerAppOptions = {},
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const ledger = options.ledger ?? options.mcp?.ledger ?? new SqliteWorkLedger(store);

  app.use("/api/*", createCorsMiddleware(options.corsOrigins ?? []));

  app.all("/mcp", (context) =>
    handleMcpHttpRequest(store, context.req.raw, {
      ...options.mcp,
      ledger,
    }),
  );

  app.route("/api/v1", createApiV1(store, ledger, options.httpAuth));
  app.route("/", createApp(store, options.httpAuth));
  return app;
}
