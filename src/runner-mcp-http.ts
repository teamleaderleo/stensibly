import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { WorkLedger } from "./ledger.js";
import { createRunnerMcpServer } from "./runner-mcp.js";
import { runnerLedger } from "./runner-contracts.js";
import {
  principalCanAccessProject,
  principalHasScope,
  type TokenPrincipal,
} from "./token-contracts.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";
import {
  FAILURE_CATEGORY_HEADER,
  type FailureCategory,
} from "./worker-observability.js";

export interface RunnerMcpHttpOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
  ledger: WorkLedger;
  authenticator: ApiTokenAuthenticator;
}

const readTools = new Set(["get_runner_run", "list_runner_runs"]);
const writeTools = new Set([
  "claim_runner_work",
  "heartbeat_runner_run",
  "transition_runner_run",
]);

export async function handleRunnerMcpHttpRequest(
  request: Request,
  options: RunnerMcpHttpOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonRpcError(405, -32000, "Method not allowed.", null, { Allow: "POST" });
  }

  const originDenied = validateOrigin(request, options.allowedOrigins ?? []);
  if (originDenied) return originDenied;
  const hostDenied = validateHost(request, options.allowedHosts);
  if (hostDenied) return hostDenied;

  const runs = runnerLedger(options.ledger);
  if (!runs) {
    return jsonRpcError(
      503,
      -32002,
      "Runner lifecycle is unavailable on this backend",
      null,
    );
  }

  const token = parseBearerToken(request.headers.get("authorization"));
  let principal: TokenPrincipal | null;
  try {
    principal = token ? await options.authenticator.authenticate(token) : null;
  } catch {
    return jsonRpcError(
      502,
      -32603,
      "Hosted token authority failed",
      null,
      {},
      "convex_failure",
    );
  }
  if (!principal) {
    return jsonRpcError(
      401,
      -32001,
      "A valid Bearer token is required",
      null,
      { "WWW-Authenticate": "Bearer" },
      "auth_failure",
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON", null);
  }

  const denial = await authorizePayload(options.ledger, principal, body);
  if (denial) return denial;

  const server = createRunnerMcpServer(options.ledger);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } catch {
    return jsonRpcError(500, -32603, "Internal server error", requestId(body));
  } finally {
    await server.close();
  }
}

async function authorizePayload(
  ledger: WorkLedger,
  principal: TokenPrincipal,
  payload: unknown,
): Promise<Response | null> {
  if (Array.isArray(payload)) {
    for (const message of payload) {
      const denial = await authorizeMessage(ledger, principal, message);
      if (denial) return denial;
    }
    return null;
  }
  return authorizeMessage(ledger, principal, payload);
}

async function authorizeMessage(
  ledger: WorkLedger,
  principal: TokenPrincipal,
  payload: unknown,
): Promise<Response | null> {
  if (!isRecord(payload) || payload.method !== "tools/call") return null;
  const params = isRecord(payload.params) ? payload.params : {};
  const toolName = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? params.arguments : {};
  const scope = readTools.has(toolName) ? "read" : writeTools.has(toolName) ? "write" : null;
  if (!scope) return jsonRpcError(403, -32001, "Runner tool is not allowed", requestId(payload));
  if (!principalHasScope(principal, scope)) {
    return jsonRpcError(
      403,
      -32001,
      `Token requires ${scope} scope`,
      requestId(payload),
      {},
      "authorization_failure",
    );
  }

  const project = await resolveProject(ledger, toolName, args);
  if (!project && principal.projects !== null) {
    return jsonRpcError(
      400,
      -32602,
      "A project is required when a token has a project allowlist",
      requestId(payload),
    );
  }
  if (project && !principalCanAccessProject(principal, project)) {
    return jsonRpcError(
      403,
      -32001,
      `Token cannot access project ${project}`,
      requestId(payload),
      {},
      "authorization_failure",
    );
  }
  return null;
}

async function resolveProject(
  ledger: WorkLedger,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  if (toolName === "claim_runner_work" || toolName === "list_runner_runs") {
    return stringArgument(args, "project");
  }
  const id = stringArgument(args, "id");
  const runs = runnerLedger(ledger);
  if (!id || !runs) return undefined;
  try {
    const run = await runs.getRun(id);
    return (await ledger.getItem(run.itemId)).item.project;
  } catch {
    return undefined;
  }
}

function validateOrigin(request: Request, allowedOrigins: string[]): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (allowedOrigins.includes(origin)) return null;
  return jsonRpcError(
    403,
    -32001,
    `Origin is not allowed: ${origin}`,
    null,
    {},
    "cors_rejection",
  );
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
  return isRecord(payload) ? payload.id ?? null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  id: unknown,
  headers: Record<string, string> = {},
  category?: FailureCategory,
): Response {
  const responseHeaders = new Headers({ "content-type": "application/json", ...headers });
  if (category) responseHeaders.set(FAILURE_CATEGORY_HEADER, category);
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    error: { code, message },
    id,
  }), {
    status,
    headers: responseHeaders,
  });
}
