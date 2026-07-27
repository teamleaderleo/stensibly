import { createConvexWorkLedgerFromEnv } from "./convex-ledger.js";
import type { WorkLedger } from "./ledger.js";
import { defaultRunnerConcurrencyPolicy } from "./runner-concurrency.js";
import { createServerApp } from "./server-app.js";
import { SqliteWorkLedger } from "./sqlite-ledger.js";
import { SqliteTokenProvider } from "./sqlite-token-provider.js";
import { StensiblyStore } from "./store.js";
import {
  ConvexTokenProvider,
  type ApiTokenAuthenticator,
} from "./token-provider.js";

const port = Number(Bun.env.PORT ?? 3000);
const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
const requireAuth = Bun.env.STENSIBLY_REQUIRE_AUTH === "true";
const allowedOrigins = splitList(Bun.env.STENSIBLY_ALLOWED_ORIGINS);
const allowedHosts = splitList(Bun.env.STENSIBLY_ALLOWED_HOSTS);
const backend = Bun.env.STENSIBLY_BACKEND ?? "sqlite";
const githubWebhookSecret = Bun.env.STENSIBLY_GITHUB_WEBHOOK_SECRET?.trim();
const runnerGlobalConcurrency = positiveIntegerEnv(
  Bun.env.STENSIBLY_RUNNER_GLOBAL_CONCURRENCY,
  defaultRunnerConcurrencyPolicy.globalLimit,
  "STENSIBLY_RUNNER_GLOBAL_CONCURRENCY",
);
const runnerProjectConcurrency = positiveIntegerEnv(
  Bun.env.STENSIBLY_RUNNER_PROJECT_CONCURRENCY,
  defaultRunnerConcurrencyPolicy.projectLimit,
  "STENSIBLY_RUNNER_PROJECT_CONCURRENCY",
);
const store = new StensiblyStore(databasePath);
let ledger: WorkLedger;
let authenticator: ApiTokenAuthenticator;

if (backend === "convex") {
  const convexLedger = createConvexWorkLedgerFromEnv();
  ledger = convexLedger;
  authenticator = new ConvexTokenProvider({
    client: convexLedger.client,
    serviceSecret: convexLedger.serviceSecret,
    workspace: convexLedger.workspace,
  });
} else if (backend === "sqlite") {
  ledger = new SqliteWorkLedger(store);
  authenticator = new SqliteTokenProvider(store);
} else {
  throw new Error(`Unknown STENSIBLY_BACKEND: ${backend}`);
}

const app = createServerApp(store, {
  backend,
  httpAuth: { required: requireAuth },
  corsOrigins: allowedOrigins,
  ledger,
  authenticator,
  ...(githubWebhookSecret
    ? { githubWebhook: { secret: githubWebhookSecret } }
    : {}),
  mcp: {
    allowedOrigins,
    allowedHosts,
  },
  runnerMcp: {
    allowedOrigins,
    allowedHosts,
    concurrency: {
      globalLimit: runnerGlobalConcurrency,
      projectLimit: runnerProjectConcurrency,
    },
  },
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Stensibly is loitering at http://localhost:${port}`);
console.log(`Legacy SQLite database: ${databasePath}`);
console.log(`HTTP auth: ${requireAuth ? "required" : "disabled"}`);
console.log(`Allowed remote origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "none"}`);
console.log(`API v1, token authority, and MCP backend: ${backend}`);
console.log(`GitHub webhook intake: ${githubWebhookSecret ? "enabled" : "disabled"}`);
console.log("Remote MCP: /mcp (Bearer token always required)");
console.log("Runner MCP: /runner/mcp (Bearer token always required)");
console.log(
  `Runner concurrency: ${runnerGlobalConcurrency} global, ${runnerProjectConcurrency} per project`,
);

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function positiveIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 1_000) {
    throw new Error(`${name} must be a whole number from 1 to 1000`);
  }
  return normalized;
}
