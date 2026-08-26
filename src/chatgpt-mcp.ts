import type { WorkLedger } from "./ledger.js";
import type { McpCapabilityExposureProfile } from "./mcp-exposure-selection.js";
import { createMcpServer } from "./mcp.js";
import { registerContinuationCardApp } from "./continuation-card-app.js";

export interface ChatGptMcpServerOptions {
  exposureProfile?: McpCapabilityExposureProfile;
}

export function createChatGptMcpServer(
  ledger: WorkLedger,
  options: ChatGptMcpServerOptions = {},
) {
  const exposureProfile = options.exposureProfile ?? "published_default";
  const server = createMcpServer(
    ledger,
    {},
    { exposureProfile },
  );
  if (exposureProfile === "full_internal") {
    registerContinuationCardApp(server, ledger);
  }
  return server;
}
