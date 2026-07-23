import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp.ts";
import { StensiblyStore } from "./store.ts";

const databasePath = Bun.env.STENSIBLY_DB ?? "stensibly.sqlite";
const store = new StensiblyStore(databasePath);
const server = createMcpServer(store);

async function close(): Promise<void> {
  await server.close();
  store.close();
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
  console.error(`Stensibly MCP is using ${databasePath}`);
} catch (error) {
  console.error("Stensibly MCP failed to start", error);
  store.close();
  process.exit(1);
}
