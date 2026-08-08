import type {
  EffectiveToolSurfaceClass,
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceCapabilityInput,
  ToolSurfaceCapabilityRequirementInput,
  ToolSurfaceClassInput,
  ToolSurfaceRecoveryAction,
} from "./effective-tool-surface.js";
import {
  buildEffectiveToolSurfaceHostBindingSnapshot as buildHostBindingBase,
  reconcileEffectiveToolSurfaceHostBinding as reconcileHostBindingBase,
  toolSurfaceClassObservationStates,
  type EffectiveToolSurfaceHostBindingReconciliation,
  type EffectiveToolSurfaceHostBindingSnapshot,
  type EffectiveToolSurfaceHostBindingSnapshotInput,
  type ToolSurfaceClassObservationChange,
  type ToolSurfaceClassObservationSnapshot,
  type ToolSurfaceClassObservationState,
  type ToolSurfaceHostBindingRecoveryReason,
} from "./effective-tool-surface-host-binding-base.js";

export { toolSurfaceClassObservationStates };
export type {
  EffectiveToolSurfaceHostBindingReconciliation,
  EffectiveToolSurfaceHostBindingSnapshot,
  EffectiveToolSurfaceHostBindingSnapshotInput,
  ToolSurfaceClassObservationChange,
  ToolSurfaceClassObservationSnapshot,
  ToolSurfaceClassObservationState,
  ToolSurfaceHostBindingRecoveryReason,
};

const maximumCapabilitiesPerClass = 1_000;
const maximumRequiredCapabilities = 1_000;
const maximumRecoveryActions = 6;
const maximumProvenanceEntries = 16;
// The inherited v1 legal maximum visits 11,026 caller objects at the
// closed per-list ceilings. Keep one bounded defense-in-depth ceiling above it.
const maximumInputObjects = 12_000;
const admittedHostBindingSnapshots = new WeakSet<object>();

interface InputBudget {
  objects: number;
}

export function buildEffectiveToolSurfaceHostBindingSnapshot(
  input: EffectiveToolSurfaceHostBindingSnapshotInput,
): EffectiveToolSurfaceHostBindingSnapshot {
  const snapshot = buildHostBindingBase(snapshotHostBindingInput(input));
  admittedHostBindingSnapshots.add(snapshot);
  return snapshot;
}

export function reconcileEffectiveToolSurfaceHostBinding(
  current: EffectiveToolSurfaceHostBindingSnapshot,
  previous?: EffectiveToolSurfaceHostBindingSnapshot,
): EffectiveToolSurfaceHostBindingReconciliation {
  requireAdmittedSnapshot(current);
  if (previous !== undefined) requireAdmittedSnapshot(previous);
  return reconcileHostBindingBase(current, previous);
}

function requireAdmittedSnapshot(value: unknown): asserts value is EffectiveToolSurfaceHostBindingSnapshot {
  if (
    value === null
    || typeof value !== "object"
    || !admittedHostBindingSnapshots.has(value)
  ) {
    throw snapshotInspectionError();
  }
}

function snapshotInspectionError(): RangeError {
  return new RangeError(
    "Effective tool-surface host-binding snapshot inspection failed",
  );
}

function snapshotHostBindingInput(
  value: unknown,
): EffectiveToolSurfaceHostBindingSnapshotInput {
  const budget: InputBudget = { objects: 0 };
  requireCallerRecord(value, budget);
  const record = value as object;
  const toolSurface = snapshotToolSurface(
    requiredDataValue(record, "toolSurface"),
    budget,
  );
  const observationDescriptor = optionalDataDescriptor(record, "classObservations");
  return observationDescriptor
    ? {
        toolSurface,
        classObservations: snapshotClassObservations(
          observationDescriptor.value,
          budget,
        ),
      }
    : { toolSurface };
}

function snapshotToolSurface(
  value: unknown,
  budget: InputBudget,
): EffectiveToolSurfaceSnapshotInput {
  requireCallerRecord(value, budget);
  const record = value as object;
  const classes = snapshotClasses(requiredDataValue(record, "classes"), budget);
  const requiredCapabilities = optionalDataDescriptor(record, "requiredCapabilities");
  const recoveryActions = optionalDataDescriptor(record, "recoveryActions");

  return {
    snapshotId: requiredDataValue(record, "snapshotId") as string,
    runnerAdapter: requiredDataValue(record, "runnerAdapter") as string,
    runnerVersion: requiredDataValue(record, "runnerVersion") as string,
    clientProduct: requiredDataValue(record, "clientProduct") as string,
    clientBuild: optionalDataValue(record, "clientBuild") as string | undefined,
    modelProfile: optionalDataValue(record, "modelProfile") as string | undefined,
    externalSurfaceRef: optionalDataValue(record, "externalSurfaceRef") as string | undefined,
    runId: requiredDataValue(record, "runId") as string,
    runGeneration: requiredDataValue(record, "runGeneration") as number,
    transport: requiredDataValue(record, "transport") as string,
    transition: requiredDataValue(record, "transition") as EffectiveToolSurfaceSnapshotInput["transition"],
    classes,
    requiredCapabilities: requiredCapabilities
      ? snapshotRequirements(requiredCapabilities.value, budget)
      : undefined,
    recoveryActions: recoveryActions
      ? snapshotScalarArray<ToolSurfaceRecoveryAction>(
          recoveryActions.value,
          maximumRecoveryActions,
          budget,
        )
      : undefined,
    observedAt: requiredDataValue(record, "observedAt") as string,
    traceId: optionalDataValue(record, "traceId") as string | undefined,
  };
}

function snapshotClasses(
  value: unknown,
  budget: InputBudget,
): Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>> {
  requireCallerRecord(value, budget);
  const record = value as object;
  const result: Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>> = {};
  for (const className of [
    "native_core",
    "host_dynamic",
    "app_connector",
    "configured_mcp",
    "discovery",
  ] as const satisfies readonly EffectiveToolSurfaceClass[]) {
    const descriptor = optionalDataDescriptor(record, className);
    if (descriptor) result[className] = snapshotClassInput(descriptor.value, budget);
  }
  return result;
}

function snapshotClassInput(
  value: unknown,
  budget: InputBudget,
): ToolSurfaceClassInput {
  requireCallerRecord(value, budget);
  const record = value as object;
  const catalogue = optionalDataDescriptor(record, "catalogue");
  const provenance = optionalDataDescriptor(record, "provenance");
  return {
    ...(catalogue
      ? {
          catalogue: snapshotCapabilityArray(
            catalogue.value,
            budget,
          ),
        }
      : {}),
    executable: snapshotCapabilityArray(
      requiredDataValue(record, "executable"),
      budget,
    ),
    ...(provenance
      ? {
          provenance: snapshotScalarArray<string>(
            provenance.value,
            maximumProvenanceEntries,
            budget,
          ),
        }
      : {}),
  };
}

function snapshotCapabilityArray(
  value: unknown,
  budget: InputBudget,
): ToolSurfaceCapabilityInput[] {
  return snapshotArray(
    value,
    maximumCapabilitiesPerClass,
    budget,
    (entry) => snapshotCapability(entry, budget),
  );
}

function snapshotCapability(
  value: unknown,
  budget: InputBudget,
): ToolSurfaceCapabilityInput {
  requireCallerRecord(value, budget);
  const record = value as object;
  const name = optionalDataDescriptor(record, "name");
  return {
    id: requiredDataValue(record, "id") as string,
    ...(name ? { name: name.value as string } : {}),
  };
}

function snapshotRequirements(
  value: unknown,
  budget: InputBudget,
): ToolSurfaceCapabilityRequirementInput[] {
  return snapshotArray(
    value,
    maximumRequiredCapabilities,
    budget,
    (entry) => {
      requireCallerRecord(entry, budget);
      const record = entry as object;
      return {
        class: requiredDataValue(record, "class") as EffectiveToolSurfaceClass,
        id: requiredDataValue(record, "id") as string,
      };
    },
  );
}

function snapshotClassObservations(
  value: unknown,
  budget: InputBudget,
): Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassObservationState>> {
  requireCallerRecord(value, budget);
  const record = value as object;
  const result: Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassObservationState>> = {};
  for (const className of [
    "native_core",
    "host_dynamic",
    "app_connector",
    "configured_mcp",
    "discovery",
  ] as const satisfies readonly EffectiveToolSurfaceClass[]) {
    const descriptor = optionalDataDescriptor(record, className);
    if (descriptor) {
      result[className] = descriptor.value as ToolSurfaceClassObservationState;
    }
  }
  return result;
}

function snapshotScalarArray<T>(
  value: unknown,
  maximum: number,
  budget: InputBudget,
): T[] {
  return snapshotArray(value, maximum, budget, (entry) => entry as T);
}

function snapshotArray<T>(
  value: unknown,
  maximum: number,
  budget: InputBudget,
  snapshotEntry: (entry: unknown, index: number) => T,
): T[] {
  requireCallerArray(value, budget);
  const array = value as unknown[];
  const length = arrayLength(array);
  if (length > maximum) {
    throw new RangeError(
      "Effective tool-surface host-binding input inspection exceeded its limit",
    );
  }
  const result = new Array<T>(length);
  for (let index = 0; index < length; index += 1) {
    result[index] = snapshotEntry(
      requiredDataValue(array, String(index)),
      index,
    );
  }
  return result;
}

function requireCallerRecord(value: unknown, budget: InputBudget): void {
  if (value === null || typeof value !== "object") throw inspectionError();
  noteObject(budget);
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw inspectionError();
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    throw inspectionError();
  }
}

function requireCallerArray(value: unknown, budget: InputBudget): void {
  if (value === null || typeof value !== "object") throw inspectionError();
  noteObject(budget);
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw inspectionError();
  }
  if (!isArray || prototype !== Array.prototype) {
    throw inspectionError();
  }
}

function noteObject(budget: InputBudget): void {
  budget.objects += 1;
  if (budget.objects > maximumInputObjects) {
    throw new RangeError(
      "Effective tool-surface host-binding input inspection exceeded its limit",
    );
  }
}

function arrayLength(value: unknown[]): number {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw inspectionError();
  }
  if (
    !descriptor
    || !("value" in descriptor)
    || descriptor.enumerable
    || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0
  ) {
    throw inspectionError();
  }
  return descriptor.value as number;
}

function requiredDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = optionalDataDescriptor(value, key);
  if (!descriptor) throw inspectionError();
  return descriptor.value;
}

function optionalDataValue(value: object, key: PropertyKey): unknown {
  return optionalDataDescriptor(value, key)?.value;
}

function optionalDataDescriptor(
  value: object,
  key: PropertyKey,
): (PropertyDescriptor & { value: unknown }) | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw inspectionError();
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) throw inspectionError();
  if (descriptor.value === undefined) return undefined;
  return descriptor as PropertyDescriptor & { value: unknown };
}

function inspectionError(): RangeError {
  return new RangeError(
    "Effective tool-surface host-binding input inspection failed",
  );
}
