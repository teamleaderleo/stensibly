import type { WorkLedger } from "./ledger.js";
import { createMcpServer } from "./mcp.js";
import { registerContinuationCardApp } from "./continuation-card-app.js";
import { registerDecisionInboxTool } from "./decision-inbox-mcp.js";

export function createChatGptMcpServer(ledger: WorkLedger) {
  const server = createMcpServer(ledger);
  registerDecisionInboxTool(server, ledger);
  registerContinuationCardApp(server, ledger);
  return server;
}
