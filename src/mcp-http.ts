import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  continuationAccessProjects,
  supervisorPolicyAccessProjects,
} from "./continuation-authorization.js";
import { continuationLedger } from "./continuation-contracts.js";
import {
  principalCanAccessProject,
  principalHasScope,
  type TokenPrincipal,
} from "./token-contracts.js";
import type { WorkLedger } from "./ledger.js";
import { createMcpServer } from "./mcp.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";
import {
  FAILURE_CATEGORY_HEADER,
  type FailureCategory,
} from "./worker-observability.js";

export interface McpHttpOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
  ledger: WorkLedger;
  authenticator: ApiTokenAuthenticator;
}

interface AccessRule {
  scope: "read" | "write";
  project?: string;
  projects?: string[];
  requireProject?: boolean;
}

const readTools = new Set([
  "get_brief",
  "get_project_attachment",
  "survey_workspace",
  "list_work",
  "get_item",
  "get_runner_context",
  "list_artifacts",
  "get_continuation",
  "list_continuations",
  "list_continuation_inbox",
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
  "propose_continuation",
  "edit_continuation",
  "resolve_continuation",
  "queue_continuation_for_supervisor",
  "run_continuation_supervisor_policy",
]);

const itemTools = new Set([
  "get_item",
  "get_runner_context",
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
  request: Request,
  options: McpHttpOptions,
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
    return jsonRpcError(401, -32001, "A valid Bearer token is required", null, {
      "WWW-Authenticate": "Bearer",
    }, "auth_failure");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON", null);
  }

  const denial = await authorizePayload(options.ledger, principal, body);
  if (denial) return denial;

  const server = createMcpServer(options.ledger);
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
  return await authorizeMessage(ledger, principal, payload);
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
  const scope = toolScope(toolName);
  if (!scope) return null;

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

  const rule = await resolveAccessRule(ledger, principal, toolName, args, scope);
  if (rule.requireProject && !rule.project) {
    return jsonRpcError(
      400,
      -32602,
      "A project is required when a token has a project allowlist",
      requestId(payload),
    );
  }

  const projects = rule.projects ?? (rule.project ? [rule.project] : []);
  for (const project of projects) {
    if (!principalCanAccessProject(principal, project)) {
      return jsonRpcError(
        403,
        -32001,
        `Token cannot access project ${project}`,
        requestId(payload),
        {},
        "authorization_failure",
      );
    }
  }

  return null;
}

function toolScope(toolName: string): "read" | "write" | null {
  if (readTools.has(toolName)) return "read";
  if (writeTools.has(toolName)) return "write";
  return null;
}

async function resolveAccessRule(
  ledger: WorkLedger,
  principal: TokenPrincipal,
  toolName: string,
  args: Record<string, unknown>,
  scope: "read" | "write",
): Promise<AccessRule> {
  if (
    toolName === "get_brief"
    || toolName === "get_project_attachment"
    || toolName === "create_item"
  ) {
    return {
      scope,
      project: stringArgument(args, "project"),
    };
  }

  if (
    toolName === "list_work"
    || toolName === "survey_workspace"
    || toolName === "list_continuation_inbox"
  ) {
    const project = stringArgument(args, "project");
    return {
      scope,
      ...(project ? { project } : {}),
      requireProject: principal.projects !== null,
    };
  }

  if (toolName === "run_continuation_supervisor_policy") {
    const project = stringArgument(args, "project");
    const continuations = continuationLedger(ledger);
    if (!continuations) {
      return {
        scope,
        ...(project ? { project } : {}),
        requireProject: principal.projects !== null,
      };
    }
    try {
      return {
        scope,
        ...(project ? { project } : {}),
        projects: await supervisorPolicyAccessProjects(ledger, continuations, project),
        requireProject: principal.projects !== null,
      };
    } catch {
      return {
        scope,
        ...(project ? { project } : {}),
        requireProject: principal.projects !== null,
      };
    }
  }

  if (toolName === "propose_continuation" || toolName === "list_continuations") {
    return await itemAccessRule(ledger, scope, stringArgument(args, "sourceItemId"));
  }

  if (toolName === "queue_continuation_for_supervisor") {
    const id = stringArgument(args, "id");
    const continuations = continuationLedger(ledger);
    if (!id || !continuations) return { scope };
    try {
      const continuation = await continuations.getContinuation(id);
      return {
        scope,
        projects: await continuationAccessProjects(ledger, continuation),
      };
    } catch {
      return { scope };
    }
  }

  if (
    toolName === "get_continuation"
    || toolName === "edit_continuation"
    || toolName === "resolve_continuation"
  ) {
    const id = stringArgument(args, "id");
    const continuations = continuationLedger(ledger);
    if (!id || !continuations) return { scope };
    try {
      const continuation = await continuations.getContinuation(id);
      return {
        scope,
        project: (await ledger.getItem(continuation.sourceItemId)).item.project,
      };
    } catch {
      return { scope };
    }
  }

  if (itemTools.has(toolName)) {
    return await itemAccessRule(ledger, scope, stringArgument(args, "id"));
  }

  return { scope };
}

async function itemAccessRule(
  ledger: WorkLedger,
  scope: "read" | "write",
  id: string | undefined,
): Promise<AccessRule> {
  if (!id) return { scope };
  try {
    return { scope, project: (await ledger.getItem(id)).item.project };
  } catch {
    return { scope };
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
