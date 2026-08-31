import type { SuccessfulMcpReadObserver } from "./mcp-successful-read-observation.js";
import type { McpToolObserver } from "./mcp-tool-observation.js";
import type { TokenPrincipal } from "./token-contracts.js";

export interface McpRequestContext {
  principal?: TokenPrincipal;
  requestId?: string | null;
  onSuccessfulReadToolCall?: SuccessfulMcpReadObserver;
  onToolCall?: McpToolObserver;
}
