import { Hono } from "hono";
import { z } from "zod";
import {
  createHttpAuthMiddleware,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { projectAttachmentLedger } from "./project-attachment-ledger.js";
import { prepareProjectAttachmentReview } from "./project-attachment-review.js";
import type {
  ProjectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

const projectAttachmentReviewRequestSchema = z.object({
  source: z.string().min(1).max(262_144),
  sourceRevision: z.string().min(1).max(240),
}).strict();

export function createProjectAttachmentReviewApi(
  authenticator: ApiTokenAuthenticator,
  ledger: WorkLedger,
  authOptions: HttpAuthOptions,
  repositorySetupObservations: ProjectRepositorySetupObservationLedger,
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  const route = "/projects/:project/attachment/review";
  app.use(route, createHttpAuthMiddleware(authenticator, authOptions));
  app.post(route, async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "admin", project);
    if (denied) return denied;
    if (!isProjectSlug(project)) {
      return context.json({
        error: "Attachment review project is invalid",
        code: "invalid_project",
      }, 400);
    }

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
      return context.json({
        error: "Request body must be valid JSON",
        code: "invalid_request",
      }, 400);
    }
    const parsed = projectAttachmentReviewRequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({
        error: "Project attachment review request is invalid",
        code: "invalid_request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }, 400);
    }

    let proposal;
    let currentAttachment;
    try {
      [proposal, currentAttachment] = await Promise.all([
        repositorySetupObservations.getProjectRepositorySetupObservation(project),
        attachments.getProjectAttachment(project),
      ]);
    } catch {
      return context.json({
        error: "Attachment review context could not be read",
        code: "attachment_review_context_failed",
      }, 502);
    }
    if (!proposal) {
      return context.json({
        error: "A saved repository setup proposal is required before attachment review",
        code: "repository_setup_observation_required",
      }, 409);
    }

    try {
      const review = prepareProjectAttachmentReview({
        project,
        proposal,
        source: parsed.data.source,
        sourceRevision: parsed.data.sourceRevision,
        currentAttachment,
      });
      return context.json({ review });
    } catch {
      return context.json({
        error: "Attachment review source does not match the saved repository proposal",
        code: "attachment_review_invalid",
      }, 400);
    }
  });
  return app;
}

function isProjectSlug(value: string): boolean {
  return value.length >= 1
    && value.length <= 80
    && /^[a-z0-9][a-z0-9-_]*$/u.test(value);
}
