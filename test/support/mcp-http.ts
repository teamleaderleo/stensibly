import type { JsonRpcMessage } from "@modelcontextprotocol/sdk/types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpRequestTarget {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

export interface McpInitializeOptions {
  clientName?: string;
  clientVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface McpToolResultPayload {
  result?: {
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
}

export function mcpHeaders(
  token: string | null,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extraHeaders,
  };
}

export function initializeMessage(
  id: number | string,
  options: McpInitializeOptions = {},
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: options.capabilities ?? {},
      clientInfo: {
        name: options.clientName ?? "stensibly-test",
        version: options.clientVersion ?? "0.0.1",
      },
    },
  };
}

export function toolCall(
  id: number | string,
  name: string,
  args: Record<string, unknown>,
): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

export function toolsListMessage(id: number | string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: {},
  };
}

export async function mcpRequest(
  app: McpRequestTarget,
  token: string | null,
  body: JsonRpcMessage | Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: mcpHeaders(token, extraHeaders),
    body: JSON.stringify(body),
  });
}

export async function readToolText(response: Response): Promise<string> {
  const body = await response.json() as McpToolResultPayload;
  const first = body.result?.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error(
      `Remote MCP response ${response.status} did not contain a text tool result`,
    );
  }
  return first.text;
}

export async function readToolJson<T>(response: Response): Promise<T> {
  const text = await readToolText(response);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Remote MCP text result was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function callToolJson<T>(
  app: McpRequestTarget,
  token: string,
  id: number | string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await mcpRequest(app, token, toolCall(id, name, args));
  if (response.status !== 200) {
    const body = await response.text().catch(() => "<unreadable response>");
    throw new Error(
      `Remote MCP tool ${name} returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return await readToolJson<T>(response);
}
