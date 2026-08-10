import type { WorkLedger } from "./ledger.js";
import {
  compileProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservationInput,
} from "./project-repository-setup-observation.js";

export interface RecordProjectRepositorySetupObservationInput
  extends ProjectRepositorySetupObservationInput {
  expectedCurrentFingerprint: string | null;
}

export interface ProjectRepositorySetupObservationAcceptance {
  observation: ProjectRepositorySetupObservation;
  replayed: boolean;
  replacedFingerprint: string | null;
}

export interface ProjectRepositorySetupObservationLedger {
  getCurrentProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservation | null>;
  recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ): Promise<ProjectRepositorySetupObservationAcceptance>;
}

export interface PreparedProjectRepositorySetupObservationReplacement {
  observation: ProjectRepositorySetupObservation;
  replay: ProjectRepositorySetupObservation | null;
  replacedFingerprint: string | null;
}

export class ProjectRepositorySetupObservationConflictError extends Error {
  constructor(message = "Repository setup observation changed; reload before replacing it") {
    super(message);
    this.name = "ProjectRepositorySetupObservationConflictError";
  }
}

export function projectRepositorySetupObservationLedger(
  ledger: WorkLedger,
): ProjectRepositorySetupObservationLedger | null {
  const candidate = ledger as WorkLedger & Partial<ProjectRepositorySetupObservationLedger>;
  return typeof candidate.getCurrentProjectRepositorySetupObservation === "function"
    && typeof candidate.recordProjectRepositorySetupObservation === "function"
    ? candidate as ProjectRepositorySetupObservationLedger
    : null;
}

export function prepareProjectRepositorySetupObservationReplacement(
  current: ProjectRepositorySetupObservation | null,
  input: RecordProjectRepositorySetupObservationInput,
): PreparedProjectRepositorySetupObservationReplacement {
  const observation = compileProjectRepositorySetupObservation({
    project: input.project,
    repositoryFullName: input.repositoryFullName,
    defaultBranch: input.defaultBranch,
    sourceKind: input.sourceKind,
    observedAt: input.observedAt,
  });

  if (current?.fingerprint === observation.fingerprint) {
    return {
      observation: current,
      replay: current,
      replacedFingerprint: current.fingerprint,
    };
  }

  const expected = exactNullableFingerprint(input.expectedCurrentFingerprint);
  const currentFingerprint = current?.fingerprint ?? null;
  if (expected !== currentFingerprint) {
    throw new ProjectRepositorySetupObservationConflictError();
  }
  if (
    current
    && Date.parse(observation.observedAt) <= Date.parse(current.observedAt)
  ) {
    throw new ProjectRepositorySetupObservationConflictError(
      "Repository setup observation replacement must be newer than the current observation",
    );
  }

  return {
    observation,
    replay: null,
    replacedFingerprint: currentFingerprint,
  };
}

function exactNullableFingerprint(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ProjectRepositorySetupObservationConflictError(
      "Expected repository setup observation fingerprint is invalid",
    );
  }
  return value;
}
