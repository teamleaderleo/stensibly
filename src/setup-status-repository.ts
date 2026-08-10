import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  projectAttachmentRecovery,
  type ProjectAttachmentRecovery,
  type ProjectAttachmentSetupContext,
} from "./project-attachment-setup-plan.js";
import {
  createProjectRepositorySetupObservationRecord,
  type ProjectRepositorySetupObservationRecord,
} from "./project-repository-setup-observation.js";
import {
  projectSetupStatus,
  type SetupStatusInput,
  type SetupStatusProjection,
} from "./setup-status.js";

export interface RepositoryAwareSetupStatusInput {
  setup: SetupStatusInput;
  project: string;
  attachment: ProjectAttachmentRecord | null;
  repositorySetup?: ProjectAttachmentSetupContext | null;
  repositorySetupObservation?: ProjectRepositorySetupObservationRecord | null;
}

export interface RepositoryAwareSetupStatusProjection
  extends SetupStatusProjection {
  repositoryRecovery: ProjectAttachmentRecovery;
  repositorySetupObservation: ProjectRepositorySetupObservationRecord | null;
}

/**
 * Composes the generic onboarding readiness projection with bounded repository
 * continuation evidence. This is observation only: neither the recovery plan
 * nor the pre-attachment observation can authorize a repository effect.
 */
export function projectSetupStatusWithRepository(
  input: RepositoryAwareSetupStatusInput,
): RepositoryAwareSetupStatusProjection {
  const setup = projectSetupStatus(input.setup);
  const repositoryState = input.setup.steps.repository;
  const setupObservation = admittedSetupObservation(
    input.project,
    input.repositorySetupObservation ?? null,
  );

  if (repositoryState === "deferred") {
    return {
      ...setup,
      repositoryRecovery: null,
      repositorySetupObservation: null,
    };
  }

  if (repositoryState === "ready") {
    if (!input.attachment) {
      throw new RangeError(
        "Ready repository setup requires an accepted project attachment",
      );
    }
    return {
      ...setup,
      repositoryRecovery: null,
      repositorySetupObservation: null,
    };
  }

  if (input.attachment) {
    throw new RangeError(
      "Accepted project attachment conflicts with non-ready repository setup state",
    );
  }

  if (setupObservation && input.repositorySetup) {
    if (
      input.repositorySetup.repositoryFullName !== setupObservation.repositoryFullName
      || input.repositorySetup.defaultBranch !== setupObservation.defaultBranch
    ) {
      throw new RangeError(
        "Repository setup context conflicts with the current advisory observation",
      );
    }
  }

  return {
    ...setup,
    repositoryRecovery: projectAttachmentRecovery(
      input.project,
      null,
      input.repositorySetup,
    ),
    repositorySetupObservation: setupObservation,
  };
}

function admittedSetupObservation(
  project: string,
  observation: ProjectRepositorySetupObservationRecord | null,
): ProjectRepositorySetupObservationRecord | null {
  if (!observation) return null;
  const admitted = createProjectRepositorySetupObservationRecord({
    id: observation.id,
    project: observation.project,
    repositoryFullName: observation.repositoryFullName,
    defaultBranch: observation.defaultBranch,
    sourceKind: observation.sourceKind,
    semanticFingerprint: observation.semanticFingerprint,
    observedAt: observation.observedAt,
  });
  if (
    observation.version !== 1
    || observation.authorizesProviderEffect !== false
    || observation.containsSecrets !== false
    || admitted.project !== project
  ) {
    throw new RangeError(
      "Repository setup observation does not match the selected project",
    );
  }
  return admitted;
}
