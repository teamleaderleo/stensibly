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
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const route = "/projects/:project/setup-status";
  app.use(route, createHttpAuthMiddleware(authenticator, authOptions));
  app.get(route, async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;

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
