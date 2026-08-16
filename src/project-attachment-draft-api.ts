import type { Hono } from "hono";
import { requireHttpAccess, type StensiblyEnv } from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { prepareProjectAttachmentDraft } from "./project-attachment-draft.js";
import {
  projectRepositorySetupObservationLedger,
} from "./project-repository-setup-observation-ledger.js";

const route = "/projects/:project/attachment/draft";

export function registerProjectAttachmentDraftApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
): void {
  const observations = projectRepositorySetupObservationLedger(ledger);
  if (!observations) return;

  app.get(route, async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "admin", project);
    if (denied) return denied;

    let proposal;
    try {
      proposal = await observations.getProjectRepositorySetupObservation(project);
    } catch {
      return context.json({
        error: "Attachment draft context could not be read",
        code: "attachment_draft_context_failed",
      }, 502);
    }
    if (!proposal) {
      return context.json({
        error: "A saved repository setup proposal is required before draft generation",
        code: "repository_setup_observation_required",
      }, 409);
    }

    try {
      return context.json({
        draft: prepareProjectAttachmentDraft({ project, proposal }),
      });
    } catch {
      return context.json({
        error: "Attachment draft could not be generated from the saved repository proposal",
        code: "attachment_draft_invalid",
      }, 400);
    }
  });
}
