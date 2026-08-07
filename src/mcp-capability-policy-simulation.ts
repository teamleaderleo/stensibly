import {
  mcpPolicySimulationDecisions,
  mcpPolicySimulationSourceFreshness,
  renderMcpCapabilityPolicySimulationMarkdown as renderSimulationMarkdownBase,
  simulateMcpCapabilityPolicyChange as simulatePolicyChangeBase,
  type McpCapabilityPolicySimulation,
  type McpPolicySimulationCategory,
  type McpPolicySimulationDecision,
  type McpPolicySimulationDifference,
  type McpPolicySimulationSourceFreshness,
  type McpPolicySimulationSubjectInput,
  type SimulateMcpCapabilityPolicyChangeInput,
} from "./mcp-capability-policy-simulation-base.js";

export {
  mcpPolicySimulationDecisions,
  mcpPolicySimulationSourceFreshness,
};
export type {
  McpCapabilityPolicySimulation,
  McpPolicySimulationCategory,
  McpPolicySimulationDecision,
  McpPolicySimulationDifference,
  McpPolicySimulationSourceFreshness,
  McpPolicySimulationSubjectInput,
  SimulateMcpCapabilityPolicyChangeInput,
};

export interface McpCapabilityPolicySimulationArtifacts {
  simulation: McpCapabilityPolicySimulation;
  markdown: string;
}

const toolNamePattern = /^[a-z][a-z0-9_]{0,127}$/;
const maximumSubjects = 256;

export function simulateMcpCapabilityPolicyChange(
  input: SimulateMcpCapabilityPolicyChangeInput,
): McpCapabilityPolicySimulation {
  assertPublicSubjectBoundary(input);
  return simulatePolicyChangeBase(input);
}

export function compileMcpCapabilityPolicySimulationArtifacts(
  input: SimulateMcpCapabilityPolicyChangeInput,
): Readonly<McpCapabilityPolicySimulationArtifacts> {
  const simulation = simulateMcpCapabilityPolicyChange(input);
  return Object.freeze({
    simulation,
    markdown: renderSimulationMarkdownBase(simulation),
  });
}

function assertPublicSubjectBoundary(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw inspectionError();
  }
  requirePrototype(value, Object.prototype);
  const subjects = dataValue(value, "subjects");
  if (!Array.isArray(subjects)) throw inspectionError();
  requirePrototype(subjects, Array.prototype);
  const length = arrayLength(subjects);
  if (length > maximumSubjects) {
    throw new TypeError("Capability policy simulation input inspection exceeded its limit");
  }
  for (let index = 0; index < length; index += 1) {
    const subject = dataValue(subjects, String(index));
    if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
      throw inspectionError();
    }
    requirePrototype(subject, Object.prototype);
    const activeWork = dataValue(subject, "activeWork");
    if (typeof activeWork !== "boolean") {
      throw new TypeError("Capability policy simulation active-work flag must be boolean");
    }
    const toolName = dataValue(subject, "toolName");
    if (typeof toolName !== "string" || !toolNamePattern.test(toolName)) {
      throw new TypeError("Capability policy simulation tool name is invalid");
    }
  }
}

function requirePrototype(value: object, expected: object): void {
  try {
    if (Object.getPrototypeOf(value) !== expected) throw inspectionError();
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function arrayLength(value: unknown[]): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0
    ) throw inspectionError();
    return descriptor.value as number;
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function dataValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw inspectionError();
    }
    return descriptor.value;
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function inspectionError(): TypeError {
  return new TypeError("Capability policy simulation input inspection failed");
}

function isInspectionError(error: unknown): error is TypeError {
  return error instanceof TypeError
    && error.message === "Capability policy simulation input inspection failed";
}
