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

export function compileProjectDeltaBrief(
  input: CompileProjectDeltaBriefInput,
): ProjectDeltaBrief {
  const detached = detachInputGraph(input) as CompileProjectDeltaBriefInput;
  assertRetainedCredentialFree(detached);
  const brief = compileProjectDeltaBriefBase(detached);
  assertRetainedCredentialFree(brief);
  return brief;
}

export function renderProjectDeltaBriefMarkdown(
  brief: ProjectDeltaBrief,
): string {
  assertRetainedCredentialFree(brief);
  return renderProjectDeltaBriefMarkdownBase(brief);
}

function detachInputGraph(value: unknown): unknown {
  const seen = new Map<object, unknown>();
  let inspectedObjects = 0;

  const detach = (current: unknown): unknown => {
    if (current === null || typeof current !== "object") return current;
    const prior = seen.get(current);
    if (prior !== undefined) return prior;
    inspectedObjects += 1;
    if (inspectedObjects > maximumInputObjects) {
      throw new TypeError("Project delta input inspection exceeded its limit");
    }

    const { prototype, keys } = inspectObject(
      current,
      "Project delta input inspection failed",
    );
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) {
        throw new TypeError("Project delta input inspection failed");
      }
      const length = arrayLength(current);
      if (length > maximumInputArrayLength) {
        throw new TypeError("Project delta input inspection exceeded its limit");
      }
      const allowed = new Set<PropertyKey>(["length"]);
      for (let index = 0; index < length; index += 1) {
        allowed.add(String(index));
      }
      if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
        throw new TypeError("Project delta input inspection failed");
      }
      const result: unknown[] = new Array(length);
      seen.set(current, result);
      for (let index = 0; index < length; index += 1) {
        result[index] = detach(inputDataDescriptorValue(current, String(index)));
      }
      return result;
    }

    if (prototype !== Object.prototype) {
      throw new TypeError("Project delta input inspection failed");
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new TypeError("Project delta input inspection failed");
      }
      Object.defineProperty(result, key, {
        value: detach(inputDataDescriptorValue(current, key)),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  };

  return detach(value);
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
