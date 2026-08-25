import { sha256, stableJson } from "./canonical-json.js";
import {
  compileMcpCapabilityPolicyRegistry,
  type McpCapabilityExposure,
  type McpCapabilityPolicyRegistry,
} from "./mcp-capability-policy.js";

export const mcpCapabilityExposureProfiles = [
  "published_default",
  "published_plus_searchable",
  "full_internal",
] as const;

export type McpCapabilityExposureProfile =
  typeof mcpCapabilityExposureProfiles[number];

export interface McpCapabilityExposureSelection {
  readonly version: 1;
  readonly profile: McpCapabilityExposureProfile;
  readonly policyRegistryFingerprint: string;
  readonly includedExposures: readonly McpCapabilityExposure[];
  readonly toolNames: readonly string[];
  readonly grantsAuthority: false;
  readonly authorizesToolRegistration: false;
  readonly fingerprint: string;
}

const exposuresByProfile: Readonly<
  Record<McpCapabilityExposureProfile, readonly McpCapabilityExposure[]>
> = Object.freeze({
  published_default: Object.freeze(["core"] as McpCapabilityExposure[]),
  published_plus_searchable: Object.freeze([
    "core",
    "searchable",
  ] as McpCapabilityExposure[]),
  full_internal: Object.freeze([
    "core",
    "searchable",
    "hidden",
  ] as McpCapabilityExposure[]),
});

export function compileMcpCapabilityExposureSelection(
  registry: McpCapabilityPolicyRegistry,
  profile: McpCapabilityExposureProfile,
): McpCapabilityExposureSelection {
  if (!mcpCapabilityExposureProfiles.includes(profile)) {
    throw new RangeError("MCP capability exposure profile is invalid");
  }

  const canonicalRegistry = compileMcpCapabilityPolicyRegistry(registry.policies);
  if (
    registry.version !== canonicalRegistry.version
    || registry.fingerprint !== canonicalRegistry.fingerprint
  ) {
    throw new RangeError("MCP capability policy registry integrity check failed");
  }

  const includedExposures = exposuresByProfile[profile];
  const exposureSet = new Set<McpCapabilityExposure>(includedExposures);
  const toolNames = canonicalRegistry.policies
    .filter((policy) => exposureSet.has(policy.defaultExposure))
    .map((policy) => policy.toolName);

  const canonical = {
    version: 1 as const,
    profile,
    policyRegistryFingerprint: canonicalRegistry.fingerprint,
    includedExposures: [...includedExposures],
    toolNames,
    grantsAuthority: false as const,
    authorizesToolRegistration: false as const,
  };

  return deepFreeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
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
