import { sha256, stableJson } from "./canonical-json.js";
import {
  compileMcpCapabilityPolicyRegistry,
  compileMcpCapabilitySubmissionAnnotations,
  type McpCapabilityPolicy,
  type McpCapabilityPolicyRegistry,
} from "./mcp-capability-policy.js";
import {
  compileMcpCapabilityExposureSelection,
  type McpCapabilityExposureProfile,
} from "./mcp-exposure-selection.js";
import {
  createMcpReleaseManifest,
  type McpReleaseManifest,
  type McpToolContract,
} from "./mcp-release-manifest.js";

export const MCP_PUBLISHED_CONTRACT_VERSION = 1;

export interface McpPublishedContract {
  readonly version: typeof MCP_PUBLISHED_CONTRACT_VERSION;
  readonly profile: McpCapabilityExposureProfile;
  readonly sourceManifestDigest: string;
  readonly policyRegistryFingerprint: string;
  readonly exposureSelectionFingerprint: string;
  readonly publishedManifest: McpReleaseManifest;
  readonly publishedContractFingerprint: string;
  readonly grantsAuthority: false;
  readonly authorizesToolRegistration: false;
  readonly authorizesPublication: false;
  readonly fingerprint: string;
}

const submissionAnnotationKeys = [
  "readOnlyHint",
  "destructiveHint",
  "openWorldHint",
] as const;

export function compileMcpPublishedContract(
  tools: readonly McpToolContract[],
  registry: McpCapabilityPolicyRegistry,
  profile: McpCapabilityExposureProfile,
): McpPublishedContract {
  const canonicalRegistry = compileMcpCapabilityPolicyRegistry(registry.policies);
  if (
    registry.version !== canonicalRegistry.version
    || registry.fingerprint !== canonicalRegistry.fingerprint
  ) {
    throw new RangeError("MCP capability policy registry integrity check failed");
  }

  const selection = compileMcpCapabilityExposureSelection(canonicalRegistry, profile);
  const sourceManifest = createMcpReleaseManifest(tools);
  const sourceToolsByName = new Map(
    sourceManifest.tools.map((tool) => [tool.name, tool] as const),
  );
  const policiesByName = new Map(
    canonicalRegistry.policies.map((policy) => [policy.toolName, policy] as const),
  );

  const publishedTools: McpToolContract[] = selection.toolNames.map((toolName) => {
    const sourceTool = sourceToolsByName.get(toolName);
    if (!sourceTool) {
      throw new RangeError(`Selected MCP publication tool is missing: ${toolName}`);
    }
    const policy = policiesByName.get(toolName);
    if (!policy) {
      throw new RangeError(`Selected MCP publication policy is missing: ${toolName}`);
    }
    return {
      name: sourceTool.name,
      description: sourceTool.description,
      annotations: compilePublishedAnnotations(sourceTool.annotations, policy),
      inputSchema: sourceTool.inputSchema,
    };
  });

  const publishedManifest = createMcpReleaseManifest(publishedTools);
  const publicIdentity = {
    version: MCP_PUBLISHED_CONTRACT_VERSION,
    profile,
    publishedManifestDigest: publishedManifest.digest,
  } as const;
  const publishedContractFingerprint = sha256(stableJson(publicIdentity));
  const canonical = {
    version: MCP_PUBLISHED_CONTRACT_VERSION,
    profile,
    sourceManifestDigest: sourceManifest.digest,
    policyRegistryFingerprint: canonicalRegistry.fingerprint,
    exposureSelectionFingerprint: selection.fingerprint,
    publishedManifest,
    publishedContractFingerprint,
    grantsAuthority: false as const,
    authorizesToolRegistration: false as const,
    authorizesPublication: false as const,
  };

  return deepFreeze({
    ...canonical,
    fingerprint: sha256(stableJson(canonical)),
  });
}

function compilePublishedAnnotations(
  source: Readonly<Record<string, unknown>>,
  policy: McpCapabilityPolicy,
): Record<string, unknown> {
  const expected = compileMcpCapabilitySubmissionAnnotations(policy);
  const annotations: Record<string, unknown> = { ...source };

  for (const key of submissionAnnotationKeys) {
    if (Object.hasOwn(annotations, key) && annotations[key] !== expected[key]) {
      throw new RangeError(
        `MCP publication annotation ${key} contradicts canonical policy for ${policy.toolName}`,
      );
    }
    annotations[key] = expected[key];
  }

  return annotations;
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
