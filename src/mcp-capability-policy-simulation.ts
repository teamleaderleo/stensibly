import type {
  McpCapabilityPolicyInput,
  McpCapabilityProjectResolution,
} from "./mcp-capability-policy.js";
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
const maximumPolicies = 256;
const maximumSubjects = 256;
const maximumInputObjects = 10_000;

interface SnapshotBudget {
  objects: number;
}

export function simulateMcpCapabilityPolicyChange(
  input: SimulateMcpCapabilityPolicyChangeInput,
): McpCapabilityPolicySimulation {
  return simulatePolicyChangeBase(snapshotPublicInput(input));
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

function snapshotPublicInput(
  value: unknown,
): SimulateMcpCapabilityPolicyChangeInput {
  const budget: SnapshotBudget = { objects: 0 };
  requireCallerObject(value, budget);
  const record = value as object;
  return {
    currentPolicyRevision: dataValue(record, "currentPolicyRevision") as string,
    candidatePolicyRevision: dataValue(record, "candidatePolicyRevision") as string,
    observedAt: dataValue(record, "observedAt") as string,
    currentPolicies: snapshotPolicyArray(dataValue(record, "currentPolicies"), budget),
    candidatePolicies: snapshotPolicyArray(dataValue(record, "candidatePolicies"), budget),
    subjects: snapshotSubjectArray(dataValue(record, "subjects"), budget),
    limit: dataValue(record, "limit") as number,
  };
}

function snapshotPolicyArray(
  value: unknown,
  budget: SnapshotBudget,
): McpCapabilityPolicyInput[] {
  return snapshotArray(value, maximumPolicies, budget, (entry) =>
    snapshotPolicy(entry, budget));
}

function snapshotPolicy(
  value: unknown,
  budget: SnapshotBudget,
): McpCapabilityPolicyInput {
  requireCallerObject(value, budget);
  const record = value as object;
  return {
    toolName: dataValue(record, "toolName") as string,
    scope: dataValue(record, "scope") as McpCapabilityPolicyInput["scope"],
    riskClass: dataValue(record, "riskClass") as McpCapabilityPolicyInput["riskClass"],
    defaultExposure: dataValue(record, "defaultExposure") as McpCapabilityPolicyInput["defaultExposure"],
    projectResolution: snapshotProjectResolution(
      dataValue(record, "projectResolution"),
      budget,
    ),
    approvalPolicy: dataValue(record, "approvalPolicy") as McpCapabilityPolicyInput["approvalPolicy"],
    receiptPolicy: dataValue(record, "receiptPolicy") as McpCapabilityPolicyInput["receiptPolicy"],
    reconciliationPolicy: dataValue(record, "reconciliationPolicy") as McpCapabilityPolicyInput["reconciliationPolicy"],
  };
}

function snapshotProjectResolution(
  value: unknown,
  budget: SnapshotBudget,
): McpCapabilityProjectResolution {
  requireCallerObject(value, budget);
  const record = value as object;
  const kind = dataValue(record, "kind") as McpCapabilityProjectResolution["kind"];
  if (kind === "none") return { kind };
  return {
    kind,
    argument: dataValue(record, "argument") as string,
  } as McpCapabilityProjectResolution;
}

function snapshotSubjectArray(
  value: unknown,
  budget: SnapshotBudget,
): McpPolicySimulationSubjectInput[] {
  return snapshotArray(value, maximumSubjects, budget, (entry, index) => {
    requireCallerObject(entry, budget);
    const record = entry as object;
    const activeWork = dataValue(record, "activeWork");
    if (typeof activeWork !== "boolean") {
      throw new TypeError("Capability policy simulation active-work flag must be boolean");
    }
    const toolName = dataValue(record, "toolName");
    if (typeof toolName !== "string" || !toolNamePattern.test(toolName)) {
      throw new TypeError("Capability policy simulation tool name is invalid");
    }
    return {
      subjectId: dataValue(record, "subjectId") as string,
      toolName,
      activeWork,
      sourceFreshness: dataValue(record, "sourceFreshness") as McpPolicySimulationSourceFreshness,
      sourceReferences: snapshotArray(
        dataValue(record, "sourceReferences"),
        8,
        budget,
        (reference) => reference as string,
      ),
    };
  });
}

function snapshotArray<T>(
  value: unknown,
  maximum: number,
  budget: SnapshotBudget,
  snapshotEntry: (entry: unknown, index: number) => T,
): T[] {
  requireCallerArray(value, budget);
  const array = value as unknown[];
  const length = arrayLength(array);
  if (length > maximum) {
    throw new TypeError("Capability policy simulation input inspection exceeded its limit");
  }
  const result: T[] = [];
  for (let index = 0; index < length; index += 1) {
    result.push(snapshotEntry(dataValue(array, String(index)), index));
  }
  return result;
}

function requireCallerObject(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object") throw inspectionError();
  noteObject(budget);
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw inspectionError();
    }
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function requireCallerArray(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object") throw inspectionError();
  noteObject(budget);
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw inspectionError();
    }
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function noteObject(budget: SnapshotBudget): void {
  budget.objects += 1;
  if (budget.objects > maximumInputObjects) {
    throw new TypeError("Capability policy simulation input inspection exceeded its limit");
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
