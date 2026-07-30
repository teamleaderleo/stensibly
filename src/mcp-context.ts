import type { TokenPrincipal } from "./token-contracts.js";

export interface McpRequestContext {
  principal?: TokenPrincipal;
}
