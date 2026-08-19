import { sha256, stableJson } from "./canonical-json.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  compileMcpCapabilityPolicyRegistry,
  type McpCapabilityPolicy,
  type McpCapabilityPolicyInput,
  type McpCapabilityProjectResolution,
} from "./mcp-capability-policy.js";
import {
  assertCanonicalJsonByteBudget,
  boundedIdentity,
  boundedInteger,
  canonicalTimestamp,
  compareCodeUnits,
  denseDataArray,
  enumValue,
  requireUnique,
} from "./work-stack-projection-validation.js";

export const mcpPolicySimulationSourceFreshness = Object.freeze([
  "current",
  "stale",
  "unavailable",
] as const);
export type McpPolicySimulationSourceFreshness =
  typeof mcpPolicySimulationSourceFreshness[number];

export const mcpPolicySimulationDecisions = Object.freeze([
  "allowed_by_policy",
  "approval_required",
  "denied_by_policy",
  "unknown",
] as const);
export type McpPolicySimulationDecision =
  typeof mcpPolicySimulationDecisions[number];

export interface McpPolicySimulationSubjectInput {
  subjectId: string;
  toolName: string;
  activeWork: boolean;
  sourceFreshness: McpPolicySimulationSourceFreshness;
  sourceReferences: string[];
}

export interface SimulateMcpCapabilityPolicyChangeInput {
  currentPolicyRevision: string;
  candidatePolicyRevision: string;
  observedAt: string;
  currentPolicies: McpCapabilityPolicyInput[];
  candidatePolicies: McpCapabilityPolicyInput[];
  subjects: McpPolicySimulationSubjectInput[];
  limit: number;
}

export interface McpPolicySimulationDifference {
  subjectId: string;
  toolName: string;
  activeWork: boolean;
  sourceFreshness: McpPolicySimulationSourceFreshness;
  currentDecision: McpPolicySimulationDecision;
  candidateDecision: McpPolicySimulationDecision;
  currentRiskClass: string | null;
  candidateRiskClass: string | null;
  currentExposure: string | null;
  candidateExposure: string | null;
  currentApprovalPolicy: string | null;
  candidateApprovalPolicy: string | null;
  currentProjectResolution: Readonly<McpCapabilityProjectResolution> | null;
  candidateProjectResolution: Readonly<McpCapabilityProjectResolution> | null;
  decisiveReason: string;
  sourceReferences: readonly string[];
}

export type McpPolicySimulationCategory =
  | "newlyAllowed"
  | "newlyDenied"
  | "approvalChanged"
  | "exposureChanged"
  | "riskChanged"
  | "projectResolutionChanged"
  | "activeWorkAffected"
  | "unknown";

export interface McpCapabilityPolicySimulation {
  currentPolicyRevision: string;
  candidatePolicyRevision: string;
  currentPolicyFingerprint: string;
  candidatePolicyFingerprint: string;
  simulationInputsFingerprint: string;
  observedAt: string;
  newlyAllowed: readonly McpPolicySimulationDifference[];
  newlyDenied: readonly McpPolicySimulationDifference[];
  approvalChanged: readonly McpPolicySimulationDifference[];
  exposureChanged: readonly McpPolicySimulationDifference[];
  riskChanged: readonly McpPolicySimulationDifference[];
  projectResolutionChanged: readonly McpPolicySimulationDifference[];
  activeWorkAffected: readonly McpPolicySimulationDifference[];
  unknown: readonly McpPolicySimulationDifference[];
  unchangedSampleCount: number;
  omittedCounts: Readonly<Record<McpPolicySimulationCategory | "sourceReferences", number>>;
  sourceReferences: readonly string[];
  coverage: "representative";
  authorizesActivation: false;
  authorizesExecution: false;
  authorizesAuthority: false;
  simulationFingerprint: string;
}

const sourceFreshnessSet = new Set<McpPolicySimulationSourceFreshness>(
  mcpPolicySimulationSourceFreshness,
);
const categories = Object.freeze([
  "newlyAllowed",
  "newlyDenied",
  "approvalChanged",
  "exposureChanged",
  "riskChanged",
  "projectResolutionChanged",
  "activeWorkAffected",
  "unknown",
] as const satisfies readonly McpPolicySimulationCategory[]);
const maximumPolicies = 256;
const maximumSubjects = 256;
const maximumReferences = 256;
const maximumInputObjects = 10_000;
const maximumOutputBytes = 512 * 1024;
const maximumMarkdownBytes = 256 * 1024;

interface SnapshotBudget {
  objects: number;
}

export function simulateMcpCapabilityPolicyChange(
  input: SimulateMcpCapabilityPolicyChangeInput,
): McpCapabilityPolicySimulation {
  const detached = snapshotSimulationInput(input);
  const currentRevision = publicIdentity(
    detached.currentPolicyRevision,
    "Current capability policy revision",
  );
  const candidateRevision = publicIdentity(
    detached.candidatePolicyRevision,
    "Candidate capability policy revision",
  );
  const observedAt = canonicalTimestamp(
    detached.observedAt,
    "Capability policy simulation observed time",
  );
  const limit = boundedInteger(
    detached.limit,
    1,
    100,
    "Capability policy simulation limit",
  );
  const currentRegistry = compileMcpCapabilityPolicyRegistry(detached.currentPolicies);
  const candidateRegistry = compileMcpCapabilityPolicyRegistry(detached.candidatePolicies);
  const currentByTool = new Map(
    currentRegistry.policies.map((policy) => [policy.toolName, policy]),
  );
  const candidateByTool = new Map(
    candidateRegistry.policies.map((policy) => [policy.toolName, policy]),
  );
  const subjects = admitSubjects(detached.subjects);

  const buckets = Object.fromEntries(
    categories.map((category) => [category, [] as McpPolicySimulationDifference[]]),
  ) as Record<McpPolicySimulationCategory, McpPolicySimulationDifference[]>;
  let unchangedSampleCount = 0;

  for (const subject of subjects) {
    const current = currentByTool.get(subject.toolName) ?? null;
    const candidate = candidateByTool.get(subject.toolName) ?? null;
    const currentDecision = evaluatePolicy(current, subject.sourceFreshness);
    const candidateDecision = evaluatePolicy(candidate, subject.sourceFreshness);
    const difference = buildDifference(
      subject,
      current,
      candidate,
      currentDecision,
      candidateDecision,
    );
    const changed = classifyDifference(difference, buckets);
    if (!changed) unchangedSampleCount += 1;
  }

  const omittedCounts = Object.fromEntries(
    categories.map((category) => [
      category,
      Math.max(0, buckets[category].length - limit),
    ]),
  ) as Record<McpPolicySimulationCategory | "sourceReferences", number>;
  const visible = Object.fromEntries(
    categories.map((category) => [
      category,
      buckets[category].sort(compareDifferences).slice(0, limit),
    ]),
  ) as Record<McpPolicySimulationCategory, McpPolicySimulationDifference[]>;

  const references = new Set<string>();
  for (const category of categories) {
    for (const difference of visible[category]) {
      for (const reference of difference.sourceReferences) references.add(reference);
    }
  }
  const orderedReferences = [...references].sort(compareCodeUnits);
  omittedCounts.sourceReferences = Math.max(
    0,
    orderedReferences.length - maximumReferences,
  );

  const inputFingerprintValue = {
    currentPolicyRevision: currentRevision,
    candidatePolicyRevision: candidateRevision,
    currentPolicyFingerprint: currentRegistry.fingerprint,
    candidatePolicyFingerprint: candidateRegistry.fingerprint,
    observedAt,
    subjects,
  };
  const unsigned = {
    currentPolicyRevision: currentRevision,
    candidatePolicyRevision: candidateRevision,
    currentPolicyFingerprint: currentRegistry.fingerprint,
    candidatePolicyFingerprint: candidateRegistry.fingerprint,
    simulationInputsFingerprint: sha256(stableJson(inputFingerprintValue)),
    observedAt,
    newlyAllowed: visible.newlyAllowed,
    newlyDenied: visible.newlyDenied,
    approvalChanged: visible.approvalChanged,
    exposureChanged: visible.exposureChanged,
    riskChanged: visible.riskChanged,
    projectResolutionChanged: visible.projectResolutionChanged,
    activeWorkAffected: visible.activeWorkAffected,
    unknown: visible.unknown,
    unchangedSampleCount,
    omittedCounts,
    sourceReferences: orderedReferences.slice(0, maximumReferences),
    coverage: "representative" as const,
    authorizesActivation: false as const,
    authorizesExecution: false as const,
    authorizesAuthority: false as const,
  };
  assertCanonicalJsonByteBudget(
    unsigned,
    maximumOutputBytes,
    "Capability policy simulation",
  );
  assertRetainedCredentialFree(unsigned);
  return freezeDeep({
    ...unsigned,
    simulationFingerprint: sha256(stableJson(unsigned)),
  }) as McpCapabilityPolicySimulation;
}

export function renderMcpCapabilityPolicySimulationMarkdown(
  simulation: McpCapabilityPolicySimulation,
): string {
  const lines = [
    "# Capability policy simulation",
    "",
    `Current: \`${escapeMarkdown(simulation.currentPolicyRevision)}\``,
    `Candidate: \`${escapeMarkdown(simulation.candidatePolicyRevision)}\``,
    `Coverage: ${simulation.coverage}`,
    "",
  ];
  const headings: ReadonlyArray<readonly [McpPolicySimulationCategory, string]> = [
    ["newlyAllowed", "Newly allowed by policy"],
    ["newlyDenied", "Newly denied by policy"],
    ["approvalChanged", "Approval changed"],
    ["exposureChanged", "Exposure changed"],
    ["riskChanged", "Risk changed"],
    ["projectResolutionChanged", "Project resolution changed"],
    ["activeWorkAffected", "Active work affected"],
    ["unknown", "Unknown due to stale or unavailable evidence"],
  ];
  let visible = 0;
  for (const [category, heading] of headings) {
    const entries = simulation[category];
    if (entries.length === 0 && simulation.omittedCounts[category] === 0) continue;
    lines.push(`## ${heading}`, "");
    for (const entry of entries) {
      visible += 1;
      lines.push(
        `- ${escapeMarkdown(entry.subjectId)} / \`${escapeMarkdown(entry.toolName)}\`: ${entry.currentDecision} -> ${entry.candidateDecision}; ${escapeMarkdown(entry.decisiveReason)}`,
      );
    }
    if (simulation.omittedCounts[category] > 0) {
      lines.push(`- ${simulation.omittedCounts[category]} additional difference(s) omitted.`);
    }
    lines.push("");
  }
  if (visible === 0) {
    lines.push("No material differences were found in the representative sample.", "");
  }
  lines.push(
    `Unchanged representative subjects: ${simulation.unchangedSampleCount}.`,
    "",
    "This simulation grants no activation, execution, approval, or authority.",
  );
  const markdown = lines.join("\n");
  if (new TextEncoder().encode(markdown).byteLength > maximumMarkdownBytes) {
    throw new RangeError("Capability policy simulation Markdown exceeds its output limit");
  }
  return markdown;
}

function evaluatePolicy(
  policy: McpCapabilityPolicy | null,
  freshness: McpPolicySimulationSourceFreshness,
): McpPolicySimulationDecision {
  if (freshness !== "current") return "unknown";
  if (!policy) return "denied_by_policy";
  if (policy.approvalPolicy === "tool_managed") return "approval_required";
  return "allowed_by_policy";
}

function buildDifference(
  subject: Readonly<McpPolicySimulationSubjectInput>,
  current: McpCapabilityPolicy | null,
  candidate: McpCapabilityPolicy | null,
  currentDecision: McpPolicySimulationDecision,
  candidateDecision: McpPolicySimulationDecision,
): McpPolicySimulationDifference {
  return {
    subjectId: subject.subjectId,
    toolName: subject.toolName,
    activeWork: subject.activeWork,
    sourceFreshness: subject.sourceFreshness,
    currentDecision,
    candidateDecision,
    currentRiskClass: current?.riskClass ?? null,
    candidateRiskClass: candidate?.riskClass ?? null,
    currentExposure: current?.defaultExposure ?? null,
    candidateExposure: candidate?.defaultExposure ?? null,
    currentApprovalPolicy: current?.approvalPolicy ?? null,
    candidateApprovalPolicy: candidate?.approvalPolicy ?? null,
    currentProjectResolution: current ? { ...current.projectResolution } : null,
    candidateProjectResolution: candidate ? { ...candidate.projectResolution } : null,
    decisiveReason: decisiveReason(subject.sourceFreshness, current, candidate),
    sourceReferences: [...subject.sourceReferences],
  };
}

function decisiveReason(
  freshness: McpPolicySimulationSourceFreshness,
  current: McpCapabilityPolicy | null,
  candidate: McpCapabilityPolicy | null,
): string {
  if (freshness === "stale") return "Source evidence is stale, so the policy effect is unknown.";
  if (freshness === "unavailable") return "Source evidence is unavailable, so the policy effect is unknown.";
  if (!current && candidate) return "The candidate introduces a capability policy for this tool.";
  if (current && !candidate) return "The candidate removes the capability policy for this tool.";
  if (!current && !candidate) return "Neither policy revision declares this tool.";
  if (current!.approvalPolicy !== candidate!.approvalPolicy) {
    return "The candidate changes the tool-managed approval requirement.";
  }
  if (current!.riskClass !== candidate!.riskClass) {
    return "The candidate changes the policy consequence class.";
  }
  if (current!.defaultExposure !== candidate!.defaultExposure) {
    return "The candidate changes default tool exposure.";
  }
  if (stableJson(current!.projectResolution) !== stableJson(candidate!.projectResolution)) {
    return "The candidate changes project-resolution semantics.";
  }
  return "The representative subject keeps the same capability-policy semantics.";
}

function classifyDifference(
  difference: McpPolicySimulationDifference,
  buckets: Record<McpPolicySimulationCategory, McpPolicySimulationDifference[]>,
): boolean {
  let changed = false;
  if (difference.currentDecision === "unknown" || difference.candidateDecision === "unknown") {
    buckets.unknown.push(difference);
    changed = true;
  } else {
    if (
      difference.currentDecision === "denied_by_policy"
      && difference.candidateDecision === "allowed_by_policy"
    ) {
      buckets.newlyAllowed.push(difference);
      changed = true;
    }
    if (
      difference.currentDecision !== "denied_by_policy"
      && difference.candidateDecision === "denied_by_policy"
    ) {
      buckets.newlyDenied.push(difference);
      changed = true;
    }
    if (
      difference.currentDecision === "approval_required"
      || difference.candidateDecision === "approval_required"
    ) {
      if (difference.currentDecision !== difference.candidateDecision) {
        buckets.approvalChanged.push(difference);
        changed = true;
      }
    }
  }
  if (difference.currentExposure !== difference.candidateExposure) {
    buckets.exposureChanged.push(difference);
    changed = true;
  }
  if (difference.currentRiskClass !== difference.candidateRiskClass) {
    buckets.riskChanged.push(difference);
    changed = true;
  }
  if (
    stableJson(difference.currentProjectResolution)
    !== stableJson(difference.candidateProjectResolution)
  ) {
    buckets.projectResolutionChanged.push(difference);
    changed = true;
  }
  if (difference.activeWork && changed) {
    buckets.activeWorkAffected.push(difference);
  }
  return changed;
}

function admitSubjects(
  subjects: readonly McpPolicySimulationSubjectInput[],
): readonly Readonly<McpPolicySimulationSubjectInput>[] {
  const admitted = subjects.map((subject, index) => {
    const sourceReferences = subject.sourceReferences.map((reference, refIndex) =>
      publicIdentity(reference, `Simulation subject ${index + 1} source reference ${refIndex + 1}`));
    sourceReferences.sort(compareCodeUnits);
    requireUnique(sourceReferences, `Simulation subject ${index + 1} source references`);
    return {
      subjectId: publicIdentity(subject.subjectId, `Simulation subject ${index + 1} ID`),
      toolName: publicIdentity(subject.toolName, `Simulation subject ${index + 1} tool`),
      activeWork: subject.activeWork,
      sourceFreshness: enumValue(
        subject.sourceFreshness,
        sourceFreshnessSet,
        `Simulation subject ${index + 1} freshness`,
      ),
      sourceReferences,
    };
  });
  admitted.sort((left, right) => compareCodeUnits(left.subjectId, right.subjectId));
  requireUnique(admitted.map((subject) => subject.subjectId), "Simulation subject IDs");
  return freezeDeep(admitted);
}

function snapshotSimulationInput(
  value: unknown,
): SimulateMcpCapabilityPolicyChangeInput {
  const budget: SnapshotBudget = { objects: 0 };
  requireCallerObject(value, budget);
  const record = value as object;
  return {
    currentPolicyRevision: descriptorValue(record, "currentPolicyRevision") as string,
    candidatePolicyRevision: descriptorValue(record, "candidatePolicyRevision") as string,
    observedAt: descriptorValue(record, "observedAt") as string,
    currentPolicies: snapshotPolicyArray(descriptorValue(record, "currentPolicies"), budget),
    candidatePolicies: snapshotPolicyArray(descriptorValue(record, "candidatePolicies"), budget),
    subjects: snapshotSubjectArray(descriptorValue(record, "subjects"), budget),
    limit: descriptorValue(record, "limit") as number,
  };
}

function snapshotPolicyArray(
  value: unknown,
  budget: SnapshotBudget,
): McpCapabilityPolicyInput[] {
  return snapshotArray(value, maximumPolicies, budget, (entry) => snapshotPolicy(entry, budget));
}

function snapshotPolicy(
  value: unknown,
  budget: SnapshotBudget,
): McpCapabilityPolicyInput {
  requireCallerObject(value, budget);
  const record = value as object;
  return {
    toolName: descriptorValue(record, "toolName") as string,
    scope: descriptorValue(record, "scope") as McpCapabilityPolicyInput["scope"],
    riskClass: descriptorValue(record, "riskClass") as McpCapabilityPolicyInput["riskClass"],
    defaultExposure: descriptorValue(record, "defaultExposure") as McpCapabilityPolicyInput["defaultExposure"],
    projectResolution: snapshotProjectResolution(
      descriptorValue(record, "projectResolution"),
      budget,
    ),
    approvalPolicy: descriptorValue(record, "approvalPolicy") as McpCapabilityPolicyInput["approvalPolicy"],
    receiptPolicy: descriptorValue(record, "receiptPolicy") as McpCapabilityPolicyInput["receiptPolicy"],
    reconciliationPolicy: descriptorValue(record, "reconciliationPolicy") as McpCapabilityPolicyInput["reconciliationPolicy"],
  };
}

function snapshotProjectResolution(
  value: unknown,
  budget: SnapshotBudget,
): McpCapabilityProjectResolution {
  requireCallerObject(value, budget);
  const record = value as object;
  const kind = descriptorValue(record, "kind") as McpCapabilityProjectResolution["kind"];
  if (kind === "none") return { kind };
  return {
    kind,
    argument: descriptorValue(record, "argument") as string,
  } as McpCapabilityProjectResolution;
}

function snapshotSubjectArray(
  value: unknown,
  budget: SnapshotBudget,
): McpPolicySimulationSubjectInput[] {
  return snapshotArray(value, maximumSubjects, budget, (entry) => {
    requireCallerObject(entry, budget);
    const record = entry as object;
    const sourceReferences = snapshotArray(
      descriptorValue(record, "sourceReferences"),
      8,
      budget,
      (reference) => reference as string,
    );
    return {
      subjectId: descriptorValue(record, "subjectId") as string,
      toolName: descriptorValue(record, "toolName") as string,
      activeWork: descriptorValue(record, "activeWork") as boolean,
      sourceFreshness: descriptorValue(record, "sourceFreshness") as McpPolicySimulationSourceFreshness,
      sourceReferences,
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
    result.push(snapshotEntry(descriptorValue(array, String(index)), index));
  }
  return result;
}

function requireCallerObject(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw inspectionError();
  noteObject(budget);
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw inspectionError();
  } catch (error) {
    if (isInspectionError(error)) throw error;
    throw inspectionError();
  }
}

function requireCallerArray(value: unknown, budget: SnapshotBudget): void {
  if (!Array.isArray(value)) throw inspectionError();
  noteObject(budget);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw inspectionError();
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

function descriptorValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw inspectionError();
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

function publicIdentity(value: unknown, label: string): string {
  const admitted = boundedIdentity(value, label);
  if (containsRealisticRetainedCredential(admitted)) {
    throw new TypeError(`${label} contains credential-shaped text`);
  }
  return admitted;
}

function compareDifferences(
  left: McpPolicySimulationDifference,
  right: McpPolicySimulationDifference,
): number {
  return compareCodeUnits(left.subjectId, right.subjectId)
    || compareCodeUnits(left.toolName, right.toolName);
}

function assertRetainedCredentialFree(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsRealisticRetainedCredential(current)) {
        throw new TypeError("Capability policy simulation contains credential-shaped text");
      }
      continue;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
    } else {
      for (const entry of Object.values(current as Record<string, unknown>)) pending.push(entry);
    }
  }
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/\r\n?|\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]<>#])/g, "\\$1")
    .replace(/@/g, "\\@");
}

function freezeDeep<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
