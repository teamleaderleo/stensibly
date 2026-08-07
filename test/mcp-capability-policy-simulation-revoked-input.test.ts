import { describe, expect, test } from "bun:test";
import type { McpCapabilityPolicyInput } from "../src/mcp-capability-policy.ts";
import {
  simulateMcpCapabilityPolicyChange,
  type SimulateMcpCapabilityPolicyChangeInput,
} from "../src/mcp-capability-policy-simulation.ts";

function policy(): McpCapabilityPolicyInput {
  return {
    toolName: "survey_workspace",
    scope: "read",
    riskClass: "read",
    defaultExposure: "core",
    projectResolution: { kind: "none" },
    approvalPolicy: "none",
    receiptPolicy: "none",
    reconciliationPolicy: "none",
  };
}

function input(): SimulateMcpCapabilityPolicyChangeInput {
  return {
    currentPolicyRevision: "policy:current",
    candidatePolicyRevision: "policy:candidate",
    observedAt: "2026-08-08T00:00:00.000Z",
    currentPolicies: [policy()],
    candidatePolicies: [policy()],
    subjects: [{
      subjectId: "subject:read",
      toolName: "survey_workspace",
      activeWork: false,
      sourceFreshness: "current",
      sourceReferences: ["evidence:read"],
    }],
    limit: 10,
  };
}

describe("capability policy simulation revoked input admission", () => {
  test("normalizes a revoked top-level input", () => {
    const revoked = Proxy.revocable(input(), {});
    revoked.revoke();
    expect(() => simulateMcpCapabilityPolicyChange(
      revoked.proxy as SimulateMcpCapabilityPolicyChangeInput,
    )).toThrow("Capability policy simulation input inspection failed");
  });

  test("normalizes a revoked policy array", () => {
    const value = input();
    const revoked = Proxy.revocable(value.currentPolicies, {});
    revoked.revoke();
    Object.defineProperty(value, "currentPolicies", {
      value: revoked.proxy,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => simulateMcpCapabilityPolicyChange(value)).toThrow(
      "Capability policy simulation input inspection failed",
    );
  });

  test("normalizes a revoked policy object", () => {
    const value = input();
    const revoked = Proxy.revocable(value.currentPolicies[0]!, {});
    revoked.revoke();
    value.currentPolicies = [revoked.proxy as McpCapabilityPolicyInput];
    expect(() => simulateMcpCapabilityPolicyChange(value)).toThrow(
      "Capability policy simulation input inspection failed",
    );
  });

  test("normalizes a revoked subject array", () => {
    const value = input();
    const revoked = Proxy.revocable(value.subjects, {});
    revoked.revoke();
    Object.defineProperty(value, "subjects", {
      value: revoked.proxy,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(() => simulateMcpCapabilityPolicyChange(value)).toThrow(
      "Capability policy simulation input inspection failed",
    );
  });

  test("normalizes a revoked subject object", () => {
    const value = input();
    const revoked = Proxy.revocable(value.subjects[0]!, {});
    revoked.revoke();
    value.subjects = [revoked.proxy as typeof value.subjects[number]];
    expect(() => simulateMcpCapabilityPolicyChange(value)).toThrow(
      "Capability policy simulation input inspection failed",
    );
  });
});
