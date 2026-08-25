import { describe, expect, test } from "bun:test";
import {
  compileMcpCapabilityPolicyRegistry,
  mcpCapabilityPolicyRegistry,
  type McpCapabilityPolicyRegistry,
} from "../src/mcp-capability-policy.ts";
import {
  compileMcpCapabilityExposureSelection,
  type McpCapabilityExposureProfile,
} from "../src/mcp-exposure-selection.ts";

describe("MCP capability exposure selection", () => {
  test("projects the existing policy registry without changing registration", () => {
    const published = compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "published_default",
    );
    const searchable = compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "published_plus_searchable",
    );
    const full = compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "full_internal",
    );

    expect(published.toolNames).toEqual(
      mcpCapabilityPolicyRegistry.policies
        .filter((policy) => policy.defaultExposure === "core")
        .map((policy) => policy.toolName),
    );
    expect(searchable.toolNames).toEqual(
      mcpCapabilityPolicyRegistry.policies
        .filter((policy) => policy.defaultExposure !== "hidden")
        .map((policy) => policy.toolName),
    );
    expect(full.toolNames).toEqual(
      mcpCapabilityPolicyRegistry.policies.map((policy) => policy.toolName),
    );
    expect(published.includedExposures).toEqual(["core"]);
    expect(searchable.includedExposures).toEqual(["core", "searchable"]);
    expect(full.includedExposures).toEqual(["core", "searchable", "hidden"]);

    for (const selection of [published, searchable, full]) {
      expect(selection.policyRegistryFingerprint).toBe(
        mcpCapabilityPolicyRegistry.fingerprint,
      );
      expect(selection.grantsAuthority).toBe(false);
      expect(selection.authorizesToolRegistration).toBe(false);
      expect(selection.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  test("keeps core, searchable, and hidden policy in one source of truth", () => {
    const template = mcpCapabilityPolicyRegistry.policies.find(
      (policy) => policy.toolName === "get_brief",
    )!;
    const registry = compileMcpCapabilityPolicyRegistry([
      { ...template, toolName: "gamma_hidden", defaultExposure: "hidden" },
      { ...template, toolName: "alpha_core", defaultExposure: "core" },
      { ...template, toolName: "beta_searchable", defaultExposure: "searchable" },
    ]);

    expect(compileMcpCapabilityExposureSelection(
      registry,
      "published_default",
    ).toolNames).toEqual(["alpha_core"]);
    expect(compileMcpCapabilityExposureSelection(
      registry,
      "published_plus_searchable",
    ).toolNames).toEqual(["alpha_core", "beta_searchable"]);
    expect(compileMcpCapabilityExposureSelection(
      registry,
      "full_internal",
    ).toolNames).toEqual(["alpha_core", "beta_searchable", "gamma_hidden"]);
  });

  test("binds selection identity to the exact policy registry", () => {
    const original = compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "published_default",
    );
    const changedRegistry = compileMcpCapabilityPolicyRegistry(
      mcpCapabilityPolicyRegistry.policies.map((policy) =>
        policy.toolName === "get_brief"
          ? { ...policy, defaultExposure: "searchable" as const }
          : policy
      ),
    );
    const changed = compileMcpCapabilityExposureSelection(
      changedRegistry,
      "published_default",
    );

    expect(changedRegistry.fingerprint).not.toBe(
      mcpCapabilityPolicyRegistry.fingerprint,
    );
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(changed.toolNames).not.toContain("get_brief");
  });

  test("rejects forged registry identity and unsupported profiles", () => {
    const forged = {
      ...mcpCapabilityPolicyRegistry,
      fingerprint: `sha256:${"0".repeat(64)}`,
    } as McpCapabilityPolicyRegistry;

    expect(() => compileMcpCapabilityExposureSelection(
      forged,
      "published_default",
    )).toThrow("policy registry integrity check failed");
    expect(() => compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "unknown" as McpCapabilityExposureProfile,
    )).toThrow("exposure profile is invalid");
  });

  test("returns deeply frozen authority-free selections", () => {
    const selection = compileMcpCapabilityExposureSelection(
      mcpCapabilityPolicyRegistry,
      "published_plus_searchable",
    );

    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.includedExposures)).toBe(true);
    expect(Object.isFrozen(selection.toolNames)).toBe(true);
    expect(selection.grantsAuthority).toBe(false);
    expect(selection.authorizesToolRegistration).toBe(false);
  });
});
