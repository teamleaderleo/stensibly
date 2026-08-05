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

export function compileProjectDeltaBrief(
  input: CompileProjectDeltaBriefInput,
): ProjectDeltaBrief {
  const brief = compileProjectDeltaBriefBase(input);
  assertRetainedCredentialFree(brief);
  return brief;
}

export function renderProjectDeltaBriefMarkdown(
  brief: ProjectDeltaBrief,
): string {
  assertRetainedCredentialFree(brief);
  return renderProjectDeltaBriefMarkdownBase(brief);
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
    if (inspectedObjects > 20_000) {
      throw new TypeError("Project delta brief inspection exceeded its limit");
    }

    const { prototype, keys } = inspectObject(current);
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) {
        throw new TypeError("Project delta brief inspection failed");
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
          throw new TypeError("Project delta brief inspection failed");
        }
        pending.push(dataDescriptorValue(current, key));
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
      pending.push(dataDescriptorValue(current, key));
    }
  }
}

function inspectObject(value: object): {
  prototype: object | null;
  keys: readonly PropertyKey[];
} {
  try {
    return {
      prototype: Object.getPrototypeOf(value) as object | null,
      keys: Reflect.ownKeys(value),
    };
  } catch {
    throw new TypeError("Project delta brief inspection failed");
  }
}

function dataDescriptorValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Project delta brief inspection failed");
    }
    return descriptor.value;
  } catch (error) {
    if (
      error instanceof TypeError
      && error.message === "Project delta brief inspection failed"
    ) {
      throw error;
    }
    throw new TypeError("Project delta brief inspection failed");
  }
}
