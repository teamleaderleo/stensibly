import { expect, test } from "bun:test";
import type { McpCapabilityPolicyInput } from "../src/mcp-capability-policy.ts";
import { simulateMcpCapabilityPolicyChange } from "../src/mcp-capability-policy-simulation.ts";

function deploymentPolicy(
  approvalPolicy: "none" | "tool_managed",
): McpCapabilityPolicyInput {
  return {
    toolName: "deploy_candidate",
    scope: "write",
    riskClass: "consequential",
    defaultExposure: "hidden",
    projectResolution: { kind: "project_argument", argument: "project" },
    approvalPolicy,
    receiptPolicy: "tool_managed",
    reconciliationPolicy: "tool_managed",
  };
}

test("classifies approval-required to allowed as widening and approval change", () => {
  const result = simulateMcpCapabilityPolicyChange({
    currentPolicyRevision: "policy:current",
    candidatePolicyRevision: "policy:candidate",
    observedAt: "2026-08-08T00:00:00.000Z",
    currentPolicies: [deploymentPolicy("tool_managed")],
    candidatePolicies: [deploymentPolicy("none")],
    subjects: [{
      subjectId: "subject:deploy",
      toolName: "deploy_candidate",
      activeWork: true,
      sourceFreshness: "current",
      sourceReferences: ["evidence:deployment-policy"],
    }],
    limit: 20,
  });

  expect(result.approvalChanged).toHaveLength(1);
  expect(result.approvalChanged[0]?.currentDecision).toBe("approval_required");
  expect(result.approvalChanged[0]?.candidateDecision).toBe("allowed_by_policy");
  expect(result.newlyAllowed).toHaveLength(1);
  expect(result.newlyAllowed[0]?.subjectId).toBe("subject:deploy");
  expect(result.activeWorkAffected).toHaveLength(1);
  expect(result.authorizesActivation).toBe(false);
  expect(result.authorizesExecution).toBe(false);
  expect(result.authorizesAuthority).toBe(false);
});
