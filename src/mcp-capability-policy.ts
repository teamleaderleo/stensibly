import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sha256, stableJson } from "./canonical-json.js";

export const mcpCapabilityScopes = ["read", "write"] as const;
export type McpCapabilityScope = typeof mcpCapabilityScopes[number];

export const mcpCapabilityRiskClasses = [
  "read",
  "bounded_write",
  "consequential",
] as const;
export type McpCapabilityRiskClass = typeof mcpCapabilityRiskClasses[number];

export const mcpCapabilityExposures = ["core", "searchable", "hidden"] as const;
export type McpCapabilityExposure = typeof mcpCapabilityExposures[number];

export const mcpCapabilityApprovalPolicies = ["none", "tool_managed"] as const;
export type McpCapabilityApprovalPolicy =
  typeof mcpCapabilityApprovalPolicies[number];

export const mcpCapabilityReceiptPolicies = ["none", "tool_managed"] as const;
export type McpCapabilityReceiptPolicy = typeof mcpCapabilityReceiptPolicies[number];

export const mcpCapabilityReconciliationPolicies = [
  "none",
  "tool_managed",
] as const;
export type McpCapabilityReconciliationPolicy =
  typeof mcpCapabilityReconciliationPolicies[number];

export type McpCapabilityProjectResolution =
  | { kind: "none" }
  | { kind: "project_argument"; argument: string }
  | { kind: "optional_project_argument"; argument: string }
  | { kind: "item_argument"; argument: string }
  | { kind: "continuation_source_item_argument"; argument: string }
  | { kind: "continuation_argument"; argument: string }
  | { kind: "continuation_touch_set"; argument: string }
  | { kind: "continuation_supervisor_policy"; argument: string };

export interface McpCapabilityPolicyInput {
  toolName: string;
  scope: McpCapabilityScope;
  riskClass: McpCapabilityRiskClass;
  defaultExposure: McpCapabilityExposure;
  projectResolution: McpCapabilityProjectResolution;
  approvalPolicy: McpCapabilityApprovalPolicy;
  receiptPolicy: McpCapabilityReceiptPolicy;
  reconciliationPolicy: McpCapabilityReconciliationPolicy;
}

export interface McpCapabilityPolicy extends McpCapabilityPolicyInput {}

export interface McpCapabilityPolicyRegistry {
  version: 1;
  policies: readonly McpCapabilityPolicy[];
  fingerprint: string;
}

const toolNamePattern = /^[a-z][a-z0-9_]{0,127}$/;

const noProject = Object.freeze({ kind: "none" } as const);
const directProject = Object.freeze({
  kind: "project_argument",
  argument: "project",
} as const);
const optionalProject = Object.freeze({
  kind: "optional_project_argument",
  argument: "project",
} as const);
const itemId = Object.freeze({ kind: "item_argument", argument: "id" } as const);
const sourceItemId = Object.freeze({
  kind: "continuation_source_item_argument",
  argument: "sourceItemId",
} as const);
const continuationId = Object.freeze({
  kind: "continuation_argument",
  argument: "id",
} as const);
const continuationTouchSet = Object.freeze({
  kind: "continuation_touch_set",
  argument: "id",
} as const);
const continuationSupervisorPolicy = Object.freeze({
  kind: "continuation_supervisor_policy",
  argument: "project",
} as const);

const policyInputs: readonly McpCapabilityPolicyInput[] = [
  readPolicy("get_brief", directProject),
  readPolicy("get_project_attachment", directProject),
  readPolicy("get_operation_receipt", directProject),
  readPolicy("github_call_tool", directProject),
  readPolicy("github_get_issue", directProject),
  readPolicy("github_get_tool", noProject),
  readPolicy("github_list_issues", directProject),
  readPolicy("github_list_toolsets", noProject),
  readPolicy("github_search_issues", directProject),
  readPolicy("github_search_tools", noProject),
  readPolicy("survey_workspace", optionalProject),
  readPolicy("list_work", optionalProject),
  readPolicy("get_item", itemId),
  readPolicy("get_runner_context", itemId),
  readPolicy("list_artifacts", itemId),
  readPolicy("get_continuation", continuationId),
  readPolicy("list_continuations", sourceItemId),
  readPolicy("list_continuation_inbox", optionalProject),
  writePolicy("attach_artifact", itemId),
  writePolicy("create_item", directProject),
  writePolicy("claim_work", itemId),
  writePolicy("renew_claim", itemId),
  writePolicy("handoff_work", itemId),
  writePolicy("block_work", itemId),
  writePolicy("unblock_work", itemId),
  writePolicy("release_work", itemId),
  writePolicy("record_event", itemId),
  writePolicy("complete_work", itemId),
  writePolicy("propose_continuation", sourceItemId),
  writePolicy("edit_continuation", continuationId),
  writePolicy("resolve_continuation", continuationId),
  writePolicy(
    "queue_continuation_for_supervisor",
    continuationTouchSet,
    "consequential",
    "tool_managed",
  ),
  writePolicy(
    "run_continuation_supervisor_policy",
    continuationSupervisorPolicy,
    "consequential",
    "tool_managed",
  ),
];

export const mcpCapabilityPolicyRegistry = compileMcpCapabilityPolicyRegistry(
  policyInputs,
);

const policiesByToolName = new Map(
  mcpCapabilityPolicyRegistry.policies.map((policy) => [policy.toolName, policy]),
);

export function compileMcpCapabilityPolicyRegistry(
  inputs: readonly McpCapabilityPolicyInput[],
): McpCapabilityPolicyRegistry {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 256) {
    throw new RangeError("MCP capability policy registry accepts 1 to 256 tools");
  }

  const names = new Set<string>();
  const policies = inputs.map((input) => {
    const policy = validatePolicy(input);
    if (names.has(policy.toolName)) {
      throw new RangeError(`Duplicate MCP capability policy: ${policy.toolName}`);
    }
    names.add(policy.toolName);
    return policy;
  }).sort((left, right) => codeUnitCompare(left.toolName, right.toolName));

  const canonical = {
    version: 1 as const,
    policies,
  };
  return deepFreeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

export function getMcpCapabilityPolicy(
  toolName: string,
): McpCapabilityPolicy | null {
  return policiesByToolName.get(toolName) ?? null;
}

export function requireMcpCapabilityPolicy(toolName: string): McpCapabilityPolicy {
  const policy = getMcpCapabilityPolicy(toolName);
  if (!policy) {
    throw new RangeError(`Missing MCP capability policy for registered tool: ${toolName}`);
  }
  return policy;
}

export interface McpCapabilityRegistrationGuard {
  server: McpServer;
  complete(): readonly string[];
}

export function createMcpCapabilityRegistrationGuard(
  server: McpServer,
): McpCapabilityRegistrationGuard {
  const registered = new Set<string>();
  const guarded = new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        return Reflect.get(target, property, receiver);
      }
      return (toolName: string, ...args: unknown[]) => {
        requireMcpCapabilityPolicy(toolName);
        if (registered.has(toolName)) {
          throw new RangeError(`Duplicate MCP tool registration: ${toolName}`);
        }
        registered.add(toolName);
        const registerTool = Reflect.get(target, property, target) as (
          name: string,
          ...registrationArgs: unknown[]
        ) => unknown;
        return Reflect.apply(registerTool, target, [toolName, ...args]);
      };
    },
  }) as McpServer;

  return {
    server: guarded,
    complete() {
      if (registered.size === 0) {
        throw new RangeError("MCP server registered no capability-governed tools");
      }
      return Object.freeze([...registered].sort(codeUnitCompare));
    },
  };
}

function readPolicy(
  toolName: string,
  projectResolution: McpCapabilityProjectResolution,
): McpCapabilityPolicyInput {
  return {
    toolName,
    scope: "read",
    riskClass: "read",
    defaultExposure: "core",
    projectResolution,
    approvalPolicy: "none",
    receiptPolicy: "none",
    reconciliationPolicy: "none",
  };
}

function writePolicy(
  toolName: string,
  projectResolution: McpCapabilityProjectResolution,
  riskClass: "bounded_write" | "consequential" = "bounded_write",
  approvalPolicy: McpCapabilityApprovalPolicy = "none",
): McpCapabilityPolicyInput {
  return {
    toolName,
    scope: "write",
    riskClass,
    defaultExposure: "core",
    projectResolution,
    approvalPolicy,
    receiptPolicy: "tool_managed",
    reconciliationPolicy: "tool_managed",
  };
}

function validatePolicy(input: McpCapabilityPolicyInput): McpCapabilityPolicy {
  if (!input || typeof input !== "object") {
    throw new RangeError("MCP capability policy must be an object");
  }
  if (typeof input.toolName !== "string" || !toolNamePattern.test(input.toolName)) {
    throw new RangeError("MCP capability policy tool name is invalid");
  }
  if (!mcpCapabilityScopes.includes(input.scope)) {
    throw new RangeError(`MCP capability scope is invalid for ${input.toolName}`);
  }
  if (!mcpCapabilityRiskClasses.includes(input.riskClass)) {
    throw new RangeError(`MCP capability risk is invalid for ${input.toolName}`);
  }
  if (!mcpCapabilityExposures.includes(input.defaultExposure)) {
    throw new RangeError(`MCP capability exposure is invalid for ${input.toolName}`);
  }
  if (!mcpCapabilityApprovalPolicies.includes(input.approvalPolicy)) {
    throw new RangeError(`MCP capability approval policy is invalid for ${input.toolName}`);
  }
  if (!mcpCapabilityReceiptPolicies.includes(input.receiptPolicy)) {
    throw new RangeError(`MCP capability receipt policy is invalid for ${input.toolName}`);
  }
  if (!mcpCapabilityReconciliationPolicies.includes(input.reconciliationPolicy)) {
    throw new RangeError(
      `MCP capability reconciliation policy is invalid for ${input.toolName}`,
    );
  }
  validateProjectResolution(input.projectResolution, input.toolName);

  if ((input.scope === "read") !== (input.riskClass === "read")) {
    throw new RangeError(
      `MCP capability ${input.toolName} must use read risk exactly for read scope`,
    );
  }
  if (input.scope === "read" && (
    input.approvalPolicy !== "none"
    || input.receiptPolicy !== "none"
    || input.reconciliationPolicy !== "none"
  )) {
    throw new RangeError(
      `Read MCP capability ${input.toolName} cannot declare write effect policy`,
    );
  }
  if (
    input.reconciliationPolicy === "tool_managed"
    && input.receiptPolicy !== "tool_managed"
  ) {
    throw new RangeError(
      `MCP capability ${input.toolName} reconciliation requires receipt policy`,
    );
  }

  return deepFreeze({
    toolName: input.toolName,
    scope: input.scope,
    riskClass: input.riskClass,
    defaultExposure: input.defaultExposure,
    projectResolution: { ...input.projectResolution },
    approvalPolicy: input.approvalPolicy,
    receiptPolicy: input.receiptPolicy,
    reconciliationPolicy: input.reconciliationPolicy,
  });
}

function validateProjectResolution(
  resolution: McpCapabilityProjectResolution,
  toolName: string,
): void {
  if (!resolution || typeof resolution !== "object") {
    throw new RangeError(`MCP capability project resolution is invalid for ${toolName}`);
  }
  const validKinds: McpCapabilityProjectResolution["kind"][] = [
    "none",
    "project_argument",
    "optional_project_argument",
    "item_argument",
    "continuation_source_item_argument",
    "continuation_argument",
    "continuation_touch_set",
    "continuation_supervisor_policy",
  ];
  if (!validKinds.includes(resolution.kind)) {
    throw new RangeError(`MCP capability project resolution is invalid for ${toolName}`);
  }
  if (resolution.kind !== "none" && (
    typeof resolution.argument !== "string"
    || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(resolution.argument)
  )) {
    throw new RangeError(`MCP capability project argument is invalid for ${toolName}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
