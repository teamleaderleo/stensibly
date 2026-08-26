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
          ? withCanonicalSubmissionAnnotations(toolName, policy, args)
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

function withCanonicalSubmissionAnnotations(
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
  return [
    {
      ...config,
      annotations: {
        ...existing,
        ...canonical,
      },
    },
    ...args.slice(1),
  ];
}

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
