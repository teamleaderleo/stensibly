import { v } from "convex/values";
import { sha256, stableJson } from "../src/canonical-json";
import {
  parseCoordinationEventSubscriptionV1,
} from "../src/coordination-wake-intent";
import {
  admitAnyGitHubRepositoryObservationEnvelope,
} from "../src/github-repository-observation-any-admission";
import { compileGitHubCoordinationWakeV1 } from "../src/github-coordination-wake";
import { normalizeGitHubRepository } from "../src/github-provider-validation";
import { parseProjectAttachmentSnapshot } from "../src/project-contract";
import { runnerProfileProvenanceV1 } from "../src/runner-profile-provenance";
import {
  assertLeaseSeconds,
  assertSlug,
  assertText,
  findIdempotentEvent,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireSameIdempotentItem,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { dispatchHostedExactGeneration } from "./lib/exactDispatch";
import {
  executionEnvelopeValidator,
  normalizeExecutionEnvelope,
} from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";

const routingLevel = v.union(
  v.literal("record"),
  v.literal("attention"),
  v.literal("interrupt"),
);

/**
 * Compile one exact, already-admitted GitHub observation into an existing
 * generation-fenced hosted dispatch. The explicit subscription is caller-owned
 * current input; this mutation creates no subscription, wake, queue, or receipt
 * ledger of its own. Exact replay is the existing run.queued event.
 */
export const dispatch = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    observationId: v.string(),
    subscriptionJson: v.string(),
    routingLevel,
    actor: actorValidator,
    runnerType: v.string(),
    runnerProfile: v.string(),
    runnerProfileVersion: v.union(v.string(), v.null()),
    executionEnvelope: executionEnvelopeValidator,
    leaseSeconds: v.number(),
    maxAttempts: v.number(),
    retryBackoffSeconds: v.number(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("GITHUB_COORDINATION_WAKE_WORKSPACE_NOT_FOUND");
    const projectSlug = assertSlug(args.project, "Project");
    const project = await findProject(ctx, workspace._id, projectSlug);
    if (!project) throw new Error("GITHUB_COORDINATION_WAKE_PROJECT_NOT_FOUND");

    const observationId = assertText(
      args.observationId,
      "GitHub observation ID",
      256,
    );
    const row = await ctx.db
      .query("githubRepositoryObservations")
      .withIndex("by_workspace_observation", (q) =>
        q.eq("workspaceId", workspace._id).eq("observationId", observationId)
      )
      .unique();
    if (!row) throw new Error("GITHUB_COORDINATION_WAKE_OBSERVATION_NOT_FOUND");
    const admitted = admitAnyGitHubRepositoryObservationEnvelope({
      deliveryId: row.deliveryId,
      eventType: row.eventType,
      payloadDigest: row.payloadDigest,
      receivedAt: row.receivedAt,
      observationJson: row.observationJson,
    });
    if (admitted.observation.sourceSchema !== "github-webhook") {
      throw new Error("GITHUB_COORDINATION_WAKE_REQUIRES_ADMITTED_WEBHOOK");
    }

    const subscription = parseCoordinationEventSubscriptionV1(
      parseJson(args.subscriptionJson, "coordination subscription"),
    );
    const compilation = compileGitHubCoordinationWakeV1({
      project: projectSlug,
      observation: admitted.observation,
      subscription,
      routingLevel: args.routingLevel,
    });
    if (!compilation.decision.matched || !compilation.decision.wakeIntent) {
      return Object.freeze({
        status: "not_matched" as const,
        reason: compilation.decision.reason,
        decisionFingerprint: compilation.decision.decisionFingerprint,
      });
    }
    const wake = compilation.decision.wakeIntent;

    const attachment = await ctx.db
      .query("projectAttachments")
      .withIndex("by_project_created", (q) => q.eq("projectId", project._id))
      .order("desc")
      .first();
    if (!attachment || attachment.workspaceId !== workspace._id) {
      throw new Error("GITHUB_COORDINATION_WAKE_ATTACHMENT_NOT_FOUND");
    }
    const snapshot = parseProjectAttachmentSnapshot(
      parseJson(attachment.snapshotJson, "project attachment snapshot"),
    );
    const repository = normalizeGitHubRepository(admitted.observation.repository);
    if (
      snapshot.contract.project !== projectSlug
      || snapshot.snapshotSha256 !== attachment.snapshotSha256
      || snapshot.source.contentSha256 !== attachment.contentSha256
      || snapshot.source.path !== attachment.sourcePath
      || !snapshot.contract.repositories.some((candidate) =>
        canonicalGitHubRepository(candidate) === repository
      )
    ) {
      throw new Error("GITHUB_COORDINATION_WAKE_REPOSITORY_NOT_ATTACHED");
    }

    const item = await getItemByExternalId(ctx, workspace._id, wake.targetItemId);
    if (item.projectId !== project._id) {
      throw new Error("GITHUB_COORDINATION_WAKE_ITEM_PROJECT_MISMATCH");
    }
    const profile = runnerProfileProvenanceV1(
      args.runnerProfile,
      args.runnerProfileVersion,
    );
    const executionEnvelope = normalizeExecutionEnvelope(
      args.executionEnvelope,
      `GitHub wake ${wake.sourceEventId}`,
    );
    const request = Object.freeze({
      version: 1 as const,
      observationId: admitted.observationId,
      observationFingerprint: admitted.semanticFingerprint,
      wakeFingerprint: wake.fingerprint,
      project: projectSlug,
      itemId: wake.targetItemId,
      expectedClaimGeneration: wake.targetGeneration,
      actor: args.actor,
      runnerType: assertText(args.runnerType, "Runner type", 80),
      runnerProfile: profile.profileId,
      runnerProfileVersion: profile.profileVersion,
      executionEnvelope,
      leaseSeconds: assertLeaseSeconds(args.leaseSeconds),
      maxAttempts: boundedInteger(args.maxAttempts, "Maximum attempts", 1, 20),
      retryBackoffSeconds: boundedInteger(
        args.retryBackoffSeconds,
        "Retry backoff seconds",
        0,
        86_400,
      ),
    });
    const requestFingerprint = sha256(stableJson(request));

    const replay = await findIdempotentEvent(
      ctx,
      workspace._id,
      wake.idempotencyKey,
    );
    if (replay) {
      if (replay.type !== "run.queued") {
        throw new Error("GITHUB_COORDINATION_WAKE_IDEMPOTENCY_CONFLICT");
      }
      await requireSameIdempotentItem(ctx, replay, {
        projectSlug,
        itemExternalId: wake.targetItemId,
        actorExternalId: args.actor.id,
        payloadSubset: { requestFingerprint },
      });
      const payload = record(replay.payload, "GitHub coordination wake replay");
      if (typeof payload.runId !== "string") {
        throw new Error("GitHub coordination wake replay run ID is invalid");
      }
      const runId = assertText(payload.runId, "Replay run ID", 240);
      const claimedGeneration = nonNegativeInteger(
        payload.claimedGeneration,
        "Replay claimed generation",
      );
      const run = await ctx.db
        .query("queuedRuns")
        .withIndex("by_workspace_external", (q) =>
          q.eq("workspaceId", workspace._id).eq("externalId", runId)
        )
        .unique();
      if (
        claimedGeneration !== wake.targetGeneration + 1
        || !run
        || run.itemId !== item._id
        || run.runnerType !== request.runnerType
        || run.runnerProfile !== request.runnerProfile
        || (run.runnerProfileVersion ?? null) !== request.runnerProfileVersion
      ) {
        throw new Error("GITHUB_COORDINATION_WAKE_REPLAY_CHANGED");
      }
      return dispatchReceipt({
        replay: true,
        runId,
        expectedClaimGeneration: wake.targetGeneration,
        claimedGeneration,
        compilation,
      });
    }

    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("GITHUB_COORDINATION_WAKE_ACTOR_UNAVAILABLE");
    const outcome = await dispatchHostedExactGeneration(ctx, {
      workspaceId: workspace._id,
      itemId: item._id,
      actor,
      expectedClaimGeneration: wake.targetGeneration,
      runnerType: request.runnerType,
      runnerProfile: request.runnerProfile,
      runnerProfileVersion: request.runnerProfileVersion,
      leaseSeconds: request.leaseSeconds,
      maxAttempts: request.maxAttempts,
      retryBackoffSeconds: request.retryBackoffSeconds,
      executionEnvelope,
      eventSource: "github_coordination_wake",
      idempotencyKey: wake.idempotencyKey,
      requestFingerprint,
      now: Date.now(),
    });
    if (outcome.status !== "dispatched") {
      return Object.freeze({
        status: outcome.status,
        expectedClaimGeneration: outcome.expectedClaimGeneration,
        ...(outcome.status === "stale_generation"
          ? { currentClaimGeneration: outcome.currentClaimGeneration }
          : {}),
        sourceObservationId: admitted.observationId,
        wakeFingerprint: wake.fingerprint,
      });
    }
    return dispatchReceipt({
      replay: false,
      runId: outcome.run.externalId,
      expectedClaimGeneration: outcome.expectedClaimGeneration,
      claimedGeneration: outcome.claimedGeneration,
      compilation,
    });
  },
});

function dispatchReceipt(input: {
  replay: boolean;
  runId: string;
  expectedClaimGeneration: number;
  claimedGeneration: number;
  compilation: ReturnType<typeof compileGitHubCoordinationWakeV1>;
}) {
  const wake = input.compilation.decision.wakeIntent;
  if (!wake) throw new Error("GITHUB_COORDINATION_WAKE_RECEIPT_WITHOUT_WAKE");
  return Object.freeze({
    status: "dispatched" as const,
    replay: input.replay,
    sourceObservationId: wake.sourceEventId,
    sourceIdentity: input.compilation.sourceIdentity,
    decisionFingerprint: input.compilation.decision.decisionFingerprint,
    wakeFingerprint: wake.fingerprint,
    idempotencyKey: wake.idempotencyKey,
    expectedClaimGeneration: input.expectedClaimGeneration,
    claimedGeneration: input.claimedGeneration,
    runId: input.runId,
  });
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${label} JSON`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return value;
}

function canonicalGitHubRepository(value: string): string | null {
  try {
    return normalizeGitHubRepository(value);
  } catch {
    return null;
  }
}
