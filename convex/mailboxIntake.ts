import { v } from "convex/values";
import {
  admitMailboxObservationJson,
  admitMailboxSubscriptionStateJson,
} from "../src/mailbox-intake-admission";
import { fingerprintCanonicalRequest } from "../src/idempotency-request-fingerprint";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumObservationBatch = 256;
const maximumRecentObservations = 100;
const reconciliationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export const initialize = mutation({
  args: {
    ...serviceArgs,
    stateJson: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("MAILBOX_INTAKE_WORKSPACE_NOT_FOUND");
    const state = admitMailboxSubscriptionStateJson(args.stateJson);
    const existing = await ctx.db
      .query("mailboxIntakeBindings")
      .withIndex("by_workspace_id_and_mailbox_binding_id", (q) =>
        q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", state.mailboxBindingId),
      )
      .unique();
    if (existing) {
      if (existing.stateJson !== args.stateJson) {
        throw new Error("MAILBOX_INTAKE_BINDING_CONFLICT");
      }
      return { duplicate: true, revision: existing.revision };
    }

    const now = Date.now();
    await ctx.db.insert("mailboxIntakeBindings", {
      workspaceId: workspace._id,
      mailboxBindingId: state.mailboxBindingId,
      provider: state.provider,
      cursorValue: state.cursor.value,
      coverage: state.coverage,
      ...(state.lastNotificationId === null
        ? {}
        : { lastNotificationId: state.lastNotificationId }),
      stateJson: args.stateJson,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { duplicate: false, revision: 1 };
  },
});

export const commitReconciliation = mutation({
  args: {
    ...serviceArgs,
    mailboxBindingId: v.string(),
    reconciliationId: v.string(),
    expectedRevision: v.number(),
    expectedCursor: v.string(),
    nextStateJson: v.string(),
    observationsJson: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("MAILBOX_INTAKE_WORKSPACE_NOT_FOUND");
    const reconciliationId = exactReconciliationId(args.reconciliationId);
    if (
      !Number.isSafeInteger(args.expectedRevision)
      || args.expectedRevision < 1
    ) {
      throw new RangeError("Mailbox intake expected revision is invalid");
    }
    if (args.observationsJson.length > maximumObservationBatch) {
      throw new RangeError("Mailbox intake observation batch is too large");
    }

    const nextState = admitMailboxSubscriptionStateJson(args.nextStateJson);
    if (nextState.mailboxBindingId !== args.mailboxBindingId) {
      throw new Error("MAILBOX_INTAKE_BINDING_CONFLICT");
    }
    const observations = args.observationsJson.map(admitMailboxObservationJson);
    for (const observation of observations) {
      if (
        observation.mailboxBindingId !== args.mailboxBindingId
        || observation.provider !== nextState.provider
      ) {
        throw new Error("MAILBOX_INTAKE_OBSERVATION_BINDING_CONFLICT");
      }
    }

    const requestFingerprint = fingerprintCanonicalRequest({
      version: 1,
      mailboxBindingId: args.mailboxBindingId,
      reconciliationId,
      expectedRevision: args.expectedRevision,
      expectedCursor: args.expectedCursor,
      nextStateJson: args.nextStateJson,
      observationsJson: args.observationsJson,
    });
    const existingReconciliation = await ctx.db
      .query("mailboxIntakeReconciliations")
      .withIndex(
        "by_workspace_id_and_mailbox_binding_id_and_reconciliation_id",
        (q) => q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", args.mailboxBindingId)
          .eq("reconciliationId", reconciliationId),
      )
      .unique();
    if (existingReconciliation) {
      if (existingReconciliation.requestFingerprint !== requestFingerprint) {
        throw new Error("MAILBOX_INTAKE_RECONCILIATION_CONFLICT");
      }
      return {
        duplicate: true,
        revision: existingReconciliation.nextRevision,
        insertedObservations: existingReconciliation.insertedObservations,
      };
    }

    const binding = await ctx.db
      .query("mailboxIntakeBindings")
      .withIndex("by_workspace_id_and_mailbox_binding_id", (q) =>
        q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", args.mailboxBindingId),
      )
      .unique();
    if (!binding) throw new Error("MAILBOX_INTAKE_BINDING_NOT_FOUND");
    const currentState = admitMailboxSubscriptionStateJson(binding.stateJson);
    if (binding.revision !== args.expectedRevision) {
      throw new Error("MAILBOX_INTAKE_REVISION_CONFLICT");
    }
    if (
      binding.cursorValue !== args.expectedCursor
      || currentState.cursor.value !== args.expectedCursor
    ) {
      throw new Error("MAILBOX_INTAKE_CURSOR_CONFLICT");
    }
    assertStateContinuation(currentState, nextState);
    assertObservationCursors(currentState.cursor.value, nextState.cursor.value, observations);

    const uniqueObservations = new Map<string, { json: string; index: number }>();
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index]!;
      const json = args.observationsJson[index]!;
      const prior = uniqueObservations.get(observation.observationId);
      if (prior && prior.json !== json) {
        throw new Error("MAILBOX_INTAKE_OBSERVATION_CONFLICT");
      }
      uniqueObservations.set(observation.observationId, { json, index });
    }

    let insertedObservations = 0;
    const now = Date.now();
    for (const [observationId, admitted] of uniqueObservations) {
      const observation = observations[admitted.index]!;
      const existing = await ctx.db
        .query("mailboxIntakeObservations")
        .withIndex("by_workspace_id_and_observation_id", (q) =>
          q.eq("workspaceId", workspace._id).eq("observationId", observationId),
        )
        .unique();
      if (existing) {
        if (existing.observationJson !== admitted.json) {
          throw new Error("MAILBOX_INTAKE_OBSERVATION_CONFLICT");
        }
        continue;
      }
      await ctx.db.insert("mailboxIntakeObservations", {
        workspaceId: workspace._id,
        mailboxBindingId: observation.mailboxBindingId,
        observationId,
        semanticFingerprint: observation.semanticFingerprint,
        provider: observation.provider,
        eventType: observation.eventType,
        providerCursor: observation.providerCursor,
        observedAt: Date.parse(observation.observedAt),
        receivedAt: Date.parse(observation.receivedAt),
        observationJson: admitted.json,
        createdAt: now,
      });
      insertedObservations += 1;
    }

    const nextRevision = binding.revision + 1;
    await ctx.db.patch(binding._id, {
      provider: nextState.provider,
      cursorValue: nextState.cursor.value,
      coverage: nextState.coverage,
      lastNotificationId: nextState.lastNotificationId ?? undefined,
      stateJson: args.nextStateJson,
      revision: nextRevision,
      updatedAt: now,
    });
    await ctx.db.insert("mailboxIntakeReconciliations", {
      workspaceId: workspace._id,
      mailboxBindingId: args.mailboxBindingId,
      reconciliationId,
      requestFingerprint,
      previousRevision: binding.revision,
      nextRevision,
      insertedObservations,
      createdAt: now,
    });

    return { duplicate: false, revision: nextRevision, insertedObservations };
  },
});

export const getBinding = query({
  args: {
    ...serviceArgs,
    mailboxBindingId: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const row = await ctx.db
      .query("mailboxIntakeBindings")
      .withIndex("by_workspace_id_and_mailbox_binding_id", (q) =>
        q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", args.mailboxBindingId),
      )
      .unique();
    if (!row) return null;
    const state = admitMailboxSubscriptionStateJson(row.stateJson);
    return {
      mailboxBindingId: row.mailboxBindingId,
      provider: row.provider,
      cursorValue: row.cursorValue,
      coverage: row.coverage,
      lastNotificationId: row.lastNotificationId ?? null,
      lastSuccessfulReconciliationAt: state.lastSuccessfulReconciliationAt,
      subscription: state.subscription,
      scope: state.scope,
      revision: row.revision,
      updatedAt: row.updatedAt,
    };
  },
});

export const listRecentObservations = query({
  args: {
    ...serviceArgs,
    mailboxBindingId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > maximumRecentObservations) {
      throw new RangeError("Mailbox intake observation limit is invalid");
    }
    const rows = await ctx.db
      .query("mailboxIntakeObservations")
      .withIndex(
        "by_workspace_id_and_mailbox_binding_id_and_received_at",
        (q) => q.eq("workspaceId", workspace._id)
          .eq("mailboxBindingId", args.mailboxBindingId),
      )
      .order("desc")
      .take(args.limit);
    return rows.map((row) => {
      const observation = admitMailboxObservationJson(row.observationJson);
      return {
        observationId: observation.observationId,
        semanticFingerprint: observation.semanticFingerprint,
        provider: observation.provider,
        eventType: observation.eventType,
        providerCursor: observation.providerCursor,
        providerMessageId: observation.providerMessageId,
        providerThreadId: observation.providerThreadId,
        providerLabelId: observation.providerLabelId,
        observedAt: observation.observedAt,
        receivedAt: observation.receivedAt,
        wakeEligible: observation.wakeEligible,
        loopDisposition: observation.loopDisposition,
        containsRawContent: false as const,
        grantsAuthority: false as const,
      };
    });
  },
});

function assertStateContinuation(
  current: ReturnType<typeof admitMailboxSubscriptionStateJson>,
  next: ReturnType<typeof admitMailboxSubscriptionStateJson>,
): void {
  if (
    current.mailboxBindingId !== next.mailboxBindingId
    || current.provider !== next.provider
    || current.scope.kind !== next.scope.kind
    || current.scope.externalId !== next.scope.externalId
    || current.cursor.kind !== next.cursor.kind
  ) {
    throw new Error("MAILBOX_INTAKE_BINDING_CONFLICT");
  }
  if (
    current.provider === "gmail"
    && BigInt(next.cursor.value) < BigInt(current.cursor.value)
  ) {
    throw new Error("MAILBOX_INTAKE_CURSOR_REGRESSION");
  }
}

function assertObservationCursors(
  previousCursor: string,
  nextCursor: string,
  observations: ReturnType<typeof admitMailboxObservationJson>[],
): void {
  for (const observation of observations) {
    if (observation.provider !== "gmail") continue;
    const cursor = BigInt(observation.providerCursor);
    if (cursor < BigInt(previousCursor) || cursor > BigInt(nextCursor)) {
      throw new Error("MAILBOX_INTAKE_OBSERVATION_CURSOR_CONFLICT");
    }
  }
}

function exactReconciliationId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
    || !reconciliationIdPattern.test(value)
  ) {
    throw new RangeError("Mailbox reconciliation ID is invalid");
  }
  return value;
}
