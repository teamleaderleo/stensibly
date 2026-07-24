import type { WorkLedger } from "./ledger.js";
import { createMcpServer } from "./mcp.js";
import { registerContinuationCardApp } from "./continuation-card-app.js";

export function createChatGptMcpServer(ledger: WorkLedger) {
  const server = createMcpServer(ledger);
  registerContinuationCardApp(server, ledger);
  return server;
}
