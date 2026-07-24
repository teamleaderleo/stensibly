import { createConvexWorkLedgerFromEnv } from "./convex-ledger.js";
import type { WorkLedger } from "./ledger.js";
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
  httpAuth: { required: requireAuth },
  corsOrigins: allowedOrigins,
  ledger,
  authenticator,
  mcp: {
    allowedOrigins,
    allowedHosts,
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
console.log("Remote MCP: /mcp (Bearer token always required)");

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
