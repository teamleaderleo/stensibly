import { Hono } from "hono";
import { createApiV1 } from "./api-v1.js";
import { createApp } from "./app.js";
import { createContextPacketApi } from "./context-api.js";
import { createCorsMiddleware } from "./cors.js";
import type { HttpAuthOptions, StensiblyEnv } from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import {
  handleMcpHttpRequest,
  type McpHttpOptions,
} from "./mcp-http.js";
import {
  handleRunnerMcpHttpRequest,
  type RunnerMcpHttpOptions,
} from "./runner-mcp-http.js";
import { SqliteWorkLedger } from "./sqlite-ledger.js";
import { SqliteTokenProvider } from "./sqlite-token-provider.js";
import { StensiblyStore } from "./store.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export interface ServerAppOptions {
  httpAuth?: HttpAuthOptions;
  mcp?: Omit<McpHttpOptions, "ledger" | "authenticator">;
  runnerMcp?: Omit<RunnerMcpHttpOptions, "ledger" | "authenticator">;
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
  app.all("/runner/mcp", (context) =>
    handleRunnerMcpHttpRequest(context.req.raw, {
      ...options.runnerMcp,
      ledger,
      authenticator,
    }),
  );

  app.route("/api/v1", createApiV1(authenticator, ledger, authOptions));
  app.route("/api/v1", createContextPacketApi(authenticator, ledger, authOptions));
  app.route("/", createApp(store, authOptions));
  return app;
}
