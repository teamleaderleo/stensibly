import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConvexWorkLedgerFromEnv } from "./convex-ledger.ts";
import type { WorkLedger } from "./ledger.ts";
import { createMcpServer } from "./mcp.ts";
import { SqliteWorkLedger } from "./sqlite-ledger.ts";
import { StensiblyStore } from "./store.ts";

const backend = Bun.env.STENSIBLY_BACKEND ?? "sqlite";
const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
let store: StensiblyStore | null = null;
let ledger: WorkLedger;
let backendDescription: string;

if (backend === "convex") {
  ledger = createConvexWorkLedgerFromEnv();
  backendDescription = `Convex workspace ${Bun.env.STENSIBLY_WORKSPACE ?? "default"}`;
} else if (backend === "sqlite") {
  store = new StensiblyStore(databasePath);
  ledger = new SqliteWorkLedger(store);
  backendDescription = `SQLite ${databasePath}`;
} else {
  throw new Error(`Unknown STENSIBLY_BACKEND: ${backend}`);
}

const server = createMcpServer(ledger);

async function close(): Promise<void> {
  await server.close();
  store?.close();
}

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Stensibly MCP is using ${backendDescription}`);
} catch (error) {
  console.error("Stensibly MCP failed to start", error);
  store?.close();
  process.exit(1);
}
