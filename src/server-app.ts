import { Hono } from "hono";
import { createApp } from "./app.ts";
import { createCorsMiddleware } from "./cors.ts";
import type { HttpAuthOptions, StensiblyEnv } from "./http-auth.ts";
import {
  handleMcpHttpRequest,
  type McpHttpOptions,
} from "./mcp-http.ts";
import { StensiblyStore } from "./store.ts";

export interface ServerAppOptions {
  httpAuth?: HttpAuthOptions;
  mcp?: McpHttpOptions;
  corsOrigins?: string[];
}

export function createServerApp(
  store: StensiblyStore,
  options: ServerAppOptions = {},
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();

  app.use("/api/*", createCorsMiddleware(options.corsOrigins ?? []));

  app.all("/mcp", (context) =>
    handleMcpHttpRequest(store, context.req.raw, options.mcp),
  );

  app.route("/", createApp(store, options.httpAuth));
  return app;
}
