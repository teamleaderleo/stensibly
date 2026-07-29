import { createHash } from "node:crypto";
import {
  buildEffectiveToolSurfaceSnapshot,
  effectiveToolSurfaceClasses,
  reconcileEffectiveToolSurface,
  toolSurfaceRecoveryActions,
  type EffectiveToolSurfaceClass,
  type EffectiveToolSurfaceReconciliation,
  type EffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshotInput,
  type EffectiveToolSurfaceState,
  type ToolSurfaceCapabilityRef,
  type ToolSurfaceCapabilityRequirementInput,
  type ToolSurfaceRecoveryAction,
} from "./effective-tool-surface.js";

export type EffectiveToolSurfaceConformanceMismatchCode =
  | "state_mismatch"
  | "dispatch_decision_mismatch"
  | "surface_changed_mismatch"
  | "missing_required_mismatch"
  | "catalogue_only_required_mismatch"
  | "degraded_classes_mismatch"
  | "recovery_action_mismatch";

export interface EffectiveToolSurfaceConformanceExpectationInput {
  state: EffectiveToolSurfaceState;
  dispatchDecision: "allow" | "block_or_reroute";
  surfaceChanged: boolean;
  missingRequiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  catalogueOnlyRequiredCapabilities?: readonly ToolSurfaceCapabilityRequirementInput[];
  degradedClasses: readonly EffectiveToolSurfaceClass[];
  recommendedRecoveryAction: ToolSurfaceRecoveryAction | null;
}

export interface EffectiveToolSurfaceConformanceStepInput {
  stepId: string;
  snapshot: EffectiveToolSurfaceSnapshotInput;
  expect: EffectiveToolSurfaceConformanceExpectationInput;
}

export interface EffectiveToolSurfaceConformanceScenarioInput {
  scenarioId: string;
  suiteVersion: string;
  steps: readonly EffectiveToolSurfaceConformanceStepInput[];
}

export interface EffectiveToolSurfaceConformanceMismatch {
  code: EffectiveToolSurfaceConformanceMismatchCode;
  expected: string;
  actual: string;
}

export interface EffectiveToolSurfaceConformanceStepResult {
  stepId: string;
  snapshotId: string;
  transition: EffectiveToolSurfaceSnapshot["transition"];
  snapshotFingerprint: string;
  surfaceFingerprint: string;
  state: EffectiveToolSurfaceState;
  dispatchDecision: EffectiveToolSurfaceReconciliation["dispatchDecision"];
  missingRequiredCapabilities: ToolSurfaceCapabilityRef[];
  catalogueOnlyRequiredCapabilities: ToolSurfaceCapabilityRef[];
  degradedClasses: EffectiveToolSurfaceClass[];
  recommendedRecoveryAction: ToolSurfaceRecoveryAction | null;
  surfaceChanged: boolean;
  passed: boolean;
  mismatches: EffectiveToolSurfaceConformanceMismatch[];
}

export interface EffectiveToolSurfaceConformanceReport {
  version: 1;
  scenarioId: string;
  suiteVersion: string;
  runnerAdapter: string;
  clientProduct: string;
  runId: string;
  firstSnapshotId: string;
  lastSnapshotId: string;
  stepCount: number;
  passed: boolean;
  stateCounts: Record<EffectiveToolSurfaceState, number>;
  blockedStepCount: number;
  recoveredStepCount: number;
  steps: EffectiveToolSurfaceConformanceStepResult[];
  evidenceFingerprint: string;
  canonicalRunPreserved: true;
  currentObservationsRequired: true;
  historicalCallsProveCurrentBinding: false;
  sideEffectsPerformed: false;
}

const limits = {
  identifier: 160,
  version: 160,
  steps: 64,
} as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;

/**
 * Runs one deterministic, side-effect-free tool-surface lifecycle scenario.
 *
 * Every step must preserve the canonical run and required-capability set. The
 * external surface, transport, client build, model profile, adapter version,
 * and observed catalogue may change between lifecycle transitions.
 */
export function runEffectiveToolSurfaceConformanceScenario(
  input: EffectiveToolSurfaceConformanceScenarioInput,
): EffectiveToolSurfaceConformanceReport {
  if (!isRecord(input)) throw new RangeError("Tool-surface conformance scenario must be an object");

  const scenarioId = boundedIdentifier(input.scenarioId, "Scenario ID");
  const suiteVersion = boundedText(input.suiteVersion, "Suite version", limits.version);
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > limits.steps) {
    throw new RangeError(`Scenario steps must contain from 1 to ${limits.steps} entries`);
  }

  const stepIds = new Set<string>();
  const snapshotIds = new Set<string>();
  const results: EffectiveToolSurfaceConformanceStepResult[] = [];
  let previous: EffectiveToolSurfaceSnapshot | undefined;
  let first: EffectiveToolSurfaceSnapshot | undefined;
  let previousObservedAt = Number.NEGATIVE_INFINITY;

  for (const [index, rawStep] of input.steps.entries()) {
    if (!isRecord(rawStep)) throw new RangeError(`Scenario step ${index + 1} must be an object`);
    const stepId = boundedIdentifier(rawStep.stepId, `Scenario step ${index + 1} ID`);
    if (stepIds.has(stepId)) throw new RangeError(`Scenario step ID ${stepId} is duplicated`);
    stepIds.add(stepId);

    const snapshot = buildEffectiveToolSurfaceSnapshot(rawStep.snapshot);
    if (snapshotIds.has(snapshot.snapshotId)) {
      throw new RangeError(`Snapshot ID ${snapshot.snapshotId} is duplicated`);
    }
    snapshotIds.add(snapshot.snapshotId);

    const observedAt = Date.parse(snapshot.observedAt);
    if (observedAt <= previousObservedAt) {
      throw new RangeError("Scenario observations must be in strictly increasing timestamp order");
    }
    previousObservedAt = observedAt;

    if (!first) first = snapshot;
    else validateLifecycleIdentity(first, previous, snapshot);

    const reconciliation = reconcileEffectiveToolSurface(snapshot, previous);
    const expectation = normalizeExpectation(rawStep.expect, index + 1);
    const mismatches = compareExpectation(expectation, reconciliation);

    results.push({
      stepId,
      snapshotId: snapshot.snapshotId,
      transition: snapshot.transition,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      surfaceFingerprint: snapshot.surfaceFingerprint,
      state: reconciliation.state,
      dispatchDecision: reconciliation.dispatchDecision,
      missingRequiredCapabilities: [...reconciliation.missingRequiredCapabilities],
      catalogueOnlyRequiredCapabilities: [...reconciliation.catalogueOnlyRequiredCapabilities],
      degradedClasses: [...reconciliation.degradedClasses],
      recommendedRecoveryAction: reconciliation.recommendedRecoveryAction,
      surfaceChanged: reconciliation.surfaceChanged,
      passed: mismatches.length === 0,
      mismatches,
    });
    previous = snapshot;
  }

  if (!first || !previous) throw new Error("Scenario did not produce snapshots");
  const stateCounts: Record<EffectiveToolSurfaceState, number> = {
    healthy: 0,
    changed: 0,
    degraded: 0,
    recovered: 0,
  };
  for (const step of results) stateCounts[step.state] += 1;

  const evidenceFingerprint = sha256(stableJson({
    version: 1,
    scenarioId,
    suiteVersion,
    runnerAdapter: first.runnerAdapter,
    clientProduct: first.clientProduct,
    runId: first.runId,
    steps: results.map((step) => ({
      stepId: step.stepId,
      snapshotId: step.snapshotId,
      transition: step.transition,
      snapshotFingerprint: step.snapshotFingerprint,
      state: step.state,
      dispatchDecision: step.dispatchDecision,
      missingRequiredCapabilities: step.missingRequiredCapabilities,
      catalogueOnlyRequiredCapabilities: step.catalogueOnlyRequiredCapabilities,
      degradedClasses: step.degradedClasses,
      recommendedRecoveryAction: step.recommendedRecoveryAction,
      surfaceChanged: step.surfaceChanged,
      mismatches: step.mismatches,
    })),
  }));

  return {
    version: 1,
    scenarioId,
    suiteVersion,
    runnerAdapter: first.runnerAdapter,
    clientProduct: first.clientProduct,
    runId: first.runId,
    firstSnapshotId: first.snapshotId,
    lastSnapshotId: previous.snapshotId,
    stepCount: results.length,
    passed: results.every((step) => step.passed),
    stateCounts,
    blockedStepCount: results.filter((step) => step.dispatchDecision === "block_or_reroute").length,
    recoveredStepCount: stateCounts.recovered,
    steps: results,
    evidenceFingerprint,
    canonicalRunPreserved: true,
    currentObservationsRequired: true,
    historicalCallsProveCurrentBinding: false,
    sideEffectsPerformed: false,
  };
}

function validateLifecycleIdentity(
  first: EffectiveToolSurfaceSnapshot,
  previous: EffectiveToolSurfaceSnapshot | undefined,
  current: EffectiveToolSurfaceSnapshot,
): void {
  if (current.runnerAdapter !== first.runnerAdapter) {
    throw new RangeError("Scenario runner adapter changed");
  }
  if (current.clientProduct !== first.clientProduct) {
    throw new RangeError("Scenario client product changed");
  }
  if (current.runId !== first.runId) {
    throw new RangeError("Scenario canonical run ID changed");
  }
  if (current.requiredFingerprint !== first.requiredFingerprint) {
    throw new RangeError("Scenario required-capability set changed");
  }
  if (previous && current.runGeneration < previous.runGeneration) {
    throw new RangeError("Scenario run generation moved backwards");
  }
}

function normalizeExpectation(
  input: EffectiveToolSurfaceConformanceExpectationInput,
  index: number,
): EffectiveToolSurfaceConformanceExpectationInput {
  if (!isRecord(input)) throw new RangeError(`Scenario step ${index} expectation must be an object`);
  if (!(["healthy", "changed", "degraded", "recovered"] as const).includes(input.state)) {
    throw new RangeError(`Scenario step ${index} expected state is invalid`);
  }
  if (!(["allow", "block_or_reroute"] as const).includes(input.dispatchDecision)) {
    throw new RangeError(`Scenario step ${index} expected dispatch decision is invalid`);
  }
  if (typeof input.surfaceChanged !== "boolean") {
    throw new RangeError(`Scenario step ${index} expected surfaceChanged must be boolean`);
  }
  const missingRequiredCapabilities = normalizeRefs(
    input.missingRequiredCapabilities,
    `Scenario step ${index} expected missing capability`,
  );
  const catalogueOnlyRequiredCapabilities = normalizeRefs(
    input.catalogueOnlyRequiredCapabilities ?? [],
    `Scenario step ${index} expected catalogue-only capability`,
  );
  const degradedClasses = normalizeClasses(
    input.degradedClasses,
    `Scenario step ${index} expected degraded class`,
  );
  const recommendedRecoveryAction = input.recommendedRecoveryAction;
  if (
    recommendedRecoveryAction !== null
    && !toolSurfaceRecoveryActions.includes(recommendedRecoveryAction)
  ) {
    throw new RangeError(`Scenario step ${index} expected recovery action is invalid`);
  }

  return {
    state: input.state,
    dispatchDecision: input.dispatchDecision,
    surfaceChanged: input.surfaceChanged,
    missingRequiredCapabilities,
    catalogueOnlyRequiredCapabilities,
    degradedClasses,
    recommendedRecoveryAction,
  };
}

function compareExpectation(
  expected: EffectiveToolSurfaceConformanceExpectationInput,
  actual: EffectiveToolSurfaceReconciliation,
): EffectiveToolSurfaceConformanceMismatch[] {
  const mismatches: EffectiveToolSurfaceConformanceMismatch[] = [];
  compareScalar(mismatches, "state_mismatch", expected.state, actual.state);
  compareScalar(
    mismatches,
    "dispatch_decision_mismatch",
    expected.dispatchDecision,
    actual.dispatchDecision,
  );
  compareScalar(
    mismatches,
    "surface_changed_mismatch",
    String(expected.surfaceChanged),
    String(actual.surfaceChanged),
  );
  compareScalar(
    mismatches,
    "missing_required_mismatch",
    refsText(expected.missingRequiredCapabilities),
    refsText(actual.missingRequiredCapabilities),
  );
  compareScalar(
    mismatches,
    "catalogue_only_required_mismatch",
    refsText(expected.catalogueOnlyRequiredCapabilities ?? []),
    refsText(actual.catalogueOnlyRequiredCapabilities),
  );
  compareScalar(
    mismatches,
    "degraded_classes_mismatch",
    classesText(expected.degradedClasses),
    classesText(actual.degradedClasses),
  );
  compareScalar(
    mismatches,
    "recovery_action_mismatch",
    expected.recommendedRecoveryAction ?? "none",
    actual.recommendedRecoveryAction ?? "none",
  );
  return mismatches;
}

function compareScalar(
  mismatches: EffectiveToolSurfaceConformanceMismatch[],
  code: EffectiveToolSurfaceConformanceMismatchCode,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) mismatches.push({ code, expected, actual });
}

function normalizeRefs(
  input: readonly ToolSurfaceCapabilityRequirementInput[],
  label: string,
): ToolSurfaceCapabilityRef[] {
  if (!Array.isArray(input)) throw new RangeError(`${label} list must be an array`);
  const seen = new Set<string>();
  const refs = input.map((entry, index) => {
    if (!isRecord(entry)) throw new RangeError(`${label} ${index + 1} must be an object`);
    if (!effectiveToolSurfaceClasses.includes(entry.class)) {
      throw new RangeError(`${label} ${index + 1} class is invalid`);
    }
    const id = boundedIdentifier(entry.id, `${label} ${index + 1} ID`);
    const key = `${entry.class}\u0000${id}`;
    if (seen.has(key)) throw new RangeError(`${label} ${entry.class}:${id} is duplicated`);
    seen.add(key);
    return { class: entry.class, id };
  });
  return refs.sort(compareRefs);
}

function normalizeClasses(
  input: readonly EffectiveToolSurfaceClass[],
  label: string,
): EffectiveToolSurfaceClass[] {
  if (!Array.isArray(input)) throw new RangeError(`${label} list must be an array`);
  const seen = new Set<EffectiveToolSurfaceClass>();
  const classes = input.map((entry) => {
    if (!effectiveToolSurfaceClasses.includes(entry)) throw new RangeError(`${label} is invalid`);
    if (seen.has(entry)) throw new RangeError(`${label} ${entry} is duplicated`);
    seen.add(entry);
    return entry;
  });
  return classes.sort((left, right) =>
    effectiveToolSurfaceClasses.indexOf(left) - effectiveToolSurfaceClasses.indexOf(right)
  );
}

function refsText(input: readonly ToolSurfaceCapabilityRef[]): string {
  return input.map((entry) => `${entry.class}:${entry.id}`).sort().join(",");
}

function classesText(input: readonly EffectiveToolSurfaceClass[]): string {
  return [...input]
    .sort((left, right) =>
      effectiveToolSurfaceClasses.indexOf(left) - effectiveToolSurfaceClasses.indexOf(right)
    )
    .join(",");
}

function compareRefs(left: ToolSurfaceCapabilityRef, right: ToolSurfaceCapabilityRef): number {
  const classDifference = effectiveToolSurfaceClasses.indexOf(left.class)
    - effectiveToolSurfaceClasses.indexOf(right.class);
  return classDifference || left.id.localeCompare(right.id);
}

function boundedIdentifier(value: unknown, label: string): string {
  const normalized = boundedText(value, label, limits.identifier);
  if (!identifierPattern.test(normalized)) throw new RangeError(`${label} contains unsupported characters`);
  return normalized;
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new RangeError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || unsafeTextPattern.test(normalized)) {
    throw new RangeError(`${label} is invalid`);
  }
  return normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
