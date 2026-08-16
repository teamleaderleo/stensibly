import { Hono } from "hono";
import {
  createHttpAuthMiddleware,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import {
  assembleProjectCorrespondenceV1,
  type ProjectCorrespondenceSourceV1,
} from "./project-correspondence.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export function createProjectCorrespondenceApi(
  authenticator: ApiTokenAuthenticator,
  authOptions: HttpAuthOptions,
  source: ProjectCorrespondenceSourceV1,
  now: () => number = Date.now,
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  app.use("*", createHttpAuthMiddleware(authenticator, authOptions));

  app.get("/projects/:project/correspondence", async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 12 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return context.json({
        error: "Correspondence limit must be between 1 and 50",
        code: "invalid_request",
      }, 400);
    }
    const correspondence = await assembleProjectCorrespondenceV1(source, {
      project,
      limit,
      asOf: new Date(now()).toISOString(),
    });
    return context.json({ correspondence });
  });

  return app;
}
