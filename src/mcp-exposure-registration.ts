import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  compileMcpCapabilitySubmissionAnnotations,
  mcpCapabilityPolicyRegistry,
  requireMcpCapabilityPolicy,
} from "./mcp-capability-policy.js";
import {
  compileMcpCapabilityExposureSelection,
  type McpCapabilityExposureProfile,
} from "./mcp-exposure-selection.js";
import {
  MCP_TOOL_MANIFEST_VERSION,
  mcpToolManifestForLedger,
  type McpToolManifestIdentity,
} from "./mcp-diagnostics.js";
import {
  expandPublicMcpInput,
  publicMcpInputSchema,
} from "./public-mcp-input-schemas.js";
import { publicMcpOutputSchema } from "./public-mcp-output-schemas.js";
import { compactPublicMcpResult } from "./public-mcp-result.js";

export interface McpExposureRegistrationPlan {
  readonly profile: McpCapabilityExposureProfile;
  readonly policySelectionFingerprint: string;
  readonly manifest: McpToolManifestIdentity;
  readonly grantsAuthority: false;
  readonly authorizesPublication: false;
}

export interface McpExposureRegistrationFilter {
  readonly server: McpServer;
  complete(registeredToolNames: readonly string[]): readonly string[];
}

export function compileMcpExposureRegistrationPlan(
  ledger: unknown,
  profile: McpCapabilityExposureProfile = "full_internal",
): McpExposureRegistrationPlan {
  const availableManifest = mcpToolManifestForLedger(ledger);
  const selection = compileMcpCapabilityExposureSelection(
    mcpCapabilityPolicyRegistry,
    profile,
  );
  const selected = new Set(selection.toolNames);
  const toolNames = availableManifest.tools.filter((toolName) => selected.has(toolName));
  if (toolNames.length === 0) {
    throw new RangeError("MCP exposure registration profile selected no available tools");
  }

  return deepFreeze({
    profile,
    policySelectionFingerprint: selection.fingerprint,
    manifest: toolManifestIdentity(toolNames),
    grantsAuthority: false as const,
    authorizesPublication: false as const,
  });
}

export function createMcpExposureRegistrationFilter(
  server: McpServer,
  expectedToolNames: readonly string[],
): McpExposureRegistrationFilter {
  const expected = new Set(expectedToolNames);
  if (expected.size === 0 || expected.size !== expectedToolNames.length) {
    throw new RangeError("MCP exposure registration requires unique selected tools");
  }
  const policies = expectedToolNames.map((toolName) => requireMcpCapabilityPolicy(toolName));
  const canonicalizeSubmissionAnnotations = policies.every(
    (policy) => policy.defaultExposure === "core",
  );

  const encountered = new Set<string>();
  const filtered = new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "registerTool") {
        return Reflect.get(target, property, receiver);
      }
      return (toolName: string, ...args: unknown[]) => {
        const policy = requireMcpCapabilityPolicy(toolName);
        if (encountered.has(toolName)) {
          throw new RangeError(`Duplicate MCP tool registration: ${toolName}`);
        }
        encountered.add(toolName);
        if (!expected.has(toolName)) return undefined;

        const registerTool = Reflect.get(target, property, target) as (
          name: string,
          ...registrationArgs: unknown[]
        ) => unknown;
        const registrationArgs = canonicalizeSubmissionAnnotations
          ? withCanonicalSubmissionMetadata(toolName, policy, args)
          : args;
        return Reflect.apply(registerTool, target, [toolName, ...registrationArgs]);
      };
    },
  }) as McpServer;

  return {
    server: filtered,
    complete(registeredToolNames) {
      const registered = [...registeredToolNames].sort(codeUnitCompare);
      const selectedEncountered = expectedToolNames
        .filter((toolName) => encountered.has(toolName))
        .sort(codeUnitCompare);
      if (
        registered.length !== selectedEncountered.length
        || registered.some((toolName, index) => toolName !== selectedEncountered[index])
      ) {
        throw new RangeError("MCP exposure registration did not match selected tools");
      }
      return Object.freeze(selectedEncountered);
    },
  };
}

function withCanonicalSubmissionMetadata(
  toolName: string,
  policy: ReturnType<typeof requireMcpCapabilityPolicy>,
  args: readonly unknown[],
): unknown[] {
  const config = args[0];
  if (!isRecord(config)) {
    throw new RangeError(`MCP tool registration config is invalid: ${toolName}`);
  }
  const existing = config.annotations === undefined
    ? {}
    : isRecord(config.annotations)
    ? config.annotations
    : null;
  if (!existing) {
    throw new RangeError(`MCP tool registration annotations are invalid: ${toolName}`);
  }
  const canonical = compileMcpCapabilitySubmissionAnnotations(policy);
  for (const [key, value] of Object.entries(canonical)) {
    if (Object.hasOwn(existing, key) && existing[key] !== value) {
      throw new RangeError(
        `MCP publication annotation ${key} contradicts canonical policy for ${toolName}`,
      );
    }
  }
  const title = publicToolTitles[toolName];
  if (!title) {
    throw new RangeError(`MCP publication title is missing for ${toolName}`);
  }
  const description = publicToolDescriptions[toolName];
  if (!description) {
    throw new RangeError(`MCP publication description is missing for ${toolName}`);
  }
  const handler = args[1];
  if (typeof handler !== "function") {
    throw new RangeError(`MCP tool registration handler is invalid: ${toolName}`);
  }
  return [
    {
      ...config,
      title,
      description,
      inputSchema: publicMcpInputSchema(toolName, config.inputSchema),
      outputSchema: config.outputSchema ?? publicMcpOutputSchema(toolName),
      annotations: {
        ...existing,
        ...canonical,
      },
    },
    async (input: unknown, extra: unknown) => compactPublicMcpResult(
      await handler(expandPublicMcpInput(toolName, input), extra),
    ),
    ...args.slice(2),
  ];
}

const publicToolTitles: Readonly<Record<string, string>> = Object.freeze({
  attach_artifact: "Attach",
  block_work: "Block",
  claim_work: "Claim",
  complete_work: "Complete",
  create_item: "Create",
  dispatch_work: "Dispatch",
  get_brief: "Brief",
  get_project_attachment: "Policy",
  get_runner_context: "Run Context",
  github_add_issue_comment: "Comment",
  github_ci_diagnose: "CI",
  github_create_issue: "New Issue",
  github_get_issue: "Issue",
  github_land_pr: "Land PR",
  github_publish_change: "Publish Change",
  github_repo_health: "Repo Health",
  github_search_issues: "Find Issues",
  github_update_issue: "Update Issue",
  handoff_work: "Handoff",
  list_work: "Work",
  unblock_work: "Unblock",
});

const publicToolDescriptions: Readonly<Record<string, string>> = Object.freeze({
  attach_artifact: "Attach one durable evidence reference to an item.",
  block_work: "Block claimed work and release its lease at the current generation.",
  claim_work: "Claim ready work for a bounded lease.",
  complete_work: "Complete claimed work at the current generation.",
  create_item: "Create one project work item.",
  dispatch_work: "Claim one exact item generation and dispatch one runner profile.",
  get_brief: "Read attention, blockers, results and ready candidates with exact refs. Provider readiness is unverified. Reuse previousFingerprint for unchanged reads.",
  get_project_attachment: "Read accepted project policy and attachment recovery state.",
  get_runner_context: "Read the bounded canonical item, run, source, and receipt packet with its claim handoff.",
  github_add_issue_comment: "Add one idempotent comment to a bound GitHub issue.",
  github_ci_diagnose: "Join PR head, statuses, runs, failed jobs, and optional failed steps.",
  github_create_issue: "Create one idempotent issue in a bound GitHub repository.",
  github_get_issue: "Read one body-free GitHub issue snapshot with revision evidence.",
  github_land_pr: "Land one exact PR after authority, revision, CI, and review fences pass.",
  github_publish_change: "Create an exact branch and file change, then open a draft PR.",
  github_repo_health: "Read bound repository identity, head, health, and operation readiness.",
  github_search_issues: "Search issues inside one bound GitHub repository.",
  github_update_issue: "Update one issue behind its exact source-revision fence.",
  handoff_work: "Release claimed work with one summary and next action.",
  list_work: "List work by optional project and status.",
  unblock_work: "Return blocked work to ready at the current generation.",
});

function toolManifestIdentity(tools: readonly string[]): McpToolManifestIdentity {
  const canonicalTools = Object.freeze([...tools]);
  const manifestJson = JSON.stringify({
    version: MCP_TOOL_MANIFEST_VERSION,
    tools: canonicalTools,
  });
  const fingerprint = `sha256:${createHash("sha256")
    .update(manifestJson)
    .digest("hex")}`;
  const revision = fingerprint.slice("sha256:".length, "sha256:".length + 12);
  return Object.freeze({
    fingerprint,
    revision,
    serverVersion: `0.0.1+manifest.${revision}`,
    tools: canonicalTools,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
