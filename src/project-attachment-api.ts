import type { Hono } from "hono";
import { z } from "zod";
import {
  currentPrincipal,
  requireHttpAccess,
  type HttpPrincipal,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import {
  acceptProjectAttachmentSchema,
  projectAttachmentLedger,
  ProjectAttachmentWideningError,
} from "./project-attachment-ledger.js";

export function registerProjectAttachmentApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
): void {
  app.get("/projects/:project/attachment", async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    const attachments = projectAttachmentLedger(ledger);
    if (!attachments) {
      return context.json({
        error: "Project attachments are unavailable on this backend",
        code: "not_supported",
      }, 501);
    }
    const attachment = await attachments.getProjectAttachment(project);
    if (!attachment) {
      return context.json({
        error: `Project ${project} has no accepted attachment`,
        code: "not_found",
      }, 404);
    }
    return context.json({ attachment });
  });

  app.put("/projects/:project/attachment", async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "admin", project);
    if (denied) return denied;
    const attachments = projectAttachmentLedger(ledger);
    if (!attachments) {
      return context.json({
        error: "Project attachments are unavailable on this backend",
        code: "not_supported",
      }, 501);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "Request body must be valid JSON", code: "invalid_request" }, 400);
    }
    const parsed = acceptProjectAttachmentSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({
        error: "Project attachment request is invalid",
        code: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }, 400);
    }

    const principal = currentPrincipal(context);
    if (!principal) {
      return context.json({ error: "An authenticated importer is required", code: "unauthorized" }, 401);
    }
    try {
      const acceptance = await attachments.acceptProjectAttachment({
        project,
        snapshot: parsed.data.snapshot,
        sourceRevision: parsed.data.sourceRevision,
        acceptedBy: importerIdentity(principal),
        acceptAuthorityWidening: parsed.data.acceptAuthorityWidening,
      });
      return context.json(acceptance, acceptance.replayed ? 200 : 201);
    } catch (error) {
      if (error instanceof ProjectAttachmentWideningError) {
        return context.json({
          error: error.message,
          code: "authority_widening_requires_acknowledgement",
        }, 409);
      }
      if (error instanceof z.ZodError) {
        return context.json({
          error: "Project attachment request is invalid",
          code: "invalid_request",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }, 400);
      }
      throw error;
    }
  });
}

function importerIdentity(principal: HttpPrincipal): string {
  const kind = principal.kind === "account" ? "account" : "token";
  return `${kind}:${principal.name}`;
}
