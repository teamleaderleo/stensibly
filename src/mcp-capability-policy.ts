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

export const mcpCapabilityInteractionDomains = ["closed", "open"] as const;
export type McpCapabilityInteractionDomain =
  typeof mcpCapabilityInteractionDomains[number];

export const mcpCapabilityEffectKinds = [
  "none",
  "additive",
  "destructive",
] as const;
export type McpCapabilityEffectKind = typeof mcpCapabilityEffectKinds[number];

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
  interactionDomain: McpCapabilityInteractionDomain;
  effectKind: McpCapabilityEffectKind;
  projectResolution: McpCapabilityProjectResolution;
  approvalPolicy: McpCapabilityApprovalPolicy;
  receiptPolicy: McpCapabilityReceiptPolicy;
  reconciliationPolicy: McpCapabilityReconciliationPolicy;
}

export interface McpCapabilityPolicy extends McpCapabilityPolicyInput {}

export interface McpCapabilityPolicyRegistry {
  version: 2;
  policies: readonly McpCapabilityPolicy[];
  fingerprint: string;
}

export interface McpCapabilitySubmissionAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
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
  readPolicy("get_github_project_context", directProject, "searchable"),
  readPolicy("get_github_provider_receipt", directProject, "hidden"),
  readPolicy("get_github_repository_write_receipt", directProject, "hidden"),
  readPolicy("get_operation_receipt", directProject, "hidden"),
  readPolicy("get_operation_workflow", directProject, "hidden"),
  readPolicy("github_call_tool", directProject, "searchable", "open"),
  readPolicy("github_branch_tidy", directProject, "searchable", "open"),
  readPolicy("github_ci_diagnose", directProject, "core", "open"),
  readPolicy("github_get_issue", directProject, "core", "open"),
  readPolicy("github_get_tool", noProject, "searchable"),
  readPolicy("github_list_issues", directProject, "searchable", "open"),
  readPolicy("github_list_toolsets", noProject, "searchable"),
  readPolicy("github_repo_health", directProject, "core", "open"),
  readPolicy("github_search_issues", directProject, "core", "open"),
  readPolicy("github_search_tools", noProject, "searchable"),
  readPolicy("survey_workspace", optionalProject, "hidden"),
  readPolicy("list_work", optionalProject),
  readPolicy("get_item", itemId),
  readPolicy("get_runner_context", itemId, "hidden"),
  readPolicy("list_artifacts", itemId, "hidden"),
  readPolicy("get_continuation", continuationId, "searchable"),
  readPolicy("list_continuations", sourceItemId, "searchable"),
  readPolicy("list_continuation_inbox", optionalProject, "searchable"),
  writePolicy("attach_artifact", itemId, "additive"),
  writePolicy("create_item", directProject, "additive"),
  writePolicy("dispatch_work", directProject, "destructive"),
  writePolicy("claim_work", itemId, "destructive"),
  writePolicy("renew_claim", itemId, "destructive", "bounded_write", "none", "hidden"),
  writePolicy("handoff_work", itemId, "destructive"),
  writePolicy("block_work", itemId, "destructive"),
  writePolicy("unblock_work", itemId, "destructive"),
  writePolicy("release_work", itemId, "destructive", "bounded_write", "none", "hidden"),
  writePolicy("record_event", itemId, "additive", "bounded_write", "none", "hidden"),
  writePolicy(
    "remember_project_repository_setup",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "searchable",
  ),
  writePolicy("complete_work", itemId, "destructive"),
  writePolicy(
    "github_add_issue_comment",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "core",
    "open",
  ),
  writePolicy(
    "github_create_branch",
    directProject,
    "additive",
    "bounded_write",
    "none",
    "hidden",
    "open",
  ),
  writePolicy(
    "github_create_file",
    directProject,
    "additive",
    "bounded_write",
    "none",
    "hidden",
    "open",
  ),
  writePolicy(
    "github_create_issue",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "core",
    "open",
  ),
  writePolicy(
    "github_create_pull_request",
    directProject,
    "additive",
    "bounded_write",
    "none",
    "hidden",
    "open",
  ),
  writePolicy(
    "github_publish_change",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "core",
    "open",
  ),
  writePolicy(
    "github_land_pr",
    directProject,
    "destructive",
    "consequential",
    "tool_managed",
    "core",
    "open",
  ),
  writePolicy(
    "reconcile_github_publish_change",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "hidden",
    "open",
  ),
  writePolicy(
    "github_update_file",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "hidden",
    "open",
  ),
  writePolicy(
    "github_update_issue",
    directProject,
    "destructive",
    "bounded_write",
    "none",
    "core",
    "open",
  ),
  writePolicy(
    "propose_continuation",
    sourceItemId,
    "additive",
    "bounded_write",
    "none",
    "searchable",
  ),
  writePolicy(
    "edit_continuation",
    continuationId,
    "destructive",
    "bounded_write",
    "none",
    "hidden",
  ),
  writePolicy(
    "enrol_worker",
    directProject,
    "additive",
    "bounded_write",
    "none",
    "hidden",
  ),
  writePolicy(
    "resolve_continuation",
    continuationId,
    "destructive",
    "bounded_write",
    "none",
    "hidden",
  ),
  writePolicy(
    "queue_continuation_for_supervisor",
    continuationTouchSet,
    "destructive",
    "consequential",
    "tool_managed",
    "hidden",
  ),
  writePolicy(
    "run_continuation_supervisor_policy",
    continuationSupervisorPolicy,
    "destructive",
    "consequential",
    "tool_managed",
    "hidden",
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
    version: 2 as const,
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

export function compileMcpCapabilitySubmissionAnnotations(
  policy: McpCapabilityPolicy,
): McpCapabilitySubmissionAnnotations {
  const admitted = validatePolicy(policy);
  return deepFreeze({
    readOnlyHint: admitted.scope === "read",
    destructiveHint: admitted.effectKind === "destructive",
    openWorldHint: admitted.interactionDomain === "open",
  });
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
  defaultExposure: McpCapabilityExposure = "core",
  interactionDomain: McpCapabilityInteractionDomain = "closed",
): McpCapabilityPolicyInput {
  return {
    toolName,
    scope: "read",
    riskClass: "read",
    defaultExposure,
    interactionDomain,
    effectKind: "none",
    projectResolution,
    approvalPolicy: "none",
    receiptPolicy: "none",
    reconciliationPolicy: "none",
  };
}

function writePolicy(
  toolName: string,
  projectResolution: McpCapabilityProjectResolution,
  effectKind: "additive" | "destructive",
  riskClass: "bounded_write" | "consequential" = "bounded_write",
  approvalPolicy: McpCapabilityApprovalPolicy = "none",
  defaultExposure: McpCapabilityExposure = "core",
  interactionDomain: McpCapabilityInteractionDomain = "closed",
): McpCapabilityPolicyInput {
  return {
    toolName,
    scope: "write",
    riskClass,
    defaultExposure,
    interactionDomain,
    effectKind,
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
  if (!mcpCapabilityInteractionDomains.includes(input.interactionDomain)) {
    throw new RangeError(`MCP capability interaction domain is invalid for ${input.toolName}`);
  }
  if (!mcpCapabilityEffectKinds.includes(input.effectKind)) {
    throw new RangeError(`MCP capability effect kind is invalid for ${input.toolName}`);
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
  if (input.scope === "read" && input.effectKind !== "none") {
    throw new RangeError(
      `Read MCP capability ${input.toolName} must declare no environment effect`,
    );
  }
  if (input.scope === "write" && input.effectKind === "none") {
    throw new RangeError(
      `Write MCP capability ${input.toolName} must declare additive or destructive effect`,
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
    interactionDomain: input.interactionDomain,
    effectKind: input.effectKind,
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
