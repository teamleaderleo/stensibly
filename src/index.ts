import { createConvexWorkLedgerFromEnv } from "./convex-ledger.ts";
import { createServerApp } from "./server-app.ts";
import { SqliteWorkLedger } from "./sqlite-ledger.ts";
import { StensiblyStore } from "./store.ts";

const port = Number(Bun.env.PORT ?? 3000);
const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
const requireAuth = Bun.env.STENSIBLY_REQUIRE_AUTH === "true";
const allowedOrigins = splitList(Bun.env.STENSIBLY_ALLOWED_ORIGINS);
const allowedHosts = splitList(Bun.env.STENSIBLY_ALLOWED_HOSTS);
const backend = Bun.env.STENSIBLY_BACKEND ?? "sqlite";
const store = new StensiblyStore(databasePath);
const ledger = backend === "convex"
  ? createConvexWorkLedgerFromEnv()
  : backend === "sqlite"
    ? new SqliteWorkLedger(store)
    : failBackend(backend);
const app = createServerApp(store, {
  httpAuth: { required: requireAuth },
  corsOrigins: allowedOrigins,
  mcp: {
    allowedOrigins,
    allowedHosts,
    ledger,
  },
});

Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Stensibly is loitering at http://localhost:${port}`);
console.log(`Auth and legacy REST database: ${databasePath}`);
console.log(`HTTP auth: ${requireAuth ? "required" : "disabled"}`);
console.log(`Allowed remote origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "none"}`);
console.log(`Remote MCP backend: ${backend}`);
console.log("Remote MCP: /mcp (Bearer token always required)");

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function failBackend(value: string): never {
  throw new Error(`Unknown STENSIBLY_BACKEND: ${value}`);
}
