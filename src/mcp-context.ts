import type { SuccessfulMcpReadObserver } from "./mcp-successful-read-observation.js";
import type { TokenPrincipal } from "./token-contracts.js";

export interface McpRequestContext {
  principal?: TokenPrincipal;
  onSuccessfulReadToolCall?: SuccessfulMcpReadObserver;
}
