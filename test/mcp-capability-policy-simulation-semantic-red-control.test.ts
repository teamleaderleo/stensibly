import { describe, expect, test } from "bun:test";
import type { McpCapabilityPolicyInput } from "../src/mcp-capability-policy.ts";
import {
  simulateMcpCapabilityPolicyChange,
  type McpCapabilityPolicySimulation,
  type McpPolicySimulationSubjectInput,
  type SimulateMcpCapabilityPolicyChangeInput,
} from "../src/mcp-capability-policy-simulation.ts";

function writePolicy(
  receiptPolicy: "none" | "tool_managed",
  reconciliationPolicy: "none" | "tool_managed",
): McpCapabilityPolicyInput {
  return {
    toolName: "github_create_issue",
    scope: "write",
    riskClass: "bounded_write",
    defaultExposure: "core",
    projectResolution: { kind: "project_argument", argument: "project" },
    approvalPolicy: "none",
    receiptPolicy,
    reconciliationPolicy,
  };
}

function readPolicy(exposure: "core" | "hidden"): McpCapabilityPolicyInput {
  return {
    toolName: "survey_workspace",
    scope: "read",
    riskClass: "read",
    defaultExposure: exposure,
    projectResolution: { kind: "none" },
    approvalPolicy: "none",
    receiptPolicy: "none",
    reconciliationPolicy: "none",
  };
}

function subject(
  subjectId: string,
  toolName: string,
  sourceReference: string,
): McpPolicySimulationSubjectInput {
  return {
    subjectId,
    toolName,
    activeWork: false,
    sourceFreshness: "current",
    sourceReferences: [sourceReference],
  };
}

function input(
  currentPolicies: McpCapabilityPolicyInput[],
  candidatePolicies: McpCapabilityPolicyInput[],
  subjects: McpPolicySimulationSubjectInput[],
  limit = 20,
): SimulateMcpCapabilityPolicyChangeInput {
  return {
    currentPolicyRevision: "policy:current",
    candidatePolicyRevision: "policy:candidate",
    observedAt: "2026-08-08T00:00:00.000Z",
    currentPolicies,
    candidatePolicies,
    subjects,
    limit,
  };
}

function retainsDifferenceFor(
  simulation: McpCapabilityPolicySimulation,
  subjectId: string,
): boolean {
  for (const value of Object.values(simulation as unknown as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (
        entry !== null
        && typeof entry === "object"
        && (entry as { subjectId?: unknown }).subjectId === subjectId
      ) {
        return true;
      }
    }
  }
  return false;
}

describe("MCP capability policy simulation semantic red controls", () => {
  test("does not report receipt and reconciliation policy changes as unchanged", () => {
    const simulation = simulateMcpCapabilityPolicyChange(input(
      [writePolicy("none", "none")],
      [writePolicy("tool_managed", "tool_managed")],
      [subject(
        "subject:receipt-semantics",
        "github_create_issue",
        "evidence:receipt-semantics",
      )],
    ));

    expect(simulation.unchangedSampleCount).toBe(0);
    expect(retainsDifferenceFor(simulation, "subject:receipt-semantics")).toBe(true);
  });

  test("retains source references from differences omitted only by presentation limit", () => {
    const simulation = simulateMcpCapabilityPolicyChange(input(
      [readPolicy("core")],
      [readPolicy("hidden")],
      [
        subject("subject:a", "survey_workspace", "evidence:a"),
        subject("subject:b", "survey_workspace", "evidence:b"),
      ],
      1,
    ));

    expect(simulation.exposureChanged).toHaveLength(1);
    expect(simulation.omittedCounts.exposureChanged).toBe(1);
    expect(simulation.sourceReferences).toEqual(["evidence:a", "evidence:b"]);
    expect(simulation.omittedCounts.sourceReferences).toBe(0);
  });
});
