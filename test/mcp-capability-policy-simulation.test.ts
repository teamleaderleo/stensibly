import { describe, expect, test } from "bun:test";
import type { McpCapabilityPolicyInput } from "../src/mcp-capability-policy.ts";
import {
  compileMcpCapabilityPolicySimulationArtifacts,
  simulateMcpCapabilityPolicyChange,
  type McpPolicySimulationSubjectInput,
  type SimulateMcpCapabilityPolicyChangeInput,
} from "../src/mcp-capability-policy-simulation.ts";

const SHA = "a".repeat(40);

function readPolicy(
  toolName: string,
  exposure: "core" | "searchable" | "hidden" = "core",
): McpCapabilityPolicyInput {
  return {
    toolName,
    scope: "read",
    riskClass: "read",
    defaultExposure: exposure,
    projectResolution: { kind: "none" },
    approvalPolicy: "none",
    receiptPolicy: "none",
    reconciliationPolicy: "none",
  };
}

function writePolicy(
  toolName: string,
  options: {
    risk?: "bounded_write" | "consequential";
    exposure?: "core" | "searchable" | "hidden";
    approval?: "none" | "tool_managed";
    resolution?: McpCapabilityPolicyInput["projectResolution"];
  } = {},
): McpCapabilityPolicyInput {
  return {
    toolName,
    scope: "write",
    riskClass: options.risk ?? "bounded_write",
    defaultExposure: options.exposure ?? "core",
    projectResolution: options.resolution ?? {
      kind: "project_argument",
      argument: "project",
    },
    approvalPolicy: options.approval ?? "none",
    receiptPolicy: "tool_managed",
    reconciliationPolicy: "tool_managed",
  };
}

function subject(
  subjectId: string,
  toolName: string,
  overrides: Partial<McpPolicySimulationSubjectInput> = {},
): McpPolicySimulationSubjectInput {
  return {
    subjectId,
    toolName,
    activeWork: false,
    sourceFreshness: "current",
    sourceReferences: [`evidence:${subjectId}`],
    ...overrides,
  };
}

function simulationInput(
  currentPolicies: McpCapabilityPolicyInput[],
  candidatePolicies: McpCapabilityPolicyInput[],
  subjects: McpPolicySimulationSubjectInput[],
): SimulateMcpCapabilityPolicyChangeInput {
  return {
    currentPolicyRevision: "policy:current",
    candidatePolicyRevision: "policy:candidate",
    observedAt: "2026-08-08T00:00:00.000Z",
    currentPolicies,
    candidatePolicies,
    subjects,
    limit: 20,
  };
}

describe("MCP capability policy simulation", () => {
  test("keeps an unchanged bounded read quiet", () => {
    const result = simulateMcpCapabilityPolicyChange(simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace")],
      [subject("subject:read", "survey_workspace")],
    ));

    expect(result.unchangedSampleCount).toBe(1);
    expect(result.newlyAllowed).toEqual([]);
    expect(result.newlyDenied).toEqual([]);
    expect(result.approvalChanged).toEqual([]);
    expect(result.coverage).toBe("representative");
    expect(result.authorizesActivation).toBe(false);
    expect(result.authorizesExecution).toBe(false);
    expect(result.authorizesAuthority).toBe(false);
    expect(result.simulationFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("classifies policy introduction and removal", () => {
    const current = [readPolicy("survey_workspace")];
    const candidate = [
      readPolicy("survey_workspace"),
      writePolicy("github_create_issue"),
    ];
    const added = simulateMcpCapabilityPolicyChange(simulationInput(
      current,
      candidate,
      [subject("subject:create", "github_create_issue", { activeWork: true })],
    ));

    expect(added.newlyAllowed).toHaveLength(1);
    expect(added.newlyAllowed[0]?.currentDecision).toBe("denied_by_policy");
    expect(added.newlyAllowed[0]?.candidateDecision).toBe("allowed_by_policy");
    expect(added.activeWorkAffected).toHaveLength(1);

    const removed = simulateMcpCapabilityPolicyChange(simulationInput(
      candidate,
      current,
      [subject("subject:create", "github_create_issue")],
    ));
    expect(removed.newlyDenied).toHaveLength(1);
    expect(removed.newlyDenied[0]?.candidateDecision).toBe("denied_by_policy");
  });

  test("separates approval, exposure, risk, and project-resolution changes", () => {
    const current = writePolicy("deploy_candidate", {
      risk: "bounded_write",
      exposure: "core",
      approval: "none",
      resolution: { kind: "project_argument", argument: "project" },
    });
    const candidate = writePolicy("deploy_candidate", {
      risk: "consequential",
      exposure: "hidden",
      approval: "tool_managed",
      resolution: { kind: "item_argument", argument: "id" },
    });
    const result = simulateMcpCapabilityPolicyChange(simulationInput(
      [current],
      [candidate],
      [subject("subject:deploy", "deploy_candidate", { activeWork: true })],
    ));

    expect(result.approvalChanged).toHaveLength(1);
    expect(result.exposureChanged).toHaveLength(1);
    expect(result.riskChanged).toHaveLength(1);
    expect(result.projectResolutionChanged).toHaveLength(1);
    expect(result.activeWorkAffected).toHaveLength(1);
    expect(result.approvalChanged[0]?.candidateDecision).toBe("approval_required");
    expect(result.riskChanged[0]?.candidateRiskClass).toBe("consequential");
  });

  test("marks stale and unavailable evidence unknown instead of optimistic", () => {
    const policies = [writePolicy("github_create_issue")];
    const result = simulateMcpCapabilityPolicyChange(simulationInput(
      policies,
      policies,
      [
        subject("subject:stale", "github_create_issue", {
          sourceFreshness: "stale",
        }),
        subject("subject:missing", "github_create_issue", {
          sourceFreshness: "unavailable",
        }),
      ],
    ));

    expect(result.unknown).toHaveLength(2);
    expect(result.unknown.every((entry) => entry.currentDecision === "unknown")).toBe(true);
    expect(result.unknown.every((entry) => entry.candidateDecision === "unknown")).toBe(true);
  });

  test("is deterministic across policy and subject input order", () => {
    const current = [
      readPolicy("survey_workspace"),
      writePolicy("github_create_issue"),
    ];
    const candidate = [
      writePolicy("github_create_issue", { approval: "tool_managed" }),
      readPolicy("survey_workspace", "searchable"),
    ];
    const subjects = [
      subject("subject:z", "github_create_issue"),
      subject("subject:a", "survey_workspace"),
    ];
    const left = simulateMcpCapabilityPolicyChange(simulationInput(
      current,
      candidate,
      subjects,
    ));
    const right = simulateMcpCapabilityPolicyChange(simulationInput(
      [...current].reverse(),
      [...candidate].reverse(),
      [...subjects].reverse(),
    ));

    expect(right).toEqual(left);
    expect(right.simulationFingerprint).toBe(left.simulationFingerprint);
  });

  test("emits concise Markdown only from the freshly compiled simulation", () => {
    const artifacts = compileMcpCapabilityPolicySimulationArtifacts(simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace", "hidden")],
      [subject("subject:read", "survey_workspace")],
    ));

    expect(artifacts.markdown).toContain("# Capability policy simulation");
    expect(artifacts.markdown).toContain("## Exposure changed");
    expect(artifacts.markdown).toContain("grants no activation, execution, approval, or authority");
    expect(artifacts.simulation.authorizesActivation).toBe(false);
    expect(Object.isFrozen(artifacts)).toBe(true);
  });

  test("rejects realistic retained credentials", () => {
    expect(() => simulateMcpCapabilityPolicyChange(simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace")],
      [subject("subject:read", "survey_workspace", {
        sourceReferences: ["evidence:stn.svc_abcdefghijkl"],
      })],
    ))).toThrow("credential-shaped text");
  });

  test("rejects invalid public subject fields", () => {
    const invalidActive = simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace")],
      [subject("subject:read", "survey_workspace")],
    ) as unknown as Record<string, unknown>;
    const subjects = invalidActive.subjects as Array<Record<string, unknown>>;
    subjects[0]!.activeWork = "yes";
    expect(() => simulateMcpCapabilityPolicyChange(
      invalidActive as unknown as SimulateMcpCapabilityPolicyChangeInput,
    )).toThrow("active-work flag must be boolean");

    const invalidTool = simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace")],
      [subject("subject:read", "Survey Workspace")],
    );
    expect(() => simulateMcpCapabilityPolicyChange(invalidTool)).toThrow(
      "tool name is invalid",
    );
  });

  test("does not invoke caller ownKeys traps", () => {
    let ownKeysCalls = 0;
    const base = simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace", "hidden")],
      [subject("subject:read", "survey_workspace")],
    );
    const proxyPolicy = new Proxy(base.currentPolicies[0]!, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("private policy prose");
      },
    });
    const proxySubjects = new Proxy(base.subjects, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("private subject prose");
      },
    });
    const proxyInput = new Proxy({
      ...base,
      currentPolicies: [proxyPolicy],
      subjects: proxySubjects,
    }, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("private input prose");
      },
    });

    const result = simulateMcpCapabilityPolicyChange(proxyInput);
    expect(result.exposureChanged).toHaveLength(1);
    expect(ownKeysCalls).toBe(0);
  });

  test("checks the subject array ceiling before entry inspection", () => {
    let ownKeysCalls = 0;
    const oversized = new Array(257).fill(null);
    const proxied = new Proxy(oversized, {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("private oversized prose");
      },
    });
    const input = simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace")],
      [],
    );
    Object.defineProperty(input, "subjects", {
      value: proxied,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    expect(() => simulateMcpCapabilityPolicyChange(input)).toThrow(
      "input inspection exceeded its limit",
    );
    expect(ownKeysCalls).toBe(0);
  });

  test("allows decorations without treating them as policy authority", () => {
    const policy = readPolicy("survey_workspace") as McpCapabilityPolicyInput & {
      decoration?: string;
    };
    policy.decoration = "ignored";
    const result = simulateMcpCapabilityPolicyChange(simulationInput(
      [policy],
      [readPolicy("survey_workspace")],
      [subject("subject:read", "survey_workspace")],
    ));
    expect(result.unchangedSampleCount).toBe(1);
  });

  test("only the public simulator imports the private base", async () => {
    const allowed = new Set(["src/mcp-capability-policy-simulation.ts"]);
    const sourceFiles = Array.from(
      new Bun.Glob("src/**/*.ts").scanSync({ cwd: "." }),
    );
    for (const path of sourceFiles) {
      const source = await Bun.file(path).text();
      if (source.includes("mcp-capability-policy-simulation-base.js")) {
        expect(allowed.has(path), path).toBe(true);
      }
    }
  });

  test("binds simulation to exact policy revisions and accepted time", () => {
    const result = simulateMcpCapabilityPolicyChange(simulationInput(
      [readPolicy("survey_workspace")],
      [readPolicy("survey_workspace")],
      [subject("subject:read", "survey_workspace")],
    ));
    expect(result.currentPolicyRevision).toBe("policy:current");
    expect(result.candidatePolicyRevision).toBe("policy:candidate");
    expect(result.observedAt).toBe("2026-08-08T00:00:00.000Z");
    expect(result.currentPolicyFingerprint).toMatch(/^sha256:/);
    expect(result.candidatePolicyFingerprint).toMatch(/^sha256:/);
    expect(result.simulationInputsFingerprint).toMatch(/^sha256:/);
    expect(SHA).toHaveLength(40);
  });
});
