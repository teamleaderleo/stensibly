import { type Context, type Hono } from "hono";
import {
  continuationAccessProjects,
  supervisorPolicyAccessProjects,
} from "./continuation-authorization.js";
import {
  continuationLedger,
} from "./continuation-contracts.js";
import {
  continuationSupervisorLedger,
  queueContinuationForSupervisorSchema,
  runContinuationSupervisorPolicySchema,
} from "./continuation-supervisor-contracts.js";
import {
  currentPrincipal,
  requireHttpAccess,
  type StensiblyEnv,
} from "./http-auth.js";
import type { WorkLedger } from "./ledger.js";

export function registerContinuationSupervisorApi(
  app: Hono<StensiblyEnv>,
  ledger: WorkLedger,
): void {
  app.post("/supervisor/continuations/:id/queue", async (context) => {
    const supervisor = continuationSupervisorLedger(ledger);
    const continuations = continuationLedger(ledger);
    if (!supervisor || !continuations) return unavailable(context);
    const id = context.req.param("id");
    const current = await continuations.getContinuation(id);
    for (const project of await continuationAccessProjects(ledger, current)) {
      const denied = requireHttpAccess(context, "write", project);
      if (denied) return denied;
    }
    const parsed = queueContinuationForSupervisorSchema.safeParse(
      await readJson(context.req.raw),
    );
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const idempotencyKey = context.req.header("Idempotency-Key");
    return context.json({
      dispatch: await supervisor.queueContinuationForSupervisor({
        id,
        ...parsed.data,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    });
  });

  app.post("/supervisor/continuations/policy", async (context) => {
    const supervisor = continuationSupervisorLedger(ledger);
    const continuations = continuationLedger(ledger);
    if (!supervisor || !continuations) return unavailable(context);
    const parsed = runContinuationSupervisorPolicySchema.safeParse(
      await readJson(context.req.raw),
    );
    if (!parsed.success) return validationError(context, parsed.error.issues);
    const principal = currentPrincipal(context);
    if (principal?.projects !== null && !parsed.data.project) {
      return context.json({
        error: "A project is required when a token has a project allowlist",
        code: "invalid_request",
      }, 400);
    }
    const scopeDenied = requireHttpAccess(context, "write", parsed.data.project);
    if (scopeDenied) return scopeDenied;
    for (
      const project of await supervisorPolicyAccessProjects(
        ledger,
        continuations,
        parsed.data.project,
      )
    ) {
      const denied = requireHttpAccess(context, "write", project);
      if (denied) return denied;
    }
    return context.json({
      policy: await supervisor.runContinuationSupervisorPolicy(parsed.data),
    });
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validationError(
  context: Context<StensiblyEnv>,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
) {
  return context.json({
    error: "Invalid request",
    code: "invalid_request",
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  }, 400);
}

function unavailable(context: Context<StensiblyEnv>) {
  return context.json({
    error: "Continuation supervisor dispatch is unavailable on this backend",
    code: "unsupported_feature",
  }, 501);
}
