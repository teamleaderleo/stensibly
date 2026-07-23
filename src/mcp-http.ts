import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  authenticateApiToken,
  principalCanAccessProject,
  principalHasScope,
  type TokenPrincipal,
} from "./auth.ts";
import { createMcpServer } from "./mcp.ts";
import { NotFoundError, StensiblyStore } from "./store.ts";

export interface McpHttpOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface AccessRule {
  scope: "read" | "write";
  project?: string;
  requireProject?: boolean;
}

const readTools = new Set([
  "get_brief",
  "list_work",
  "get_item",
  "list_artifacts",
]);

const writeTools = new Set([
  "attach_artifact",
  "create_item",
  "claim_work",
  "renew_claim",
  "handoff_work",
  "block_work",
  "unblock_work",
  "release_work",
  "record_event",
  "complete_work",
]);

const itemTools = new Set([
  "get_item",
  "list_artifacts",
  "attach_artifact",
  "claim_work",
  "renew_claim",
  "handoff_work",
  "block_work",
  "unblock_work",
  "release_work",
  "record_event",
  "complete_work",
]);

export async function handleMcpHttpRequest(
  store: StensiblyStore,
  request: Request,
  options: McpHttpOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed.", null, {
      Allow: "POST",
    });
  }

  const originDenied = validateOrigin(request, options.allowedOrigins ?? []);
  if (originDenied) return originDenied;

  const hostDenied = validateHost(request, options.allowedHosts);
  if (hostDenied) return hostDenied;

  const token = parseBearerToken(request.headers.get("authorization"));
  const principal = token ? authenticateApiToken(store, token) : null;
  if (!principal) {
    return jsonRpcError(401, -32001, "A valid Bearer token is required", null, {
      "WWW-Authenticate": "Bearer",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON", null);
  }

  const denial = authorizePayload(store, principal, body);
  if (denial) return denial;

  const server = createMcpServer(store);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } catch (error) {
    console.error("Remote MCP request failed", error);
    return jsonRpcError(500, -32603, "Internal server error", requestId(body));
  } finally {
    await server.close();
  }
}

function authorizePayload(
  store: StensiblyStore,
  principal: TokenPrincipal,
  payload: unknown,
): Response | null {
  if (Array.isArray(payload)) {
    for (const message of payload) {
      const denial = authorizeMessage(store, principal, message);
      if (denial) return denial;
    }
    return null;
  }
  return authorizeMessage(store, principal, payload);
}

function authorizeMessage(
  store: StensiblyStore,
  principal: TokenPrincipal,
  payload: unknown,
): Response | null {
  if (!isRecord(payload) || payload.method !== "tools/call") return null;

  const params = isRecord(payload.params) ? payload.params : {};
  const toolName = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  const rule = resolveAccessRule(store, principal, toolName, args);
  if (!rule) return null;

  if (!principalHasScope(principal, rule.scope)) {
    return jsonRpcError(
      403,
      -32001,
      `Token requires ${rule.scope} scope`,
      requestId(payload),
    );
  }

  if (rule.requireProject && !rule.project) {
    return jsonRpcError(
      400,
      -32602,
      "A project is required when a token has a project allowlist",
      requestId(payload),
    );
  }

  if (rule.project && !principalCanAccessProject(principal, rule.project)) {
    return jsonRpcError(
      403,
      -32001,
      `Token cannot access project ${rule.project}`,
      requestId(payload),
    );
  }

  return null;
}

function resolveAccessRule(
  store: StensiblyStore,
  principal: TokenPrincipal,
  toolName: string,
  args: Record<string, unknown>,
): AccessRule | null {
  const scope = readTools.has(toolName)
    ? "read"
    : writeTools.has(toolName)
    ? "write"
    : null;
  if (!scope) return null;

  if (toolName === "get_brief" || toolName === "create_item") {
    return {
      scope,
      project: stringArgument(args, "project"),
    };
  }

  if (toolName === "list_work") {
    const project = stringArgument(args, "project");
    return {
      scope,
      ...(project ? { project } : {}),
      requireProject: principal.projects !== null,
    };
  }

  if (itemTools.has(toolName)) {
    const id = stringArgument(args, "id");
    if (!id) return { scope };
    try {
      return { scope, project: store.getItem(id).project };
    } catch (error) {
      if (error instanceof NotFoundError) return { scope };
      throw error;
    }
  }

  return { scope };
}

function validateOrigin(request: Request, allowedOrigins: string[]): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (allowedOrigins.includes(origin)) return null;
  return jsonRpcError(403, -32001, `Origin is not allowed: ${origin}`, null);
}

function validateHost(request: Request, allowedHosts?: string[]): Response | null {
  if (!allowedHosts || allowedHosts.length === 0) return null;
  const host = request.headers.get("host");
  if (host && allowedHosts.includes(host)) return null;
  return jsonRpcError(403, -32001, `Host is not allowed: ${host ?? "missing"}`, null);
}

function parseBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || null;
}

function stringArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestId(payload: unknown): unknown {
  if (!isRecord(payload) || Array.isArray(payload)) return null;
  return payload.id ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  id: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...extraHeaders,
      },
    },
  );
}
