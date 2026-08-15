import { v } from "convex/values";
import {
  assertSlug,
  assertText,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { sameCanonical } from "./lib/executionEnvelope";
import { mutation, query } from "./lib/server";
import { actorValidator, serviceArgs, type ActorInput } from "./lib/validators";
import {
  admitRunnerAdapterCommandReservationRecord,
  admitRunnerAdapterCommandSettlementRecord,
  normalizeRunnerAdapterCommandLookupInput,
  normalizeRunnerAdapterCommandSettlement,
  runnerAdapterCommandOutcomeSha256,
  type RunnerAdapterCommandReservationRecord,
  type RunnerAdapterCommandSettlementRecord,
} from "../src/runner-adapter-command-contracts";

const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

export const get = query({
  args: {
    ...serviceArgs,
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeRunnerAdapterCommandLookupInput({
      idempotencyKey: args.idempotencyKey,
    });
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const row = await ctx.db
      .query("runnerAdapterCommands")
      .withIndex("by_workspace_id_and_idempotency_key", (q) =>
        q.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey)
      )
      .unique();
    if (!row) return null;
    const command = admitRunnerAdapterCommandReservationRecord({
      ...(row.request as ReservationInput),
      reservedAt: new Date(row.reservedAt).toISOString(),
    } as RunnerAdapterCommandReservationRecord);
    return {
      command,
      settlement: admittedStoredSettlement(row),
    };
  },
});

export const reserve = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    itemId: v.string(),
    runId: v.string(),
    runGeneration: v.number(),
    leaseGeneration: v.number(),
    actor: actorValidator,
    adapterId: v.string(),
    profileId: v.string(),
    requestFingerprint: v.string(),
    commandId: v.string(),
    commandFingerprint: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeInput(args);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Run ${input.runId} does not exist`);
    const stableRequest = stableRequestFor(input);

    const replay = await ctx.db
      .query("runnerAdapterCommands")
      .withIndex("by_workspace_id_and_idempotency_key", (q) =>
        q.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey)
      )
      .unique();
    if (replay) {
      if (!sameCanonical(replay.stableRequest, stableRequest)) {
        throw new Error(
          "Runner adapter command idempotency key was already used for a different command",
        );
      }
      return publicReservation(
        "replayed",
        false,
        replay.request,
        replay.reservedAt,
        admittedStoredSettlement(replay),
      );
    }

    const commandReuse = await ctx.db
      .query("runnerAdapterCommands")
      .withIndex("by_workspace_id_and_command_id", (q) =>
        q.eq("workspaceId", workspace._id).eq("commandId", input.commandId)
      )
      .unique();
    if (commandReuse) {
      throw new Error(
        "Runner adapter command ID was already reserved with a different idempotency key",
      );
    }

    const project = await findProject(ctx, workspace._id, input.project);
    if (!project) throw new Error(`Project ${input.project} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, input.itemId);
    const run = await ctx.db
      .query("queuedRuns")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", workspace._id).eq("externalId", input.runId)
      )
      .unique();
    if (!run) throw new Error(`Run ${input.runId} does not exist`);
    requireAuthority(run, project._id, item._id, input);
    const actor = await upsertActor(ctx, workspace._id, input.actor);
    if (!actor) throw new Error("Failed to bind runner adapter command actor");

    const reservedAt = Date.now();
    await ctx.db.insert("runnerAdapterCommands", {
      workspaceId: workspace._id,
      projectId: project._id,
      itemId: item._id,
      runId: run._id,
      projectExternalId: input.project,
      itemExternalId: input.itemId,
      runExternalId: input.runId,
      runGeneration: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      actorId: actor._id,
      actorExternalId: input.actor.id,
      adapterId: input.adapterId,
      profileId: input.profileId,
      requestFingerprint: input.requestFingerprint,
      commandId: input.commandId,
      commandFingerprint: input.commandFingerprint,
      request: input,
      stableRequest,
      idempotencyKey: input.idempotencyKey,
      reservedAt,
    });
    return publicReservation("reserved", true, input, reservedAt, null);
  },
});

export const settle = mutation({
  args: {
    ...serviceArgs,
    commandId: v.string(),
    commandFingerprint: v.string(),
    outcome: v.any(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const input = normalizeRunnerAdapterCommandSettlement({
      commandId: args.commandId,
      commandFingerprint: args.commandFingerprint,
      outcome: args.outcome,
    });
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) {
      throw new Error("Runner adapter command cannot settle without a durable reservation");
    }
    const row = await ctx.db
      .query("runnerAdapterCommands")
      .withIndex("by_workspace_id_and_command_id", (q) =>
        q.eq("workspaceId", workspace._id).eq("commandId", input.commandId)
      )
      .unique();
    if (!row) {
      throw new Error("Runner adapter command cannot settle without a durable reservation");
    }
    if (row.commandFingerprint !== input.commandFingerprint) {
      throw new Error("Runner adapter command settlement fingerprint changed");
    }
    const outcomeSha256 = runnerAdapterCommandOutcomeSha256(input.outcome);
    if (row.settlement !== undefined) {
      const existing = admittedStoredSettlement(row);
      if (!existing) throw new Error("Runner adapter command settlement storage is incomplete");
      if (
        row.outcomeSha256 !== outcomeSha256
        || !sameCanonical(existing.outcome, input.outcome)
        || existing.commandId !== input.commandId
        || existing.commandFingerprint !== input.commandFingerprint
      ) {
        throw new Error("Runner adapter command was already settled with another outcome");
      }
      return { outcome: "replayed", settlement: existing };
    }
    const settledAt = Date.now();
    const settlement: RunnerAdapterCommandSettlementRecord = {
      ...input,
      outcomeSha256,
      settledAt: new Date(settledAt).toISOString(),
    };
    await ctx.db.patch(row._id, { settlement, outcomeSha256, settledAt });
    return { outcome: "settled", settlement };
  },
});

type ReservationInput = {
  project: string;
  itemId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  actor: ActorInput;
  adapterId: string;
  profileId: string;
  requestFingerprint: string;
  commandId: string;
  commandFingerprint: string;
  idempotencyKey: string;
};

function normalizeInput(args: ReservationInput): ReservationInput {
  return {
    project: assertSlug(args.project, "Project"),
    itemId: assertText(args.itemId, "Runner adapter command item ID", 240),
    runId: assertText(args.runId, "Runner adapter command run ID", 240),
    runGeneration: positiveInteger(args.runGeneration, "Run generation"),
    leaseGeneration: positiveInteger(args.leaseGeneration, "Lease generation"),
    actor: {
      id: assertText(args.actor.id, "Actor id", 120),
      name: assertText(args.actor.name, "Actor name", 160),
      kind: args.actor.kind,
      ...(args.actor.capabilities ? { capabilities: [...args.actor.capabilities] } : {}),
    },
    adapterId: assertText(args.adapterId, "Runner adapter command adapter ID", 80),
    profileId: assertText(args.profileId, "Runner adapter command profile ID", 79),
    requestFingerprint: fingerprint(args.requestFingerprint, "reservation request"),
    commandId: assertText(args.commandId, "Runner adapter command ID", 160),
    commandFingerprint: fingerprint(args.commandFingerprint, "command"),
    idempotencyKey: assertText(
      args.idempotencyKey,
      "Runner adapter command idempotency key",
      240,
    ),
  };
}

function stableRequestFor(input: ReservationInput) {
  const { commandId: _commandId, commandFingerprint: _commandFingerprint, ...stable } = input;
  return stable;
}

function requireAuthority(
  run: {
    projectId: unknown;
    itemId: unknown;
    generation: number;
    leaseGeneration: number;
    leaseOwnerExternalId?: string;
    leaseExpiresAt?: number;
  },
  projectId: unknown,
  itemId: unknown,
  input: ReservationInput,
): void {
  if (run.projectId !== projectId || run.itemId !== itemId) {
    throw new Error("Runner adapter command project or item does not match the run");
  }
  if (run.generation !== input.runGeneration) {
    throw new Error(`Run generation changed from ${input.runGeneration} to ${run.generation}`);
  }
  if (run.leaseGeneration !== input.leaseGeneration) {
    throw new Error(
      `Run lease generation changed from ${input.leaseGeneration} to ${run.leaseGeneration}`,
    );
  }
  if (run.leaseOwnerExternalId !== input.actor.id) {
    throw new Error("Only the current run lease owner can reserve adapter dispatch");
  }
  if (run.leaseExpiresAt === undefined || run.leaseExpiresAt <= Date.now()) {
    throw new Error("Run lease has expired");
  }
}

function publicReservation(
  outcome: "reserved" | "replayed",
  dispatchAuthorized: boolean,
  request: unknown,
  reservedAt: number,
  settlement: unknown,
) {
  return {
    outcome,
    dispatchAuthorized,
    command: {
      ...(request as ReservationInput),
      reservedAt: new Date(reservedAt).toISOString(),
    },
    settlement,
  };
}

function admittedStoredSettlement(row: {
  settlement?: unknown;
  outcomeSha256?: string;
  settledAt?: number;
}): RunnerAdapterCommandSettlementRecord | null {
  const absent = row.settlement === undefined
    && row.outcomeSha256 === undefined
    && row.settledAt === undefined;
  if (absent) return null;
  if (
    row.settlement === undefined
    || row.outcomeSha256 === undefined
    || row.settledAt === undefined
  ) {
    throw new Error("Runner adapter command settlement storage is incomplete");
  }
  const settlement = admitRunnerAdapterCommandSettlementRecord(
    row.settlement as RunnerAdapterCommandSettlementRecord,
  );
  if (
    settlement.outcomeSha256 !== row.outcomeSha256
    || Date.parse(settlement.settledAt) !== row.settledAt
  ) {
    throw new Error("Runner adapter command settlement storage is invalid");
  }
  return settlement;
}

function fingerprint(value: string, label: string): string {
  const normalized = assertText(value, `Runner adapter command ${label} fingerprint`, 71);
  if (!fingerprintPattern.test(normalized)) {
    throw new Error(`Runner adapter command ${label} fingerprint is invalid`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
