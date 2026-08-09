import type { Hono } from "hono";
import {
  currentPrincipal,
  requireHttpAccess,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import {
  projectAttachmentLedger,
} from "./project-attachment-ledger.js";
import type { ProjectAttachmentSetupContext } from "./project-attachment-setup-plan.js";
import {
  projectSetupStatusWithRepository,
} from "./setup-status-repository.js";
import type { SetupStatusInput } from "./setup-status.js";

export type SetupStatusPrincipalKind = "account" | "api_token";

export interface ProjectSetupStatusObservation {
  setup: SetupStatusInput;
  repositorySetup?: ProjectAttachmentSetupContext | null;
}

export interface ProjectSetupStatusObserver {
  observe(input: {
    project: string;
    principalKind: SetupStatusPrincipalKind;
  }): ProjectSetupStatusObservation | Promise<ProjectSetupStatusObservation>;
}

export function registerProjectSetupStatusApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
  observer: ProjectSetupStatusObserver | undefined,
): void {
  if (!observer) return;

  app.get("/projects/:project/setup-status", async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;

    const principal = currentPrincipal(context);
    if (!principal) {
      return context.json({
        error: "An authenticated setup-status reader is required",
        code: "unauthorized",
      }, 401);
    }

    const attachments = projectAttachmentLedger(ledger);
    if (!attachments) {
      return context.json({
        error: "Project attachments are unavailable on this backend",
        code: "not_supported",
      }, 501);
    }
    const attachment = await attachments.getProjectAttachment(project);

    let observation: ProjectSetupStatusObservation;
    try {
      observation = await observer.observe({
        project,
        principalKind: principal.kind === "account" ? "account" : "api_token",
      });
    } catch {
      throw new Error("Setup status observation failed");
    }

    const setupStatus = projectSetupStatusWithRepository({
      setup: observation.setup,
      project,
      attachment,
      repositorySetup: observation.repositorySetup,
    });
    return context.json({ setupStatus });
  });
}
