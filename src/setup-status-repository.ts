import type { ProjectAttachmentRecord } from "./project-attachment-ledger.js";
import {
  projectAttachmentRecovery,
  type ProjectAttachmentRecovery,
  type ProjectAttachmentSetupContext,
} from "./project-attachment-setup-plan.js";
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
}

export interface RepositoryAwareSetupStatusProjection
  extends SetupStatusProjection {
  repositoryRecovery: ProjectAttachmentRecovery;
}

/**
 * Composes the generic onboarding readiness projection with the bounded project
 * attachment continuation. This is observation only: the returned recovery
 * plan cannot accept an attachment or authorize a repository effect.
 */
export function projectSetupStatusWithRepository(
  input: RepositoryAwareSetupStatusInput,
): RepositoryAwareSetupStatusProjection {
  const setup = projectSetupStatus(input.setup);
  const repositoryState = input.setup.steps.repository;

  if (repositoryState === "deferred") {
    return { ...setup, repositoryRecovery: null };
  }

  if (repositoryState === "ready") {
    if (!input.attachment) {
      throw new RangeError(
        "Ready repository setup requires an accepted project attachment",
      );
    }
    return { ...setup, repositoryRecovery: null };
  }

  if (input.attachment) {
    throw new RangeError(
      "Accepted project attachment conflicts with non-ready repository setup state",
    );
  }

  return {
    ...setup,
    repositoryRecovery: projectAttachmentRecovery(
      input.project,
      null,
      input.repositorySetup,
    ),
  };
}
