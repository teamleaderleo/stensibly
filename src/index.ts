import { createServerApp } from "./server-app.ts";
import { StensiblyStore } from "./store.ts";

const port = Number(Bun.env.PORT ?? 3000);
const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
const requireAuth = Bun.env.STENSIBLY_REQUIRE_AUTH === "true";
const allowedOrigins = splitList(Bun.env.STENSIBLY_ALLOWED_ORIGINS);
const allowedHosts = splitList(Bun.env.STENSIBLY_ALLOWED_HOSTS);
const store = new StensiblyStore(databasePath);
const app = createServerApp(store, {
  httpAuth: { required: requireAuth },
  corsOrigins: allowedOrigins,
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
console.log(`Database: ${databasePath}`);
console.log(`HTTP auth: ${requireAuth ? "required" : "disabled"}`);
console.log(`Allowed remote origins: ${allowedOrigins.length ? allowedOrigins.join(", ") : "none"}`);
console.log("Remote MCP: /mcp (Bearer token always required)");

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
