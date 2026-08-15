import { Hono } from "hono";
import { assembleControlRoomResumeInspectionV1 } from "./control-room-resume-inspection.js";
import { renderControlRoomResumeInspection } from "./control-room-resume-view.js";
import {
  createHttpAuthMiddleware,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import { getWorkRun } from "./runs.js";
import type { StensiblyStore } from "./store.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export function createControlRoomResumeInspectionRoutes(
  store: StensiblyStore,
  authenticator: ApiTokenAuthenticator,
  authOptions: HttpAuthOptions = { required: false },
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  app.use("*", createHttpAuthMiddleware(authenticator, authOptions));

  app.get("/runs/:id/resume-inspection", (context) => {
    const run = getWorkRun(store, context.req.param("id"));
    const project = store.getItem(run.itemId).project;
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    return context.html(renderControlRoomResumeInspection(
      assembleControlRoomResumeInspectionV1(store, run.id),
    ));
  });

  app.get("/api/runs/:id/resume-inspection", (context) => {
    const run = getWorkRun(store, context.req.param("id"));
    const project = store.getItem(run.itemId).project;
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    return context.json({
      inspection: assembleControlRoomResumeInspectionV1(store, run.id),
    });
  });

  return app;
}
