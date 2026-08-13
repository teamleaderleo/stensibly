import { v } from "convex/values";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { sameCanonical } from "./lib/executionEnvelope";
import { mutation } from "./lib/server";
import { actorValidator, serviceArgs } from "./lib/validators";
import {
  normalizeRunnerAdapterCommandReservation,
  type ReserveRunnerAdapterCommandInput,
} from "../src/runner-adapter-command-contracts";
import {
  admitRunnerAdapterCommandRecoveryClaimRecord,
  normalizeRunnerAdapterCommandRecoveryInput,
  runnerAdapterCommandCheckpointLineage,
} from "../src/runner-adapter-command-recovery";

export const claim = mutation({
  args: {
    ...serviceArgs,
    commandId: v.string(),
    commandFingerprint: v.string(),
    actor: actorValidator,
    leaseSeconds: v.number(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeRunnerAdapterCommandRecoveryInput({
      commandId: args.commandId,
      commandFingerprint: args.commandFingerprint,
      actor: args.actor,
      leaseSeconds: args.leaseSeconds,
      idempotencyKey: args.idempotencyKey,
    });
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) {
      throw new Error("Runner adapter command recovery requires a durable command reservation");
    }

    const replay = await ctx.db
      .query("runnerAdapterCommandRecoveries")
      .withIndex("by_workspace_id_and_idempotency_key", (q) =>
        q.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey)
      )
      .unique();
    if (replay) {
      if (!sameCanonical(replay.request, input)) {
        throw new Error(
          "Runner adapter command recovery idempotency key was already used for another request",
        );
      }
      return {
        outcome: "replayed",
        claim: admitRunnerAdapterCommandRecoveryClaimRecord(replay.claim),
      };
    }

    const command = await ctx.db
      .query("runnerAdapterCommands")
      .withIndex("by_workspace_id_and_command_id", (q) =>
        q.eq("workspaceId", workspace._id).eq("commandId", input.commandId)
      )
      .unique();
    if (!command) {
      throw new Error("Runner adapter command recovery requires a durable command reservation");
    }
    if (command.settlement !== undefined) {
      throw new Error("Settled runner adapter commands cannot enter recovery ownership");
    }

    const reservation = normalizeRunnerAdapterCommandReservation(
      command.request as ReserveRunnerAdapterCommandInput,
    );
    if (reservation.commandFingerprint !== input.commandFingerprint) {
      throw new Error("Runner adapter command recovery fingerprint changed");
    }

    const run = await ctx.db.get("queuedRuns", command.runId);
    if (!run) throw new Error("Runner adapter command recovery run no longer exists");
    const now = Date.now();
    const currentLeaseLive = run.leaseExpiresAt !== undefined && run.leaseExpiresAt > now;
    const originalAuthorityStillLive = currentLeaseLive
      && run.generation === reservation.runGeneration
      && run.leaseGeneration === reservation.leaseGeneration
      && run.leaseOwnerExternalId === reservation.actor.id;
    if (originalAuthorityStillLive) {
      throw new Error("Runner adapter command recovery cannot replace live original authority");
    }
    if (currentLeaseLive && run.leaseOwnerExternalId !== input.actor.id) {
      throw new Error("A live successor run lease belongs to another recovery actor");
    }

    const latest = await ctx.db
      .query("runnerAdapterCommandRecoveries")
      .withIndex("by_command_id_and_recovery_generation", (q) =>
        q.eq("commandId", command._id)
      )
      .order("desc")
      .first();
    if (latest && latest.expiresAt > now) {
      throw new Error("Runner adapter command already has an active recovery owner");
    }

    const actor = await upsertActor(ctx, workspace._id, input.actor);
    if (!actor) throw new Error("Failed to bind runner adapter command recovery actor");
    const recoveryGeneration = (latest?.recoveryGeneration ?? 0) + 1;
    const claimedAt = new Date(now).toISOString();
    const expiresAtMs = now + input.leaseSeconds * 1_000;
    const claimRecord = admitRunnerAdapterCommandRecoveryClaimRecord({
      version: 1,
      commandId: reservation.commandId,
      commandFingerprint: reservation.commandFingerprint,
      runId: reservation.runId,
      runGeneration: reservation.runGeneration,
      leaseGeneration: reservation.leaseGeneration,
      recoveryGeneration,
      actor: input.actor,
      checkpoint: runnerAdapterCommandCheckpointLineage(run.checkpoint ?? null, reservation),
      claimedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      authorizesRedispatch: false,
      authorizesResume: false,
    });

    await ctx.db.insert("runnerAdapterCommandRecoveries", {
      workspaceId: workspace._id,
      commandId: command._id,
      commandExternalId: reservation.commandId,
      recoveryGeneration,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      idempotencyKey: input.idempotencyKey,
      request: input,
      claim: claimRecord,
      claimedAt: now,
      expiresAt: expiresAtMs,
    });
    return { outcome: "claimed", claim: claimRecord };
  },
});
