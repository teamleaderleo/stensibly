import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpRequestTarget {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

export interface McpInitializeOptions {
  clientName?: string;
  clientVersion?: string;
  capabilities?: Record<string, unknown>;
}

export interface JsonRpcResponsePayload<T> {
  id?: unknown;
  result?: T;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

export interface McpToolResult {
  isError?: boolean;
  content?: Array<{ type?: unknown; text?: unknown }>;
}

export interface McpToolEnvelope {
  isError: boolean;
  text: string;
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
): JSONRPCMessage {
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
): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

export function toolsListMessage(id: number | string): JSONRPCMessage {
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
  body: JSONRPCMessage | Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await app.request("/mcp", {
    method: "POST",
    headers: mcpHeaders(token, extraHeaders),
    body: JSON.stringify(body),
  });
}

export async function readJsonRpcResult<T>(
  response: Response,
  expectedId?: number | string,
): Promise<T> {
  const payload = await response.json() as JsonRpcResponsePayload<T>;
  if (expectedId !== undefined && payload.id !== expectedId) {
    throw new Error(
      `Remote MCP response id ${String(payload.id)} did not match ${String(expectedId)}`,
    );
  }
  if (payload.error) {
    throw new Error(`Remote MCP request failed: ${JSON.stringify(payload.error)}`);
  }
  if (payload.result === undefined) {
    throw new Error(`Remote MCP response ${response.status} did not contain a result`);
  }
  return payload.result;
}

export async function readToolEnvelope(
  response: Response,
  expectedId?: number | string,
): Promise<McpToolEnvelope> {
  const result = await readJsonRpcResult<McpToolResult>(response, expectedId);
  const first = result.content?.[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error(
      `Remote MCP response ${response.status} did not contain a text tool result`,
    );
  }
  return { isError: result.isError === true, text: first.text };
}

export async function readToolText(
  response: Response,
  expectedId?: number | string,
): Promise<string> {
  return (await readToolEnvelope(response, expectedId)).text;
}

export async function readToolJson<T>(
  response: Response,
  expectedId?: number | string,
): Promise<T> {
  const envelope = await readToolEnvelope(response, expectedId);
  if (envelope.isError) throw new Error(envelope.text);
  try {
    return JSON.parse(envelope.text) as T;
  } catch (error) {
    throw new Error(
      `Remote MCP text result was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function callToolEnvelope(
  app: McpRequestTarget,
  token: string,
  id: number | string,
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<McpToolEnvelope> {
  const response = await mcpRequest(
    app,
    token,
    toolCall(id, name, args),
    extraHeaders,
  );
  if (response.status !== 200) {
    const body = await response.text().catch(() => "<unreadable response>");
    throw new Error(
      `Remote MCP tool ${name} returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return await readToolEnvelope(response, id);
}

export async function callToolJson<T>(
  app: McpRequestTarget,
  token: string,
  id: number | string,
  name: string,
  args: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const envelope = await callToolEnvelope(
    app,
    token,
    id,
    name,
    args,
    extraHeaders,
  );
  if (envelope.isError) throw new Error(envelope.text);
  try {
    return JSON.parse(envelope.text) as T;
  } catch (error) {
    throw new Error(
      `Remote MCP text result was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
