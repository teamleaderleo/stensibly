import { Hono } from "hono";
import { createApiV1 } from "./api-v1.js";
import { createApp } from "./app.js";
import { createContextPacketApi } from "./context-api.js";
import { createCorsMiddleware } from "./cors.js";
import {
  registerGitHubProviderEventRoutes,
  type GitHubWebhookOptions,
} from "./github-webhook-api.js";
import type { HttpAuthOptions, StensiblyEnv } from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import {
  handleMcpHttpRequest,
  type McpHttpOptions,
} from "./mcp-http.js";
import type {
  ProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation.js";
import {
  SqliteProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation-sqlite.js";
import { normalizeRunnerConcurrencyPolicy } from "./runner-concurrency.js";
import {
  handleRunnerMcpHttpRequest,
  type RunnerMcpHttpOptions,
} from "./runner-mcp-http.js";
import {
  createProjectSetupStatusApi,
  type ProjectSetupStatusObserver,
} from "./setup-status-api.js";
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
  backend?: "sqlite" | "convex";
  githubWebhook?: GitHubWebhookOptions;
  setupStatusObserver?: ProjectSetupStatusObserver;
  repositorySetupObservations?: ProjectRepositorySetupObservationLedger | null;
}

export function createServerApp(
  store: StensiblyStore,
  options: ServerAppOptions = {},
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const ledger = options.ledger ?? new SqliteWorkLedger(store);
  const authenticator = options.authenticator ?? new SqliteTokenProvider(store);
  const authOptions = options.httpAuth ?? { required: false };
  const runnerMcpOptions = {
    ...options.runnerMcp,
    concurrency: normalizeRunnerConcurrencyPolicy(options.runnerMcp?.concurrency),
  };
  const repositorySetupObservations = options.repositorySetupObservations
    ?? (options.ledger === undefined && options.backend !== "convex"
      ? new SqliteProjectRepositorySetupObservationLedger(store)
      : null);

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
      ...runnerMcpOptions,
      ledger,
      authenticator,
    }),
  );

  if (options.githubWebhook) {
    const providerEventBackend = options.backend
      ?? (options.ledger === undefined && options.authenticator === undefined
        ? "sqlite"
        : null);
    if (providerEventBackend !== "sqlite") {
      throw new Error(
        "GitHub provider event persistence requires the SQLite backend to be explicit",
      );
    }
    registerGitHubProviderEventRoutes(
      app,
      store,
      authenticator,
      authOptions,
      options.githubWebhook,
    );
  }

  if (options.setupStatusObserver) {
    app.route(
      "/api/v1",
      createProjectSetupStatusApi(
        authenticator,
        ledger,
        authOptions,
        options.setupStatusObserver,
        repositorySetupObservations,
      ),
    );
  }
  app.route("/api/v1", createApiV1(authenticator, ledger, authOptions));
  app.route("/api/v1", createContextPacketApi(authenticator, ledger, authOptions));
  app.route("/", createApp(store, authOptions));
  return app;
}
