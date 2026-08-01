import { createHash } from "node:crypto";
import {
  FAILURE_CATEGORY_HEADER,
  REQUEST_ID_HEADER,
  type FailureCategory,
} from "./worker-observability.js";

export const MCP_TOOL_MANIFEST_VERSION = 1;
export const MCP_TOOL_MANIFEST_FINGERPRINT_HEADER =
  "x-stensibly-mcp-tool-manifest-fingerprint";
export const MCP_TOOL_COUNT_HEADER = "x-stensibly-mcp-tool-count";
export const MCP_FAILURE_STAGE_HEADER = "x-stensibly-mcp-failure-stage";

export const MCP_TOOL_NAMES = [
  "attach_artifact",
  "block_work",
  "claim_work",
  "complete_work",
  "create_item",
  "edit_continuation",
  "get_brief",
  "get_continuation",
  "get_github_project_context",
  "get_item",
  "get_operation_receipt",
  "get_project_attachment",
  "get_runner_context",
  "github_get_issue",
  "github_get_tool",
  "github_list_issues",
  "github_list_toolsets",
  "github_search_issues",
  "github_search_tools",
  "handoff_work",
  "list_artifacts",
  "list_continuation_inbox",
  "list_continuations",
  "list_work",
  "propose_continuation",
  "queue_continuation_for_supervisor",
  "record_event",
  "release_work",
  "renew_claim",
  "resolve_continuation",
  "run_continuation_supervisor_policy",
  "survey_workspace",
  "unblock_work",
] as const;

const manifestJson = JSON.stringify({
  version: MCP_TOOL_MANIFEST_VERSION,
  tools: MCP_TOOL_NAMES,
});

export const MCP_TOOL_MANIFEST_FINGERPRINT = `sha256:${createHash("sha256")
  .update(manifestJson)
  .digest("hex")}`;
export const MCP_TOOL_MANIFEST_REVISION = MCP_TOOL_MANIFEST_FINGERPRINT.slice(
  "sha256:".length,
  "sha256:".length + 12,
);
export const MCP_SERVER_VERSION = `0.0.1+manifest.${MCP_TOOL_MANIFEST_REVISION}`;

export type McpFailureStage =
  | "method_validation"
  | "origin_validation"
  | "host_validation"
  | "token_authority"
  | "authentication"
  | "payload_parse"
  | "authorization"
  | "server_construction"
  | "transport_connection"
  | "request_execution"
  | "request_validation";

export interface McpFailureDiagnosticData {
  layer: "gateway" | "authentication" | "authorization" | "token_authority" | "mcp";
  stage: McpFailureStage;
  requestId: string;
  retryable: boolean;
  reconciliation: "not_required" | "safe_to_retry" | "read_after_write_before_retry";
  recommendedAction:
    | "fix_request"
    | "reauthenticate"
    | "request_scope_or_project_access"
    | "retry_with_same_request_id"
    | "reconcile_by_idempotency_key_before_retry"
    | "read_after_write_before_retry";
  manifestFingerprint: string;
  manifestToolCount: number;
  method?: string;
  tool?: string;
  idempotencyKeyPresent?: boolean;
}

export async function withMcpDiagnostics(
  request: Request,
  response: Response,
): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set(MCP_TOOL_MANIFEST_FINGERPRINT_HEADER, MCP_TOOL_MANIFEST_FINGERPRINT);
  headers.set(MCP_TOOL_COUNT_HEADER, String(MCP_TOOL_NAMES.length));

  const requestId = acceptedRequestId(request.headers.get(REQUEST_ID_HEADER));
  if (!requestId || response.status < 400 || !isJsonResponse(response)) {
    return copyResponse(response, headers);
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return copyResponse(response, headers);
  }
  if (!isRecord(payload) || !isRecord(payload.error) || payload.error.data !== undefined) {
    return copyResponse(response, headers);
  }

  const requestPayload = await readRequestPayload(request);
  const method = requestMethod(requestPayload);
  const tool = requestTool(requestPayload);
  const idempotencyKeyPresent = requestHasIdempotencyKey(requestPayload);
  const category = failureCategory(headers.get(FAILURE_CATEGORY_HEADER), response.status);
  const stage = failureStage(
    headers.get(MCP_FAILURE_STAGE_HEADER),
    response.status,
    payload.error.code,
    category,
  );
  payload.error = {
    ...payload.error,
    data: diagnosticData({
      category,
      stage,
      requestId,
      method,
      tool,
      idempotencyKeyPresent,
    }),
  };

  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function diagnosticData(input: {
  category: FailureCategory;
  stage: McpFailureStage;
  requestId: string;
  method?: string;
  tool?: string;
  idempotencyKeyPresent: boolean;
}): McpFailureDiagnosticData {
  const writeMayHaveExecuted = input.stage === "request_execution"
    && input.method === "tools/call"
    && isWriteTool(input.tool);
  const retryable = !writeMayHaveExecuted && (
    input.category === "convex_failure"
    || input.category === "mcp_failure"
    || input.category === "gateway_failure"
  );
  const reconciliation = writeMayHaveExecuted
    ? "read_after_write_before_retry"
    : retryable
    ? "safe_to_retry"
    : "not_required";
  const recommendedAction = writeMayHaveExecuted
    ? input.idempotencyKeyPresent
      ? "reconcile_by_idempotency_key_before_retry"
      : "read_after_write_before_retry"
    : input.category === "auth_failure"
    ? "reauthenticate"
    : input.category === "authorization_failure"
    ? "request_scope_or_project_access"
    : retryable
    ? "retry_with_same_request_id"
    : "fix_request";

  return {
    layer: failureLayer(input.category),
    stage: input.stage,
    requestId: input.requestId,
    retryable,
    reconciliation,
    recommendedAction,
    manifestFingerprint: MCP_TOOL_MANIFEST_FINGERPRINT,
    manifestToolCount: MCP_TOOL_NAMES.length,
    ...(input.method ? { method: input.method } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    ...(writeMayHaveExecuted
      ? { idempotencyKeyPresent: input.idempotencyKeyPresent }
      : {}),
  };
}

function failureLayer(
  category: FailureCategory,
): McpFailureDiagnosticData["layer"] {
  if (category === "auth_failure") return "authentication";
  if (category === "authorization_failure") return "authorization";
  if (category === "convex_failure") return "token_authority";
  if (category === "mcp_failure") return "mcp";
  return "gateway";
}

function failureStage(
  explicit: string | null,
  status: number,
  code: unknown,
  category: FailureCategory,
): McpFailureStage {
  if (isFailureStage(explicit)) return explicit;
  if (status === 405) return "method_validation";
  if (code === -32700) return "payload_parse";
  if (category === "auth_failure") return "authentication";
  if (category === "authorization_failure") return "authorization";
  if (category === "convex_failure") return "token_authority";
  if (category === "mcp_failure") return "request_execution";
  return "request_validation";
}

function failureCategory(value: string | null, status: number): FailureCategory {
  const categories: FailureCategory[] = [
    "auth_failure",
    "authorization_failure",
    "cors_rejection",
    "convex_failure",
    "mcp_failure",
    "gateway_failure",
    "request_failure",
  ];
  if (value && categories.includes(value as FailureCategory)) {
    return value as FailureCategory;
  }
  if (status === 401) return "auth_failure";
  if (status === 403) return "authorization_failure";
  return "mcp_failure";
}

function isFailureStage(value: string | null): value is McpFailureStage {
  return [
    "method_validation",
    "origin_validation",
    "host_validation",
    "token_authority",
    "authentication",
    "payload_parse",
    "authorization",
    "server_construction",
    "transport_connection",
    "request_execution",
    "request_validation",
  ].includes(value ?? "");
}

async function readRequestPayload(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function requestMethod(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.method !== "string") return undefined;
  const method = payload.method.trim();
  return /^[a-z][a-z0-9/._-]{0,79}$/.test(method) ? method : undefined;
}

function requestTool(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.method !== "tools/call" || !isRecord(payload.params)) {
    return undefined;
  }
  const name = payload.params.name;
  return typeof name === "string" && MCP_TOOL_NAMES.includes(name as typeof MCP_TOOL_NAMES[number])
    ? name
    : undefined;
}

function requestHasIdempotencyKey(payload: unknown): boolean {
  if (!isRecord(payload) || payload.method !== "tools/call" || !isRecord(payload.params)) {
    return false;
  }
  const args = payload.params.arguments;
  if (!isRecord(args)) return false;
  const value = args.idempotencyKey;
  return typeof value === "string" && value.trim().length > 0;
}

function isWriteTool(tool: string | undefined): boolean {
  return tool !== undefined && [
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
  ].includes(tool);
}

function acceptedRequestId(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : null;
}

function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function copyResponse(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
