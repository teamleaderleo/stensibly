import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  currentWorkFingerprint,
  verifyWorkSelectionRecommendation,
  type AcceptSelectedWorkRejection,
  type AcceptSelectedWorkResult,
  type WorkResponsibilityRole,
  type WorkSelectionRecommendation,
} from "../src/work-selection-claim";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import {
  appendEvent,
  assertLeaseSeconds,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { expireClaimIfNeeded } from "./lib/claimState";
import { mutation } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const expireScheduledRef = makeFunctionReference<"mutation">("claims:expireScheduled");
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#-]*$/;

const recommendationValidator = v.object({
  version: v.literal(1),
  selectedHandle: v.string(),
  project: v.string(),
  itemId: v.string(),
  itemVersion: v.number(),
  claimGeneration: v.number(),
  priority: v.number(),
  nextAction: v.union(v.string(), v.null()),
  sourceFingerprint: v.string(),
  workFingerprint: v.string(),
  responsibilityRole: v.union(
    v.literal("general"),
    v.literal("implementation"),
    v.literal("independent_review"),
  ),
  independenceKey: v.union(v.string(), v.null()),
  recommendationFingerprint: v.string(),
  grantsResponsibility: v.literal(false),
  grantsAuthority: v.literal(false),
});

export const accept = mutation({
  args: {
    ...serviceArgs,
    actorId: v.string(),
    clientId: v.string(),
    workerRef: v.string(),
    recommendation: recommendationValidator,
    leaseSeconds: v.number(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("Workspace does not exist");
    const actorId = boundedIdentifier(args.actorId, "actorId", 240);
    const clientId = boundedIdentifier(args.clientId, "clientId", 280);
    const workerRef = boundedIdentifier(args.workerRef, "workerRef", 240);
    const idempotencyKey = boundedIdentifier(args.idempotencyKey, "idempotencyKey", 240);
    const recommendation = verifyRecommendation(args.recommendation);
    const leaseSeconds = assertLeaseSeconds(args.leaseSeconds);
    const request = {
      workerRef,
      recommendation,
      leaseSeconds,
    };
    const requestFingerprint = fingerprintCanonicalRequest(request);

    const existingCommand = await ctx.db
      .query("workSelectionCommands")
      .withIndex("by_workspace_owner_idempotency", (q) =>
        q
          .eq("workspaceId", workspace._id)
          .eq("actorId", actorId)
          .eq("clientId", clientId)
          .eq("idempotencyKey", idempotencyKey)
      )
      .unique();
    if (existingCommand) {
      if (existingCommand.requestFingerprint !== requestFingerprint) {
        throw new Error("Idempotency key was already used for a different selected-work acceptance");
      }
      return existingCommand.result;
    }

    const now = Date.now();
    const worker = await ctx.db
      .query("workerEnrolments")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", workspace._id).eq("externalId", workerRef)
      )
      .unique();
    if (
      !worker
      || worker.actorId !== actorId
      || worker.clientId !== clientId
      || worker.status !== "active"
      || worker.expiresAt <= now
    ) {
      return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
        requestFingerprint, request, rejected("worker_not_active"));
    }
    if (!worker.projectScope.includes(recommendation.project)) {
      return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
        requestFingerprint, request, rejected("project_out_of_scope"));
    }

    const project = await findProject(ctx, workspace._id, recommendation.project);
    if (!project) {
      return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
        requestFingerprint, request, rejected("project_out_of_scope"));
    }

    let item = await getItemByExternalId(ctx, workspace._id, recommendation.itemId);
    item = await expireClaimIfNeeded(ctx, item, now);
    if (item.projectId !== project._id || item.status !== "ready") {
      return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
        requestFingerprint, request, rejected("work_unavailable"));
    }

    const currentFingerprint = currentWorkFingerprint({
      project: recommendation.project,
      itemId: recommendation.itemId,
      itemVersion: item.version,
      claimGeneration: item.claimGeneration,
      status: item.status,
      priority: item.priority,
      nextAction: item.nextAction ?? null,
      sourceFingerprint: recommendation.sourceFingerprint,
    });
    if (
      item.version !== recommendation.itemVersion
      || item.claimGeneration !== recommendation.claimGeneration
      || currentFingerprint !== recommendation.workFingerprint
    ) {
      return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
        requestFingerprint, request, rejected("work_changed"));
    }

    const existingActor = await ctx.db
      .query("actors")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", workspace._id).eq("externalId", actorId)
      )
      .unique();
    if (existingActor) {
      const activeItems = await ctx.db
        .query("items")
        .withIndex("by_actor_status", (q) =>
          q.eq("claimedByActorId", existingActor._id).eq("status", "active")
        )
        .take(2);
      if (activeItems.some((candidate) =>
        candidate.claimExpiresAt !== undefined && candidate.claimExpiresAt > now
      )) {
        return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
          requestFingerprint, request, rejected("capacity_full"));
      }
    }

    const independenceRejection = await checkIndependence(
      ctx,
      workspace._id,
      workerRef,
      recommendation.responsibilityRole,
      recommendation.independenceKey,
      now,
    );
    if (independenceRejection) {
      return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
        requestFingerprint, request, rejected(independenceRejection));
    }

    const actor = await upsertActor(ctx, workspace._id, {
      id: actorId,
      name: worker.callsign ?? workerRef,
      kind: "agent",
    });
    if (!actor) throw new Error("Failed to create worker actor");

    const expiresAt = now + leaseSeconds * 1_000;
    const acceptedClaimGeneration = item.claimGeneration + 1;
    await ctx.db.patch(item._id, {
      status: "active",
      claimedByActorId: actor._id,
      claimedByExternalId: actor.externalId,
      claimExpiresAt: expiresAt,
      claimGeneration: acceptedClaimGeneration,
      version: item.version + 1,
      updatedAt: now,
    });

    const acceptanceId = await ctx.db.insert("workSelectionAcceptances", {
      workspaceId: workspace._id,
      projectId: project._id,
      itemId: item._id,
      workerEnrolmentId: worker._id,
      externalId: "pending",
      workerRef,
      actorId,
      clientId,
      recommendationFingerprint: recommendation.recommendationFingerprint,
      selectedItemVersion: recommendation.itemVersion,
      selectedClaimGeneration: recommendation.claimGeneration,
      responsibilityRole: recommendation.responsibilityRole,
      ...(recommendation.independenceKey === null
        ? {}
        : { independenceKey: recommendation.independenceKey }),
      acceptedClaimGeneration,
      claimExpiresAt: expiresAt,
      acceptedAt: now,
      grantsResponsibility: true,
      grantsAuthority: false,
    });
    const receiptId = `resp_${acceptanceId}`;
    await ctx.db.patch(acceptanceId, { externalId: receiptId });

    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "responsibility.accepted",
      payload: {
        receiptId,
        workerRef,
        recommendationFingerprint: recommendation.recommendationFingerprint,
        responsibilityRole: recommendation.responsibilityRole,
        independenceKey: recommendation.independenceKey,
        selectedItemVersion: recommendation.itemVersion,
        selectedClaimGeneration: recommendation.claimGeneration,
        grantsAuthority: false,
      },
      idempotencyKey: `responsibility:${idempotencyKey}`,
      createdAt: now,
    });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "claim.created",
      payload: {
        leaseSeconds,
        expiresAt: new Date(expiresAt).toISOString(),
        generation: acceptedClaimGeneration,
        acceptanceReceiptId: receiptId,
      },
      idempotencyKey: `claim:${idempotencyKey}`,
      createdAt: now,
    });
    await ctx.scheduler.runAt(expiresAt, expireScheduledRef, {
      itemId: item._id,
      generation: acceptedClaimGeneration,
    });

    const result: AcceptSelectedWorkResult = {
      version: 1,
      outcome: "accepted",
      reason: null,
      responsibility: {
        receiptId,
        workerRef,
        project: recommendation.project,
        itemId: recommendation.itemId,
        recommendationFingerprint: recommendation.recommendationFingerprint,
        responsibilityRole: recommendation.responsibilityRole,
        independenceKey: recommendation.independenceKey,
        acceptedAt: new Date(now).toISOString(),
        grantsResponsibility: true,
        grantsAuthority: false,
      },
      claim: {
        itemId: recommendation.itemId,
        claimGeneration: acceptedClaimGeneration,
        expiresAt: new Date(expiresAt).toISOString(),
        authoritySource: "item_claim",
      },
      requiresRefresh: false,
      grantsAuthorityFromRecommendation: false,
    };
    return await rememberResult(ctx, workspace._id, actorId, clientId, idempotencyKey,
      requestFingerprint, request, result);
  },
});

async function checkIndependence(
  ctx: any,
  workspaceId: any,
  workerRef: string,
  role: WorkResponsibilityRole,
  independenceKey: string | null,
  now: number,
): Promise<"review_independence" | "phase_overlap" | null> {
  if (independenceKey === null || role === "general") return null;
  const roles: WorkResponsibilityRole[] = role === "implementation"
    ? ["independent_review"]
    : ["implementation"];

  if (role === "independent_review") {
    const priorImplementation = await ctx.db
      .query("workSelectionAcceptances")
      .withIndex("by_workspace_independence_role", (q: any) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("independenceKey", independenceKey)
          .eq("responsibilityRole", "implementation")
      )
      .filter((q: any) => q.eq(q.field("workerRef"), workerRef))
      .first();
    if (priorImplementation) return "review_independence";
  }

  for (const oppositeRole of roles) {
    const candidates = await ctx.db
      .query("workSelectionAcceptances")
      .withIndex("by_workspace_independence_role", (q: any) =>
        q
          .eq("workspaceId", workspaceId)
          .eq("independenceKey", independenceKey)
          .eq("responsibilityRole", oppositeRole)
      )
      .take(20);
    for (const acceptance of candidates) {
      const candidateItem = await ctx.db.get("items", acceptance.itemId);
      if (
        candidateItem
        && candidateItem.status === "active"
        && candidateItem.claimGeneration === acceptance.acceptedClaimGeneration
        && candidateItem.claimExpiresAt !== undefined
        && candidateItem.claimExpiresAt > now
      ) return "phase_overlap";
    }
  }
  return null;
}

function verifyRecommendation(value: WorkSelectionRecommendation): WorkSelectionRecommendation {
  if (!fingerprintPattern.test(value.sourceFingerprint)
    || !fingerprintPattern.test(value.workFingerprint)
    || !fingerprintPattern.test(value.recommendationFingerprint)) {
    throw new TypeError("Recommendation contains an invalid fingerprint");
  }
  return verifyWorkSelectionRecommendation(value);
}

async function rememberResult(
  ctx: any,
  workspaceId: any,
  actorId: string,
  clientId: string,
  idempotencyKey: string,
  requestFingerprint: string,
  request: unknown,
  result: AcceptSelectedWorkResult,
): Promise<AcceptSelectedWorkResult> {
  await ctx.db.insert("workSelectionCommands", {
    workspaceId,
    actorId,
    clientId,
    idempotencyKey,
    requestFingerprint,
    request,
    result,
    createdAt: Date.now(),
  });
  return result;
}

function rejected(reason: AcceptSelectedWorkRejection): AcceptSelectedWorkResult {
  return {
    version: 1,
    outcome: "rejected",
    reason,
    responsibility: null,
    claim: null,
    requiresRefresh: true,
    grantsAuthorityFromRecommendation: false,
  };
}

function boundedIdentifier(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > max || !identifierPattern.test(normalized)) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}
