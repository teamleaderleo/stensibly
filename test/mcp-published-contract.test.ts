import { describe, expect, test } from "bun:test";
import {
  compileMcpCapabilityPolicyRegistry,
  mcpCapabilityPolicyRegistry,
  type McpCapabilityPolicy,
  type McpCapabilityPolicyRegistry,
} from "../src/mcp-capability-policy.ts";
import {
  compileMcpPublishedContract,
} from "../src/mcp-published-contract.ts";
import {
  diffMcpReleaseManifests,
  type McpToolContract,
} from "../src/mcp-release-manifest.ts";

const fixturePolicyNames = [
  "get_brief",
  "get_github_project_context",
  "get_operation_receipt",
  "github_create_issue",
] as const;

function fixtureRegistry(): McpCapabilityPolicyRegistry {
  const policies = fixturePolicyNames.map((name) => {
    const policy = mcpCapabilityPolicyRegistry.policies.find(
      (candidate) => candidate.toolName === name,
    );
    if (!policy) throw new Error(`Missing fixture policy: ${name}`);
    return policy;
  });
  return compileMcpCapabilityPolicyRegistry(policies);
}

function replacePolicy(
  registry: McpCapabilityPolicyRegistry,
  toolName: string,
  update: (policy: McpCapabilityPolicy) => McpCapabilityPolicy,
): McpCapabilityPolicyRegistry {
  return compileMcpCapabilityPolicyRegistry(
    registry.policies.map((policy) => policy.toolName === toolName ? update(policy) : policy),
  );
}

function fixtureTools(): McpToolContract[] {
  return [
    {
      name: "github_create_issue",
      description: "Create one bounded GitHub issue.",
      annotations: { idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, title: { type: "string" } },
        required: ["project", "title"],
        additionalProperties: false,
      },
    },
    {
      name: "get_operation_receipt",
      description: "Read one internal operation receipt.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
        additionalProperties: false,
      },
    },
    {
      name: "get_brief",
      description: "Read one compact project brief.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
        additionalProperties: false,
      },
    },
    {
      name: "get_github_project_context",
      description: "Read accepted GitHub project context.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
        additionalProperties: false,
      },
    },
  ];
}

describe("MCP published contract", () => {
  test("compiles the selected profile with canonical submission annotations", () => {
    const contract = compileMcpPublishedContract(
      fixtureTools(),
      fixtureRegistry(),
      "published_default",
    );

    expect(contract.publishedManifest.tools.map((tool) => tool.name)).toEqual([
      "get_brief",
      "github_create_issue",
    ]);
    expect(contract.publishedManifest.tools[0]!.annotations).toEqual({
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    });
    expect(contract.publishedManifest.tools[1]!.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    });
    expect(contract.publishedContractFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(contract.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(contract.grantsAuthority).toBe(false);
    expect(contract.authorizesToolRegistration).toBe(false);
    expect(contract.authorizesPublication).toBe(false);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.publishedManifest)).toBe(true);
    expect(Object.isFrozen(contract.publishedManifest.tools)).toBe(true);
    expect(Object.isFrozen(contract.publishedManifest.tools[0])).toBe(true);
  });

  test("includes searchable tools only when that publication profile is selected", () => {
    const registry = fixtureRegistry();
    const published = compileMcpPublishedContract(
      fixtureTools(),
      registry,
      "published_default",
    );
    const discoverable = compileMcpPublishedContract(
      fixtureTools(),
      registry,
      "published_plus_searchable",
    );

    expect(published.publishedManifest.tools.map((tool) => tool.name)).not.toContain(
      "get_github_project_context",
    );
    expect(discoverable.publishedManifest.tools.map((tool) => tool.name)).toEqual([
      "get_brief",
      "get_github_project_context",
      "github_create_issue",
    ]);
    expect(discoverable.publishedContractFingerprint).not.toBe(
      published.publishedContractFingerprint,
    );
  });

  test("keeps internal-only policy drift out of the public compatibility fingerprint", () => {
    const registry = fixtureRegistry();
    const original = compileMcpPublishedContract(
      fixtureTools(),
      registry,
      "published_default",
    );
    const changedRegistry = replacePolicy(
      registry,
      "get_operation_receipt",
      (policy) => ({ ...policy, interactionDomain: "open" }),
    );
    const changed = compileMcpPublishedContract(
      fixtureTools(),
      changedRegistry,
      "published_default",
    );

    expect(changed.policyRegistryFingerprint).not.toBe(original.policyRegistryFingerprint);
    expect(changed.exposureSelectionFingerprint).not.toBe(
      original.exposureSelectionFingerprint,
    );
    expect(changed.publishedManifest.digest).toBe(original.publishedManifest.digest);
    expect(changed.publishedContractFingerprint).toBe(
      original.publishedContractFingerprint,
    );
    expect(changed.fingerprint).not.toBe(original.fingerprint);
  });

  test("keeps unselected tool-contract drift out of the public compatibility fingerprint", () => {
    const registry = fixtureRegistry();
    const tools = fixtureTools();
    const original = compileMcpPublishedContract(tools, registry, "published_default");
    const changedTools = tools.map((tool) => tool.name === "get_operation_receipt"
      ? { ...tool, description: "Changed internal receipt description." }
      : tool);
    const changed = compileMcpPublishedContract(
      changedTools,
      registry,
      "published_default",
    );

    expect(changed.sourceManifestDigest).not.toBe(original.sourceManifestDigest);
    expect(changed.publishedManifest.digest).toBe(original.publishedManifest.digest);
    expect(changed.publishedContractFingerprint).toBe(
      original.publishedContractFingerprint,
    );
    expect(changed.fingerprint).not.toBe(original.fingerprint);
  });

  test("rotates the public contract when a selected canonical annotation changes", () => {
    const registry = fixtureRegistry();
    const original = compileMcpPublishedContract(
      fixtureTools(),
      registry,
      "published_default",
    );
    const changedRegistry = replacePolicy(
      registry,
      "get_brief",
      (policy) => ({ ...policy, interactionDomain: "open" }),
    );
    const changed = compileMcpPublishedContract(
      fixtureTools(),
      changedRegistry,
      "published_default",
    );

    expect(changed.publishedManifest.digest).not.toBe(original.publishedManifest.digest);
    expect(changed.publishedContractFingerprint).not.toBe(
      original.publishedContractFingerprint,
    );
    expect(changed.publishedManifest.tools[0]!.annotations.openWorldHint).toBe(true);
  });

  test("turns a selected visibility removal into the existing breaking release classification", () => {
    const registry = fixtureRegistry();
    const original = compileMcpPublishedContract(
      fixtureTools(),
      registry,
      "published_default",
    );
    const changedRegistry = replacePolicy(
      registry,
      "get_brief",
      (policy) => ({ ...policy, defaultExposure: "searchable" }),
    );
    const changed = compileMcpPublishedContract(
      fixtureTools(),
      changedRegistry,
      "published_default",
    );
    const diff = diffMcpReleaseManifests(
      original.publishedManifest,
      changed.publishedManifest,
    );

    expect(changed.publishedManifest.tools.map((tool) => tool.name)).toEqual([
      "github_create_issue",
    ]);
    expect(changed.publishedContractFingerprint).not.toBe(
      original.publishedContractFingerprint,
    );
    expect(diff.classification).toBe("breaking-contract-change");
    expect(diff.chatGptAction).toBe("preserve-compatibility-or-recreate");
  });

  test("rejects selected tools missing from the supplied source contract", () => {
    expect(() => compileMcpPublishedContract(
      fixtureTools().filter((tool) => tool.name !== "github_create_issue"),
      fixtureRegistry(),
      "published_default",
    )).toThrow("Selected MCP publication tool is missing: github_create_issue");
  });

  test("rejects source annotations that contradict canonical submission risk", () => {
    const tools = fixtureTools().map((tool) => tool.name === "get_brief"
      ? { ...tool, annotations: { readOnlyHint: false } }
      : tool);

    expect(() => compileMcpPublishedContract(
      tools,
      fixtureRegistry(),
      "published_default",
    )).toThrow(
      "MCP publication annotation readOnlyHint contradicts canonical policy for get_brief",
    );
  });

  test("is deterministic across source tool ordering", () => {
    const tools = fixtureTools();
    const registry = fixtureRegistry();
    const forward = compileMcpPublishedContract(tools, registry, "published_default");
    const reversed = compileMcpPublishedContract(
      [...tools].reverse(),
      registry,
      "published_default",
    );

    expect(reversed.sourceManifestDigest).toBe(forward.sourceManifestDigest);
    expect(reversed.publishedManifest).toEqual(forward.publishedManifest);
    expect(reversed.publishedContractFingerprint).toBe(
      forward.publishedContractFingerprint,
    );
    expect(reversed.fingerprint).toBe(forward.fingerprint);
  });
});
