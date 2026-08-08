import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  compileProjectDeltaBrief as compileProjectDeltaBriefBase,
  renderProjectDeltaBriefMarkdown as renderProjectDeltaBriefMarkdownBase,
  projectDeltaAuthorityStates,
  projectDeltaDecisionStates,
  projectDeltaObservationKinds,
  projectDeltaProviderEffectStates,
  projectDeltaSourceStates,
  projectDeltaWorkStates,
  type CompileProjectDeltaBriefInput,
  type ProjectDeltaAuthorityObservation,
  type ProjectDeltaAuthorityState,
  type ProjectDeltaBrief,
  type ProjectDeltaCategory,
  type ProjectDeltaChange,
  type ProjectDeltaCheckpoint,
  type ProjectDeltaDecisionObservation,
  type ProjectDeltaDecisionState,
  type ProjectDeltaNextAction,
  type ProjectDeltaNextActionKind,
  type ProjectDeltaObservation,
  type ProjectDeltaObservationKind,
  type ProjectDeltaProviderEffectObservation,
  type ProjectDeltaProviderEffectState,
  type ProjectDeltaSourceObservation,
  type ProjectDeltaSourceState,
  type ProjectDeltaWorkObservation,
  type ProjectDeltaWorkState,
} from "./project-delta-brief-base.js";

export {
  projectDeltaAuthorityStates,
  projectDeltaDecisionStates,
  projectDeltaObservationKinds,
  projectDeltaProviderEffectStates,
  projectDeltaSourceStates,
  projectDeltaWorkStates,
};
export type {
  CompileProjectDeltaBriefInput,
  ProjectDeltaAuthorityObservation,
  ProjectDeltaAuthorityState,
  ProjectDeltaBrief,
  ProjectDeltaCategory,
  ProjectDeltaChange,
  ProjectDeltaCheckpoint,
  ProjectDeltaDecisionObservation,
  ProjectDeltaDecisionState,
  ProjectDeltaNextAction,
  ProjectDeltaNextActionKind,
  ProjectDeltaObservation,
  ProjectDeltaObservationKind,
  ProjectDeltaProviderEffectObservation,
  ProjectDeltaProviderEffectState,
  ProjectDeltaSourceObservation,
  ProjectDeltaSourceState,
  ProjectDeltaWorkObservation,
  ProjectDeltaWorkState,
};

const maximumInputObjects = 20_000;
const maximumInputArrayLength = 4_096;
const projectDeltaCategories = [
  "completed",
  "failed",
  "newlyBlocked",
  "unblocked",
  "decisionsAdded",
  "decisionsResolved",
  "authorityChanged",
  "superseded",
  "ambiguous",
  "recovered",
  "sourceFreshness",
] as const satisfies readonly ProjectDeltaCategory[];

interface SnapshotBudget {
  objects: number;
}

export function compileProjectDeltaBrief(
  input: CompileProjectDeltaBriefInput,
): ProjectDeltaBrief {
  const detached = snapshotCompileInput(input);
  assertRetainedCredentialFree(detached);
  const brief = compileProjectDeltaBriefBase(detached);
  assertRetainedCredentialFree(brief);
  return brief;
}

export function renderProjectDeltaBriefMarkdown(
  brief: ProjectDeltaBrief,
): string {
  const detached = snapshotProjectDeltaBrief(brief);
  assertRetainedCredentialFree(detached);
  return renderProjectDeltaBriefMarkdownBase(detached);
}

function snapshotCompileInput(value: unknown): CompileProjectDeltaBriefInput {
  const budget = { objects: 0 };
  requireInputObject(value, budget);
  const record = value as object;
  return {
    project: inputEnvelopeValue(record, "project") as string,
    fromCheckpoint: snapshotInputCheckpoint(
      inputEnvelopeValue(record, "fromCheckpoint"),
      budget,
    ),
    toCheckpoint: snapshotInputCheckpoint(
      inputEnvelopeValue(record, "toCheckpoint"),
      budget,
    ),
    observations: snapshotInputArray(
      inputEnvelopeValue(record, "observations"),
      budget,
      maximumInputArrayLength,
      snapshotInputObservation,
    ),
    limit: inputEnvelopeValue(record, "limit") as number,
  };
}

function snapshotInputCheckpoint(
  value: unknown,
  budget: SnapshotBudget,
): ProjectDeltaCheckpoint {
  requireInputObject(value, budget);
  const record = value as object;
  return {
    id: inputDataDescriptorValue(record, "id") as string,
    throughSequence: inputDataDescriptorValue(record, "throughSequence") as number,
    observedAt: inputDataDescriptorValue(record, "observedAt") as string,
  };
}

function snapshotInputObservation(
  value: unknown,
  budget: SnapshotBudget,
): ProjectDeltaObservation {
  requireInputObject(value, budget);
  const record = value as object;
  const kind = inputDataDescriptorValue(record, "kind") as ProjectDeltaObservationKind;
  const base = {
    observationId: inputDataDescriptorValue(record, "observationId") as string,
    sequence: inputDataDescriptorValue(record, "sequence") as number,
    project: inputDataDescriptorValue(record, "project") as string,
    subjectId: inputDataDescriptorValue(record, "subjectId") as string,
    title: inputDataDescriptorValue(record, "title") as string,
    summary: inputDataDescriptorValue(record, "summary") as string | null,
    observedAt: inputDataDescriptorValue(record, "observedAt") as string,
    sourceReferences: snapshotInputArray(
      inputDataDescriptorValue(record, "sourceReferences"),
      budget,
      maximumInputArrayLength,
      (entry) => entry as string,
    ),
  };

  if (kind === "authority") {
    return {
      ...base,
      kind,
      state: inputDataDescriptorValue(record, "state") as ProjectDeltaAuthorityState,
      generation: inputDataDescriptorValue(record, "generation") as number,
      holderId: inputDataDescriptorValue(record, "holderId") as string | null,
    };
  }
  if (kind === "work") {
    return {
      ...base,
      kind,
      state: inputDataDescriptorValue(record, "state") as ProjectDeltaWorkState,
    };
  }
  if (kind === "decision") {
    return {
      ...base,
      kind,
      state: inputDataDescriptorValue(record, "state") as ProjectDeltaDecisionState,
    };
  }
  if (kind === "provider_effect") {
    return {
      ...base,
      kind,
      state: inputDataDescriptorValue(record, "state") as ProjectDeltaProviderEffectState,
    };
  }
  return {
    ...base,
    kind: kind as "source",
    state: inputDataDescriptorValue(record, "state") as ProjectDeltaSourceState,
  };
}

function snapshotInputArray<T>(
  value: unknown,
  budget: SnapshotBudget,
  maximumLength: number,
  snapshotEntry: (entry: unknown, budget: SnapshotBudget) => T,
): T[] {
  requireInputArray(value, budget);
  const array = value as unknown[];
  const length = inputArrayLength(array);
  if (length > maximumLength) {
    throw new TypeError("Project delta input inspection exceeded its limit");
  }
  const result: T[] = [];
  for (let index = 0; index < length; index += 1) {
    result.push(snapshotEntry(inputDataDescriptorValue(array, String(index)), budget));
  }
  return result;
}

function snapshotProjectDeltaBrief(value: unknown): ProjectDeltaBrief {
  const budget = { objects: 0 };
  requireBriefObject(value, budget);
  const record = value as object;
  const categories = Object.fromEntries(
    projectDeltaCategories.map((category) => [
      category,
      snapshotBriefArray(
        briefDataDescriptorValue(record, category),
        budget,
        snapshotProjectDeltaChange,
      ),
    ]),
  ) as Record<ProjectDeltaCategory, ProjectDeltaChange[]>;
  const rawNextAction = briefDataDescriptorValue(record, "nextAction");
  return {
    project: briefDataDescriptorValue(record, "project") as string,
    fromCheckpoint: snapshotBriefCheckpoint(
      briefDataDescriptorValue(record, "fromCheckpoint"),
      budget,
    ),
    toCheckpoint: snapshotBriefCheckpoint(
      briefDataDescriptorValue(record, "toCheckpoint"),
      budget,
    ),
    completed: categories.completed,
    failed: categories.failed,
    newlyBlocked: categories.newlyBlocked,
    unblocked: categories.unblocked,
    decisionsAdded: categories.decisionsAdded,
    decisionsResolved: categories.decisionsResolved,
    authorityChanged: categories.authorityChanged,
    superseded: categories.superseded,
    ambiguous: categories.ambiguous,
    recovered: categories.recovered,
    sourceFreshness: categories.sourceFreshness,
    omittedCounts: snapshotOmittedCounts(
      briefDataDescriptorValue(record, "omittedCounts"),
      budget,
    ),
    nextAction: rawNextAction === null
      ? null
      : snapshotBriefNextAction(rawNextAction, budget),
    sourceReferences: snapshotBriefArray(
      briefDataDescriptorValue(record, "sourceReferences"),
      budget,
      (entry) => entry as string,
    ),
    authorizesMutation: briefDataDescriptorValue(record, "authorizesMutation") as false,
    authorizesAuthority: briefDataDescriptorValue(record, "authorizesAuthority") as false,
    briefFingerprint: briefDataDescriptorValue(record, "briefFingerprint") as string,
  };
}

function snapshotBriefCheckpoint(
  value: unknown,
  budget: SnapshotBudget,
): ProjectDeltaCheckpoint {
  requireBriefObject(value, budget);
  const record = value as object;
  return {
    id: briefDataDescriptorValue(record, "id") as string,
    throughSequence: briefDataDescriptorValue(record, "throughSequence") as number,
    observedAt: briefDataDescriptorValue(record, "observedAt") as string,
  };
}

function snapshotProjectDeltaChange(
  value: unknown,
  budget: SnapshotBudget,
): ProjectDeltaChange {
  requireBriefObject(value, budget);
  const record = value as object;
  return {
    observationId: briefDataDescriptorValue(record, "observationId") as string,
    sequence: briefDataDescriptorValue(record, "sequence") as number,
    kind: briefDataDescriptorValue(record, "kind") as ProjectDeltaObservationKind,
    subjectId: briefDataDescriptorValue(record, "subjectId") as string,
    title: briefDataDescriptorValue(record, "title") as string,
    summary: briefDataDescriptorValue(record, "summary") as string | null,
    fromState: briefDataDescriptorValue(record, "fromState") as string | null,
    toState: briefDataDescriptorValue(record, "toState") as string,
    fromGeneration: briefDataDescriptorValue(record, "fromGeneration") as number | null,
    toGeneration: briefDataDescriptorValue(record, "toGeneration") as number | null,
    fromHolderId: briefDataDescriptorValue(record, "fromHolderId") as string | null,
    toHolderId: briefDataDescriptorValue(record, "toHolderId") as string | null,
    observedAt: briefDataDescriptorValue(record, "observedAt") as string,
    sourceReferences: snapshotBriefArray(
      briefDataDescriptorValue(record, "sourceReferences"),
      budget,
      (entry) => entry as string,
    ),
  };
}

function snapshotBriefNextAction(
  value: unknown,
  budget: SnapshotBudget,
): ProjectDeltaNextAction {
  requireBriefObject(value, budget);
  const record = value as object;
  return {
    kind: briefDataDescriptorValue(record, "kind") as ProjectDeltaNextActionKind,
    subjectId: briefDataDescriptorValue(record, "subjectId") as string,
    title: briefDataDescriptorValue(record, "title") as string,
    reason: briefDataDescriptorValue(record, "reason") as string,
    sourceReferences: snapshotBriefArray(
      briefDataDescriptorValue(record, "sourceReferences"),
      budget,
      (entry) => entry as string,
    ),
  };
}

function snapshotOmittedCounts(
  value: unknown,
  budget: SnapshotBudget,
): Readonly<Record<ProjectDeltaCategory | "sourceReferences", number>> {
  requireBriefObject(value, budget);
  const record = value as object;
  return Object.freeze({
    ...Object.fromEntries(projectDeltaCategories.map((category) => [
      category,
      briefDataDescriptorValue(record, category) as number,
    ])),
    sourceReferences: briefDataDescriptorValue(record, "sourceReferences") as number,
  }) as Readonly<Record<ProjectDeltaCategory | "sourceReferences", number>>;
}

function snapshotBriefArray<T>(
  value: unknown,
  budget: SnapshotBudget,
  snapshotEntry: (entry: unknown, budget: SnapshotBudget) => T,
): T[] {
  requireBriefArray(value, budget);
  const array = value as unknown[];
  const length = briefArrayLength(array);
  if (length > maximumInputArrayLength) {
    throw new TypeError("Project delta brief inspection exceeded its limit");
  }
  const result: T[] = [];
  for (let index = 0; index < length; index += 1) {
    result.push(snapshotEntry(briefDataDescriptorValue(array, String(index)), budget));
  }
  return result;
}

function requireInputObject(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Project delta input inspection failed");
  }
  noteObject(budget, "Project delta input inspection exceeded its limit");
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Project delta input inspection failed");
    }
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta input inspection failed")) throw error;
    throw new TypeError("Project delta input inspection failed");
  }
}

function requireInputArray(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Project delta input inspection failed");
  }
  noteObject(budget, "Project delta input inspection exceeded its limit");
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Project delta input inspection failed");
    }
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta input inspection failed")) throw error;
    throw new TypeError("Project delta input inspection failed");
  }
}

function requireBriefObject(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Project delta brief inspection failed");
  }
  noteObject(budget, "Project delta brief inspection exceeded its limit");
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("Project delta brief inspection failed");
    }
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta brief inspection failed")) throw error;
    throw new TypeError("Project delta brief inspection failed");
  }
}

function requireBriefArray(value: unknown, budget: SnapshotBudget): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Project delta brief inspection failed");
  }
  noteObject(budget, "Project delta brief inspection exceeded its limit");
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Project delta brief inspection failed");
    }
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta brief inspection failed")) throw error;
    throw new TypeError("Project delta brief inspection failed");
  }
}

function noteObject(budget: SnapshotBudget, message: string): void {
  budget.objects += 1;
  if (budget.objects > maximumInputObjects) throw new TypeError(message);
}

function inputEnvelopeValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new TypeError("Project delta input inspection failed");
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(
        "Project delta input fields must be enumerable data properties",
      );
    }
    return descriptor.value;
  } catch (error) {
    if (
      isFixedInspectionError(error, "Project delta input inspection failed")
      || isFixedInspectionError(
        error,
        "Project delta input fields must be enumerable data properties",
      )
    ) {
      throw error;
    }
    throw new TypeError("Project delta input inspection failed");
  }
}

function inputArrayLength(value: unknown[]): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0
    ) {
      throw new TypeError("Project delta input inspection failed");
    }
    return descriptor.value as number;
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta input inspection failed")) {
      throw error;
    }
    throw new TypeError("Project delta input inspection failed");
  }
}

function inputDataDescriptorValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(
        "Project delta input fields must be enumerable data properties",
      );
    }
    return descriptor.value;
  } catch (error) {
    if (
      isFixedInspectionError(
        error,
        "Project delta input fields must be enumerable data properties",
      )
    ) {
      throw error;
    }
    throw new TypeError("Project delta input inspection failed");
  }
}

function briefArrayLength(value: unknown[]): number {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable
      || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0
    ) {
      throw new TypeError("Project delta brief inspection failed");
    }
    return descriptor.value as number;
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta brief inspection failed")) {
      throw error;
    }
    throw new TypeError("Project delta brief inspection failed");
  }
}

function briefDataDescriptorValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Project delta brief inspection failed");
    }
    return descriptor.value;
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta brief inspection failed")) {
      throw error;
    }
    throw new TypeError("Project delta brief inspection failed");
  }
}

function assertRetainedCredentialFree(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let inspectedObjects = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsRealisticRetainedCredential(current)) {
        throw new TypeError("Project delta brief contains credential-shaped text");
      }
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    inspectedObjects += 1;
    if (inspectedObjects > maximumInputObjects) {
      throw new TypeError("Project delta brief inspection exceeded its limit");
    }

    const { prototype, keys } = inspectObject(
      current,
      "Project delta brief inspection failed",
    );
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) {
        throw new TypeError("Project delta brief inspection failed");
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
          throw new TypeError("Project delta brief inspection failed");
        }
        pending.push(outputDataDescriptorValue(current, key));
      }
      continue;
    }
    if (prototype !== Object.prototype) {
      throw new TypeError("Project delta brief inspection failed");
    }
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError("Project delta brief inspection failed");
      }
      pending.push(outputDataDescriptorValue(current, key));
    }
  }
}

function inspectObject(value: object, message: string): {
  prototype: object | null;
  keys: readonly PropertyKey[];
} {
  try {
    return {
      prototype: Object.getPrototypeOf(value) as object | null,
      keys: Reflect.ownKeys(value),
    };
  } catch {
    throw new TypeError(message);
  }
}

function outputDataDescriptorValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Project delta brief inspection failed");
    }
    return descriptor.value;
  } catch (error) {
    if (isFixedInspectionError(error, "Project delta brief inspection failed")) {
      throw error;
    }
    throw new TypeError("Project delta brief inspection failed");
  }
}

function isFixedInspectionError(error: unknown, message: string): error is TypeError {
  return error instanceof TypeError && error.message === message;
}