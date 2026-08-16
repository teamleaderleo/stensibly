import { Hono } from "hono";
import {
  createHttpAuthMiddleware,
  requireHttpAccess,
  type HttpAuthOptions,
  type StensiblyEnv,
} from "./http-auth.js";
import type {
  ProjectActivityOrchestratorSourceV1,
} from "./convex-project-activity-source.js";
import {
  assembleProjectCorrespondenceV1,
  type ProjectCorrespondenceAssemblyV1,
  type ProjectCorrespondenceSourceV1,
} from "./project-correspondence.js";
import {
  compileProjectActivityV1,
  type ProjectActivityProjectionV1,
} from "./project-activity.js";
import type { ApiTokenAuthenticator } from "./token-provider.js";

export interface ProjectActivityReadRequestV1 {
  readonly project: string;
  readonly limit: number;
  readonly asOf: string;
}

export interface ProjectActivityReadV1 {
  readonly activity: ProjectActivityProjectionV1;
  readonly sourceCompleteness: Readonly<{
    correspondence: ProjectCorrespondenceAssemblyV1["completeness"];
    orchestrator: Readonly<{ truncated: boolean }>;
  }>;
}

export async function assembleProjectActivityReadV1(
  correspondenceSource: ProjectCorrespondenceSourceV1,
  orchestratorSource: ProjectActivityOrchestratorSourceV1,
  request: ProjectActivityReadRequestV1,
): Promise<ProjectActivityReadV1> {
  const [correspondence, orchestrator] = await Promise.all([
    assembleProjectCorrespondenceV1(correspondenceSource, {
      project: request.project,
      limit: request.limit,
      asOf: request.asOf,
    }),
    orchestratorSource.listRecent({
      project: request.project,
      limit: request.limit,
    }),
  ]);
  const activity = compileProjectActivityV1({
    project: request.project,
    asOf: request.asOf,
    correspondence: correspondence.rows,
    orchestrator: orchestrator.orchestrator,
    correspondenceTruncated: correspondence.completeness.truncated,
    orchestratorTruncated: orchestrator.orchestratorTruncated,
    limit: request.limit,
  });
  return Object.freeze({
    activity,
    sourceCompleteness: Object.freeze({
      correspondence: correspondence.completeness,
      orchestrator: Object.freeze({
        truncated: orchestrator.orchestratorTruncated,
      }),
    }),
  });
}

export function createProjectActivityApi(
  authenticator: ApiTokenAuthenticator,
  authOptions: HttpAuthOptions,
  correspondenceSource: ProjectCorrespondenceSourceV1,
  orchestratorSource: ProjectActivityOrchestratorSourceV1,
  now: () => number = Date.now,
): Hono<StensiblyEnv> {
  const app = new Hono<StensiblyEnv>();
  app.use("*", createHttpAuthMiddleware(authenticator, authOptions));

  app.get("/projects/:project/activity", async (context) => {
    const project = context.req.param("project");
    const denied = requireHttpAccess(context, "read", project);
    if (denied) return denied;
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 30 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      return context.json({
        error: "Project Activity limit must be between 1 and 50",
        code: "invalid_request",
      }, 400);
    }
    const read = await assembleProjectActivityReadV1(
      correspondenceSource,
      orchestratorSource,
      {
        project,
        limit,
        asOf: new Date(now()).toISOString(),
      },
    );
    return context.json(read);
  });

  return app;
}
