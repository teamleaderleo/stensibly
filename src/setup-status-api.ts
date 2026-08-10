import { Hono } from "hono";
import {
  createHttpAuthMiddleware,
  currentPrincipal,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import type { ProjectAttachmentSetupContext } from "./project-attachment-setup-plan.js";
import type {
  ProjectRepositorySetupObservation,
} from "./project-repository-setup-observation.js";
import {
  projectRepositorySetupObservationLedger,
  type ProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-ledger.js";
import { projectSetupStatusWithRepository } from "./setup-status-repository.js";
import type { SetupStatusInput } from "./setup-status.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export type SetupStatusPrincipalKind = "account" | "api_token" | "anonymous";

export interface ProjectSetupStatusObservation {
  setup: SetupStatusInput;
  repositorySetup?: ProjectAttachmentSetupContext | null;
}

export interface ProjectSetupStatusObserver {
  observe(input: {
    project: string;
    principalKind: SetupStatusPrincipalKind;
    hasAcceptedAttachment: boolean;
  }): ProjectSetupStatusObservation | Promise<ProjectSetupStatusObservation>;
}

export function createProjectSetupStatusApi(
  authenticator: ApiTokenAuthenticator,
  ledger: WorkLedger,
  authOptions: HttpAuthOptions,
  observer: ProjectSetupStatusObserver,
  repositorySetupObservations?: ProjectRepositorySetupObservationLedger | null,
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const route = "/projects/:project/setup-status";
  const setupObservationLedger = repositorySetupObservations
    ?? projectRepositorySetupObservationLedger(ledger);
  app.use(route, createHttpAuthMiddleware(authenticator, authOptions));
  app.get(route, async (context) => {
    const rawProject = context.req.param("project");
    const denied = requireHttpAccess(context, "read", rawProject);
    if (denied) return denied;
    const project = admittedProjectSlug(rawProject);
    if (!project) {
      return context.json({
        error: "Setup status project is invalid",
        code: "invalid_project",
      }, 400);
    }

    const principal = currentPrincipal(context);
    const attachments = projectAttachmentLedger(ledger);
    if (!attachments) {
      return context.json({
        error: "Project attachments are unavailable on this backend",
        code: "not_supported",
      }, 501);
    }

    let attachment;
    try {
      attachment = await attachments.getProjectAttachment(project);
    } catch {
      return context.json({
        error: "Project attachment observation failed",
        code: "attachment_observation_failed",
      }, 502);
    }

    let repositorySetupObservation: ProjectRepositorySetupObservation | null = null;
    if (!attachment && setupObservationLedger) {
      try {
        repositorySetupObservation = await setupObservationLedger
          .getCurrentProjectRepositorySetupObservation(project);
      } catch {
        return context.json({
          error: "Repository setup observation failed",
          code: "repository_setup_observation_failed",
        }, 502);
      }
    }

    let observation: ProjectSetupStatusObservation;
    try {
      observation = await observer.observe({
        project,
        principalKind: principal
          ? principal.kind === "account" ? "account" : "api_token"
          : "anonymous",
        hasAcceptedAttachment: attachment !== null,
      });
    } catch {
      return context.json({
        error: "Setup status observation failed",
        code: "observation_failed",
      }, 502);
    }

    try {
      const setupStatus = projectSetupStatusWithRepository({
        setup: observation.setup,
        project,
        attachment,
        repositorySetup: observation.repositorySetup,
        repositorySetupObservation,
      });
      return context.json({ setupStatus });
    } catch {
      return context.json({
        error: "Setup status observation is invalid",
        code: "invalid_observation",
      }, 400);
    }
  });
  return app;
}

function admittedProjectSlug(value: string): string | null {
  return value.length >= 1
    && value.length <= 80
    && /^[a-z0-9][a-z0-9-_]*$/u.test(value)
    ? value
    : null;
}
