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
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (containsRealisticRetainedCredential(current)) {
        throw new TypeError("Project delta brief contains credential-shaped text");
      }
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      for (const entry of current) pending.push(entry);
      continue;
    }
    for (const entry of Object.values(current as Record<string, unknown>)) {
      pending.push(entry);
    }
  }
}
