import { sha256, stableJson } from "./canonical-json.js";
import {
  buildEffectiveToolSurfaceSnapshot,
  effectiveToolSurfaceClasses,
  reconcileEffectiveToolSurface,
  type EffectiveToolSurfaceClass,
  type EffectiveToolSurfaceReconciliation,
  type EffectiveToolSurfaceSnapshot,
  type EffectiveToolSurfaceSnapshotInput,
  type EffectiveToolSurfaceState,
  type ToolSurfaceRecoveryAction,
} from "./effective-tool-surface.js";

export const toolSurfaceClassObservationStates = Object.freeze([
  "unobserved",
  "absent",
  "present",
] as const);

export type ToolSurfaceClassObservationState =
  typeof toolSurfaceClassObservationStates[number];

export interface EffectiveToolSurfaceHostBindingSnapshotInput {
  toolSurface: EffectiveToolSurfaceSnapshotInput;
  classObservations?: Partial<
    Record<EffectiveToolSurfaceClass, ToolSurfaceClassObservationState>
  >;
}

export interface ToolSurfaceClassObservationSnapshot {
  class: EffectiveToolSurfaceClass;
  observation: ToolSurfaceClassObservationState;
  catalogueCount: number;
  catalogueDigest: string;
  executableCount: number;
  executableDigest: string;
  provenance: readonly string[];
}

export interface EffectiveToolSurfaceHostBindingSnapshot {
  version: 1;
  toolSurface: EffectiveToolSurfaceSnapshot;
  classObservations: Record<
    EffectiveToolSurfaceClass,
    ToolSurfaceClassObservationSnapshot
  >;
  hostBindingFingerprint: string;
  snapshotFingerprint: string;
  serverContractHealthInferred: false;
  historicalCallsProveCurrentBinding: false;
}

export interface ToolSurfaceClassObservationChange {
  class: EffectiveToolSurfaceClass;
  previous: ToolSurfaceClassObservationState;
  current: ToolSurfaceClassObservationState;
}

export type ToolSurfaceHostBindingRecoveryReason =
  | "host_binding_absent"
  | "class_unobserved"
  | "catalogue_present_empty"
  | "required_capability_missing"
  | null;

export interface EffectiveToolSurfaceHostBindingReconciliation {
  version: 1;
  state: EffectiveToolSurfaceState;
  base: EffectiveToolSurfaceReconciliation;
  currentSnapshotId: string;
  previousSnapshotId: string | null;
  hostBindingChanged: boolean;
  classObservationChanges: readonly ToolSurfaceClassObservationChange[];
  absentClasses: readonly EffectiveToolSurfaceClass[];
  unobservedClasses: readonly EffectiveToolSurfaceClass[];
  dispatchDecision: "allow" | "block_or_reroute";
  consequentialCallsAllowed: boolean;
  recommendedRecoveryAction: ToolSurfaceRecoveryAction | null;
  recommendedRecoveryReason: ToolSurfaceHostBindingRecoveryReason;
  serverContractHealthInferred: false;
  historicalCallsProveCurrentBinding: false;
}

const stateSet = new Set<ToolSurfaceClassObservationState>(
  toolSurfaceClassObservationStates,
);

export function buildEffectiveToolSurfaceHostBindingSnapshot(
  input: EffectiveToolSurfaceHostBindingSnapshotInput,
): EffectiveToolSurfaceHostBindingSnapshot {
  if (!isRecord(input)) {
    throw new RangeError("Effective tool-surface host-binding snapshot must be an object");
  }
  if (!isRecord(input.toolSurface)) {
    throw new RangeError("Effective tool-surface host-binding input is invalid");
  }
  const explicitObservations = input.classObservations ?? {};
  if (!isRecord(explicitObservations)) {
    throw new RangeError("Tool-class observations must be an object");
  }

  const toolSurface = buildEffectiveToolSurfaceSnapshot(input.toolSurface);
  const classObservations = {} as Record<
    EffectiveToolSurfaceClass,
    ToolSurfaceClassObservationSnapshot
  >;

  for (const className of effectiveToolSurfaceClasses) {
    const explicit = explicitObservation(explicitObservations, className);
    const supplied = hasOwnDataProperty(input.toolSurface.classes, className);
    const observation = explicit ?? (supplied ? "present" : "unobserved");
    const classSnapshot = toolSurface.classes[className];
    if (
      observation !== "present"
      && (classSnapshot.catalogueCount !== 0 || classSnapshot.executableCount !== 0)
    ) {
      throw new RangeError(
        `${className} ${observation} observation cannot retain capability evidence`,
      );
    }
    classObservations[className] = Object.freeze({
      class: className,
      observation,
      catalogueCount: classSnapshot.catalogueCount,
      catalogueDigest: classSnapshot.catalogueDigest,
      executableCount: classSnapshot.executableCount,
      executableDigest: classSnapshot.executableDigest,
      provenance: Object.freeze([...classSnapshot.provenance]),
    });
  }

  const hostBindingFingerprint = sha256(stableJson(
    effectiveToolSurfaceClasses.map((className) => {
      const entry = classObservations[className];
      return {
        class: className,
        observation: entry.observation,
        catalogueDigest: entry.catalogueDigest,
        executableDigest: entry.executableDigest,
      };
    }),
  ));
  const snapshotFingerprint = sha256(stableJson({
    toolSurfaceSnapshotFingerprint: toolSurface.snapshotFingerprint,
    hostBindingFingerprint,
  }));

  return deepFreeze({
    version: 1 as const,
    toolSurface,
    classObservations,
    hostBindingFingerprint,
    snapshotFingerprint,
    serverContractHealthInferred: false as const,
    historicalCallsProveCurrentBinding: false as const,
  });
}

export function reconcileEffectiveToolSurfaceHostBinding(
  current: EffectiveToolSurfaceHostBindingSnapshot,
  previous?: EffectiveToolSurfaceHostBindingSnapshot,
): EffectiveToolSurfaceHostBindingReconciliation {
  const base = reconcileEffectiveToolSurface(
    current.toolSurface,
    previous?.toolSurface,
  );
  const classObservationChanges: ToolSurfaceClassObservationChange[] = [];
  if (previous) {
    for (const className of effectiveToolSurfaceClasses) {
      const prior = previous.classObservations[className].observation;
      const next = current.classObservations[className].observation;
      if (prior !== next) {
        classObservationChanges.push(Object.freeze({
          class: className,
          previous: prior,
          current: next,
        }));
      }
    }
  }

  const absentClasses = effectiveToolSurfaceClasses.filter((className) =>
    current.classObservations[className].observation === "absent"
  );
  const unobservedClasses = effectiveToolSurfaceClasses.filter((className) =>
    current.classObservations[className].observation === "unobserved"
  );
  const hostBindingChanged = classObservationChanges.length > 0;

  let state = base.state;
  if (state === "healthy" && hostBindingChanged) state = "changed";

  const reason = recoveryReason(current, base);
  const recommendedRecoveryAction = selectRecoveryAction(
    current.toolSurface.recoveryActions,
    reason,
    base.recommendedRecoveryAction,
  );

  return deepFreeze({
    version: 1 as const,
    state,
    base,
    currentSnapshotId: current.toolSurface.snapshotId,
    previousSnapshotId: previous?.toolSurface.snapshotId ?? null,
    hostBindingChanged,
    classObservationChanges,
    absentClasses,
    unobservedClasses,
    dispatchDecision: base.dispatchDecision,
    consequentialCallsAllowed: base.consequentialCallsAllowed,
    recommendedRecoveryAction,
    recommendedRecoveryReason: reason,
    serverContractHealthInferred: false as const,
    historicalCallsProveCurrentBinding: false as const,
  });
}

function recoveryReason(
  current: EffectiveToolSurfaceHostBindingSnapshot,
  base: EffectiveToolSurfaceReconciliation,
): ToolSurfaceHostBindingRecoveryReason {
  for (const requirement of base.missingRequiredCapabilities) {
    const observed = current.classObservations[requirement.class];
    if (observed.observation === "absent") return "host_binding_absent";
  }
  for (const requirement of base.missingRequiredCapabilities) {
    const observed = current.classObservations[requirement.class];
    if (observed.observation === "unobserved") return "class_unobserved";
  }
  for (const requirement of base.missingRequiredCapabilities) {
    const observed = current.classObservations[requirement.class];
    if (
      observed.observation === "present"
      && observed.catalogueCount === 0
      && observed.executableCount === 0
    ) {
      return "catalogue_present_empty";
    }
  }
  return base.missingRequiredCapabilities.length > 0
    ? "required_capability_missing"
    : null;
}

function selectRecoveryAction(
  actions: readonly ToolSurfaceRecoveryAction[],
  reason: ToolSurfaceHostBindingRecoveryReason,
  fallback: ToolSurfaceRecoveryAction | null,
): ToolSurfaceRecoveryAction | null {
  if (reason === null) return null;
  const preferences: Record<
    Exclude<ToolSurfaceHostBindingRecoveryReason, null>,
    readonly ToolSurfaceRecoveryAction[]
  > = {
    host_binding_absent: [
      "reconnect",
      "restart",
      "move_continuation_to_fresh_surface",
    ],
    class_unobserved: [
      "refresh_catalogue",
      "reconnect",
      "restart",
    ],
    catalogue_present_empty: [
      "refresh_catalogue",
      "reconnect",
      "restart",
    ],
    required_capability_missing: [
      "resume_with_current_tools",
      "fork_with_current_tools",
      "reconnect",
      "restart",
    ],
  };
  for (const preferred of preferences[reason]) {
    if (actions.includes(preferred)) return preferred;
  }
  return fallback;
}

function explicitObservation(
  observations: Record<string, unknown>,
  className: EffectiveToolSurfaceClass,
): ToolSurfaceClassObservationState | null {
  const descriptor = dataDescriptor(observations, className);
  if (!descriptor) return null;
  const value = descriptor.value;
  if (typeof value !== "string" || !stateSet.has(value as ToolSurfaceClassObservationState)) {
    throw new RangeError(`${className} observation state is invalid`);
  }
  return value as ToolSurfaceClassObservationState;
}

function hasOwnDataProperty(value: unknown, key: string): boolean {
  if (!isRecord(value)) {
    throw new RangeError("Tool-surface classes must be an object");
  }
  return dataDescriptor(value, key) !== undefined;
}

function dataDescriptor(
  value: object,
  key: string,
): (PropertyDescriptor & { value: unknown }) | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new RangeError("Tool-class observation inspection failed");
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new RangeError("Tool-class observation fields must be enumerable data properties");
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
