import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  projectAttachmentRecovery,
  type ProjectAttachmentRecovery,
  type ProjectAttachmentSetupContext,
} from "./project-attachment-setup-plan.js";
import type {
  ProjectRepositorySetupObservation,
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
  repositorySetupObservation?: ProjectRepositorySetupObservation | null;
}

export interface RepositoryAwareSetupStatusProjection
  extends SetupStatusProjection {
  repositoryRecovery: ProjectAttachmentRecovery;
  repositorySetupObservation: ProjectRepositorySetupObservation | null;
}

/**
 * Composes the generic onboarding readiness projection with the bounded project
 * attachment continuation. This is observation only: the returned recovery
 * plan and repository setup observation cannot accept an attachment or
 * authorize a repository effect.
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
  observation: ProjectRepositorySetupObservation | null,
): ProjectRepositorySetupObservation | null {
  if (!observation) return null;
  if (
    observation.project !== project
    || observation.authorizesProviderEffect !== false
    || observation.containsSecrets !== false
  ) {
    throw new RangeError(
      "Repository setup observation does not match the selected project",
    );
  }
  return observation;
}
