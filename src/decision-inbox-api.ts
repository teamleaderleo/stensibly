import { type Context, type Hono } from "hono";
import { buildDecisionInbox } from "./decision-inbox.js";
import {
  currentPrincipal,
  requireHttpAccess,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";
import { principalCanAccessProject } from "./token-contracts.js";

export function registerDecisionInboxApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
): void {
  app.get("/decision-inbox", async (context) => {
    const project = context.req.query("project")?.trim() || undefined;
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return context.json({
        error: "Decision inbox limit must be between 1 and 100",
        code: "invalid_request",
      }, 400);
    }

    const inbox = await buildDecisionInbox(ledger, {
      ...(project ? { project } : {}),
      limit,
    });
    const principal = currentPrincipal(context);
    if (!principal || project) return context.json({ inbox });

    const entries = inbox.entries.filter((entry) =>
      principalCanAccessProject(principal, entry.project)
    );
    return context.json({
      inbox: {
        ...inbox,
        total: entries.length,
        entries,
      },
    });
  });
}

export function decisionInboxUnavailable(context: Context<StensiblyEnv>) {
  return context.json({
    error: "Decision inbox is unavailable on this backend",
    code: "unsupported_feature",
  }, 501);
}
