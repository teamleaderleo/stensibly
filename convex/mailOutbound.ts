import { v } from "convex/values";
import { sha256, stableJson } from "../src/canonical-json";
import {
  exactMailThreadIdentifier,
  exactMailThreadSha256,
  exactMailThreadTimestamp,
  freezeMailThreadRecord,
  parseMailThreadHandle,
  type MailThreadRecord,
} from "../src/mail-thread-contract";
import {
  exactRfcMessageId,
  freezeMailboxBinding,
  freezeMailDeliveryReceipt,
  freezeMailProviderProjection,
  type MailDeliveryReceipt,
  type MailOutboundEffectRecord,
  type MailProviderProjection,
} from "../src/mail-provider";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

export const reserveThread = mutation({
  args: { ...serviceArgs, threadJson: v.string() },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("MAIL_OUTBOUND_WORKSPACE_NOT_FOUND");
    const thread = admitThreadJson(args.threadJson, workspaceSlug);
    const threadJson = stableJson(thread);

    const bySource = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_project_source", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("project", thread.project)
        .eq("sourceIdentity", thread.sourceIdentity))
      .unique();
    if (bySource) {
      const current = threadFromRow(bySource, workspaceSlug);
      return sameThreadIdentity(current, thread)
        ? { outcome: "existing" as const, threadJson: stableJson(current) }
        : { outcome: "source_conflict" as const, threadJson: stableJson(current) };
    }

    const byHandle = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_handle", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("handle", thread.handle))
      .unique();
    if (byHandle) {
      return { outcome: "handle_conflict" as const, threadJson: stableJson(threadFromRow(byHandle, workspaceSlug)) };
    }

    const byId = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", thread.threadId))
      .unique();
    if (byId) {
      return { outcome: "handle_conflict" as const, threadJson: stableJson(threadFromRow(byId, workspaceSlug)) };
    }

    if (thread.continuesFromThreadId !== null) {
      const parent = await ctx.db
        .query("mailOutboundThreads")
        .withIndex("by_workspace_thread_id", (q) => q
          .eq("workspaceId", workspace._id)
          .eq("threadId", thread.continuesFromThreadId!))
        .unique();
      if (!parent) throw new Error("MAIL_OUTBOUND_PARENT_NOT_FOUND");
      threadFromRow(parent, workspaceSlug);
    }

    const now = Date.now();
    await ctx.db.insert("mailOutboundThreads", {
      workspaceId: workspace._id,
      threadId: thread.threadId,
      handle: thread.handle,
      project: thread.project,
      sourceIdentity: thread.sourceIdentity,
      threadJson,
      createdAt: now,
      updatedAt: now,
    });
    return { outcome: "created" as const, threadJson };
  },
});

export const getThreadByHandle = query({
  args: { ...serviceArgs, handle: v.string() },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return null;
    const handle = parseMailThreadHandle(args.handle);
    const row = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_handle", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("handle", handle))
      .unique();
    return row ? stableJson(threadFromRow(row, workspaceSlug)) : null;
  },
});

export const getThreadBySource = query({
  args: { ...serviceArgs, project: v.string(), sourceIdentity: v.string() },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return null;
    const project = exactMailThreadIdentifier(args.project, "Mail project", 120);
    const sourceIdentity = exactMailThreadIdentifier(args.sourceIdentity, "Mail source identity", 320);
    const row = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_project_source", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("project", project)
        .eq("sourceIdentity", sourceIdentity))
      .unique();
    return row ? stableJson(threadFromRow(row, workspaceSlug)) : null;
  },
});

export const updateThread = mutation({
  args: { ...serviceArgs, threadJson: v.string() },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("MAIL_OUTBOUND_WORKSPACE_NOT_FOUND");
    const thread = admitThreadJson(args.threadJson, workspaceSlug);
    const row = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", thread.threadId))
      .unique();
    if (!row) throw new Error("MAIL_OUTBOUND_THREAD_NOT_FOUND");
    const current = threadFromRow(row, workspaceSlug);
    if (!sameThreadIdentity(current, thread)) throw new Error("MAIL_OUTBOUND_THREAD_IDENTITY_CONFLICT");
    if (Date.parse(thread.updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("MAIL_OUTBOUND_THREAD_STALE_UPDATE");
    }
    const threadJson = stableJson(thread);
    await ctx.db.patch(row._id, { threadJson, updatedAt: Date.now() });
    return { threadJson };
  },
});

export const getProviderProjection = query({
  args: { ...serviceArgs, threadId: v.string(), provider: v.string(), accountBinding: v.string() },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) return null;
    const identity = providerIdentity(args);
    const row = await ctx.db
      .query("mailOutboundProviderProjections")
      .withIndex("by_workspace_thread_provider_account", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", identity.threadId)
        .eq("provider", identity.provider)
        .eq("accountBinding", identity.accountBinding))
      .unique();
    return row ? stableJson(projectionFromRow(row)) : null;
  },
});

export const reserveEffect = mutation({
  args: { ...serviceArgs, effectJson: v.string() },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("MAIL_OUTBOUND_WORKSPACE_NOT_FOUND");
    const requested = admitEffectJson(args.effectJson);
    if (requested.state !== "reserved" || requested.receipt !== null || requested.attemptNumber !== 1) {
      throw new Error("MAIL_OUTBOUND_NEW_EFFECT_INVALID");
    }

    const threadRow = await ctx.db
      .query("mailOutboundThreads")
      .withIndex("by_workspace_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", requested.threadId))
      .unique();
    if (!threadRow) throw new Error("MAIL_OUTBOUND_THREAD_NOT_FOUND");
    const thread = threadFromRow(threadRow, workspaceSlug);
    if (thread.handle !== requested.handle) throw new Error("MAIL_OUTBOUND_EFFECT_THREAD_CONFLICT");

    const priorRows = await ctx.db
      .query("mailOutboundEffects")
      .withIndex("by_workspace_thread_provider_account_created", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", requested.threadId)
        .eq("provider", requested.provider)
        .eq("accountBinding", requested.accountBinding))
      .order("desc")
      .take(1);
    if (priorRows[0]) {
      const prior = effectFromRow(priorRows[0]);
      if (prior.mailboxAddress !== requested.mailboxAddress) {
        return { outcome: "conflict" as const, effectJson: stableJson(prior) };
      }
    }

    const lane = await ctx.db
      .query("mailOutboundDeliveryLanes")
      .withIndex("by_workspace_thread_provider_account", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", requested.threadId)
        .eq("provider", requested.provider)
        .eq("accountBinding", requested.accountBinding))
      .unique();
    if (lane) {
      const activeRow = await effectById(ctx, workspace._id, lane.outboundEffectId);
      if (!activeRow) throw new Error("MAIL_OUTBOUND_LANE_EFFECT_MISSING");
      const active = effectFromRow(activeRow);
      assertLaneMatchesEffect(lane, active);
      return { outcome: "blocked" as const, effectJson: stableJson(active) };
    }

    const latestRows = await ctx.db
      .query("mailOutboundEffects")
      .withIndex("by_workspace_material_attempt", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", requested.threadId)
        .eq("provider", requested.provider)
        .eq("accountBinding", requested.accountBinding)
        .eq("contentFingerprint", requested.contentFingerprint))
      .order("desc")
      .take(1);
    if (latestRows[0]) {
      const latest = effectFromRow(latestRows[0]);
      if (latest.mailboxAddress !== requested.mailboxAddress) {
        return { outcome: "conflict" as const, effectJson: stableJson(latest) };
      }
      if (latest.state === "reserved" || latest.state === "ambiguous") {
        return { outcome: "blocked" as const, effectJson: stableJson(latest) };
      }
      if (latest.state === "sent" || latest.state === "reconciled") {
        const projectionRow = await projectionByIdentity(
          ctx,
          workspace._id,
          latest.threadId,
          latest.provider,
          latest.accountBinding,
        );
        if (!projectionRow) throw new Error("MAIL_OUTBOUND_SUCCESS_PROJECTION_MISSING");
        const projection = projectionFromRow(projectionRow);
        if (projection.mailboxAddress !== requested.mailboxAddress) {
          return { outcome: "conflict" as const, effectJson: stableJson(latest) };
        }
        if (projection.latestSentFingerprint === requested.contentFingerprint) {
          return { outcome: "replay" as const, effectJson: stableJson(latest) };
        }
      }
      if (latest.state !== "failed" && latest.state !== "sent" && latest.state !== "reconciled") {
        throw new Error("MAIL_OUTBOUND_RETRY_STATE_INVALID");
      }
      const retry = retryEffect(requested, latest.attemptNumber + 1);
      const existingRetryRow = await effectById(ctx, workspace._id, retry.outboundEffectId);
      if (existingRetryRow) {
        const existingRetry = effectFromRow(existingRetryRow);
        if (!sameEffectIdentity(existingRetry, retry)) {
          return { outcome: "conflict" as const, effectJson: stableJson(existingRetry) };
        }
        if (existingRetry.state === "reserved" || existingRetry.state === "ambiguous") {
          return { outcome: "blocked" as const, effectJson: stableJson(existingRetry) };
        }
        if (existingRetry.state === "sent" || existingRetry.state === "reconciled") {
          return { outcome: "replay" as const, effectJson: stableJson(existingRetry) };
        }
        throw new Error("MAIL_OUTBOUND_RETRY_IDENTITY_CONSUMED");
      }
      await insertEffectAndLane(ctx, workspace._id, retry);
      return { outcome: "reserved" as const, effectJson: stableJson(retry) };
    }

    const existingRow = await effectById(ctx, workspace._id, requested.outboundEffectId);
    if (existingRow) {
      const existing = effectFromRow(existingRow);
      return {
        outcome: sameEffectIdentity(existing, requested) ? "replay" as const : "conflict" as const,
        effectJson: stableJson(existing),
      };
    }

    await insertEffectAndLane(ctx, workspace._id, requested);
    return { outcome: "reserved" as const, effectJson: stableJson(requested) };
  },
});

export const settleEffect = mutation({
  args: {
    ...serviceArgs,
    effectJson: v.string(),
    receiptJson: v.string(),
    projectionJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const workspaceSlug = authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("MAIL_OUTBOUND_WORKSPACE_NOT_FOUND");
    const effect = admitEffectJson(args.effectJson);
    const receipt = admitReceiptJson(args.receiptJson);
    if (!receiptMatchesEffect(receipt, effect)) throw new Error("MAIL_OUTBOUND_RECEIPT_EFFECT_CONFLICT");
    const successful = receipt.result === "sent" || receipt.result === "reconciled";
    const projection = args.projectionJson === undefined ? null : admitProjectionJson(args.projectionJson);
    if (successful !== (projection !== null)) throw new Error("MAIL_OUTBOUND_PROJECTION_SETTLEMENT_CONFLICT");
    if (projection && !projectionMatchesEffect(projection, effect)) {
      throw new Error("MAIL_OUTBOUND_PROJECTION_EFFECT_CONFLICT");
    }

    const row = await effectById(ctx, workspace._id, effect.outboundEffectId);
    if (!row) throw new Error("MAIL_OUTBOUND_EFFECT_NOT_FOUND");
    const current = effectFromRow(row);
    if (!sameEffectIdentity(current, effect)) throw new Error("MAIL_OUTBOUND_EFFECT_IDENTITY_CONFLICT");
    if (current.receipt !== null) {
      if (stableJson(current.receipt) === stableJson(receipt)) {
        return { effectJson: stableJson(current), duplicate: true };
      }
      if (current.state !== "ambiguous") throw new Error("MAIL_OUTBOUND_TERMINAL_SETTLEMENT_CONFLICT");
    }

    const lane = await ctx.db
      .query("mailOutboundDeliveryLanes")
      .withIndex("by_workspace_thread_provider_account", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("threadId", effect.threadId)
        .eq("provider", effect.provider)
        .eq("accountBinding", effect.accountBinding))
      .unique();
    if (!lane || lane.outboundEffectId !== effect.outboundEffectId) throw new Error("MAIL_OUTBOUND_LANE_CONFLICT");
    if (lane.mailboxAddress !== effect.mailboxAddress) throw new Error("MAIL_OUTBOUND_LANE_DESTINATION_CONFLICT");

    if (projection) await upsertProjection(ctx, workspace._id, projection);
    if (successful) {
      if (receipt.providerMessageId === null) throw new Error("MAIL_OUTBOUND_PROVIDER_MESSAGE_REQUIRED");
      await recordProviderMessage(ctx, workspace._id, receipt);
    }

    const settled = admitEffect({ ...effect, state: receipt.result, receipt });
    await ctx.db.patch(row._id, {
      state: settled.state,
      effectJson: stableJson(settled),
      updatedAt: Date.now(),
    });
    if (receipt.result === "ambiguous") {
      await ctx.db.patch(lane._id, { state: "ambiguous", updatedAt: Date.now() });
    } else {
      await ctx.db.delete(lane._id);
    }
    return { effectJson: stableJson(settled), duplicate: false };
  },
});

export const getEffect = query({
  args: { ...serviceArgs, outboundEffectId: v.string() },
  handler: async (ctx, args) => {
    authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const effectId = exactMailThreadIdentifier(args.outboundEffectId, "Mail outbound effect ID", 240);
    const row = await effectById(ctx, workspace._id, effectId);
    return row ? stableJson(effectFromRow(row)) : null;
  },
});

export const getEffectByProviderMessage = query({
  args: { ...serviceArgs, provider: v.string(), accountBinding: v.string(), providerMessageId: v.string() },
  handler: async (ctx, args) => {
    authorizedWorkspace(args.serviceSecret, args.workspace);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const provider = freezeMailboxBinding({
      provider: args.provider,
      accountBinding: args.accountBinding,
      mailboxAddress: "validation@example.invalid",
    });
    const providerMessageId = exactMailThreadIdentifier(args.providerMessageId, "Provider mail message ID", 320);
    const providerRow = await ctx.db
      .query("mailOutboundProviderMessages")
      .withIndex("by_workspace_provider_account_message", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("provider", provider.provider)
        .eq("accountBinding", provider.accountBinding)
        .eq("providerMessageId", providerMessageId))
      .unique();
    if (!providerRow) return null;
    const effectRow = await effectById(ctx, workspace._id, providerRow.outboundEffectId);
    if (!effectRow) throw new Error("MAIL_OUTBOUND_PROVIDER_EFFECT_MISSING");
    const effect = effectFromRow(effectRow);
    if (
      (effect.state !== "sent" && effect.state !== "reconciled")
      || effect.provider !== providerRow.provider
      || effect.accountBinding !== providerRow.accountBinding
      || effect.mailboxAddress !== providerRow.mailboxAddress
      || effect.receipt?.providerMessageId !== providerMessageId
    ) throw new Error("MAIL_OUTBOUND_PROVIDER_EFFECT_CONFLICT");
    return stableJson(effect);
  },
});

function authorizedWorkspace(serviceSecret: string, workspace: string | undefined): string {
  requireServiceSecret(serviceSecret);
  return normalizeWorkspace(workspace);
}

function providerIdentity(input: { threadId: string; provider: string; accountBinding: string }) {
  const threadId = exactMailThreadIdentifier(input.threadId, "Mail thread ID", 240);
  const binding = freezeMailboxBinding({
    provider: input.provider,
    accountBinding: input.accountBinding,
    mailboxAddress: "validation@example.invalid",
  });
  return { threadId, provider: binding.provider, accountBinding: binding.accountBinding };
}

function admitThreadJson(value: string, workspace: string): MailThreadRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MAIL_OUTBOUND_THREAD_JSON_INVALID"); }
  const thread = freezeMailThreadRecord(parsed as MailThreadRecord);
  if (thread.workspace !== workspace) throw new Error("MAIL_OUTBOUND_THREAD_WORKSPACE_CONFLICT");
  return thread;
}

function admitProjectionJson(value: string): MailProviderProjection {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MAIL_OUTBOUND_PROJECTION_JSON_INVALID"); }
  return freezeMailProviderProjection(parsed as MailProviderProjection);
}

function admitReceiptJson(value: string): MailDeliveryReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MAIL_OUTBOUND_RECEIPT_JSON_INVALID"); }
  return freezeMailDeliveryReceipt(parsed as MailDeliveryReceipt);
}

function admitEffectJson(value: string): MailOutboundEffectRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("MAIL_OUTBOUND_EFFECT_JSON_INVALID"); }
  return admitEffect(parsed as MailOutboundEffectRecord);
}

function admitEffect(input: MailOutboundEffectRecord): MailOutboundEffectRecord {
  if (!input || typeof input !== "object" || input.version !== 1) throw new Error("MAIL_OUTBOUND_EFFECT_INVALID");
  const binding = freezeMailboxBinding({
    provider: input.provider,
    accountBinding: input.accountBinding,
    mailboxAddress: input.mailboxAddress,
  });
  const state = input.state;
  if (!["reserved", "sent", "ambiguous", "failed", "reconciled"].includes(state)) {
    throw new Error("MAIL_OUTBOUND_EFFECT_STATE_INVALID");
  }
  if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1 || input.attemptNumber > 64) {
    throw new Error("MAIL_OUTBOUND_EFFECT_ATTEMPT_INVALID");
  }
  const receipt = input.receipt === null ? null : freezeMailDeliveryReceipt(input.receipt);
  const effect: MailOutboundEffectRecord = Object.freeze({
    version: 1,
    outboundEffectId: exactMailThreadIdentifier(input.outboundEffectId, "Mail outbound effect ID", 240),
    threadId: exactMailThreadIdentifier(input.threadId, "Mail thread ID", 240),
    handle: parseMailThreadHandle(input.handle),
    provider: binding.provider,
    accountBinding: binding.accountBinding,
    mailboxAddress: binding.mailboxAddress,
    attemptNumber: input.attemptNumber,
    contentFingerprint: exactMailThreadSha256(input.contentFingerprint, "Mail content fingerprint"),
    rfcMessageId: exactRfcMessageId(input.rfcMessageId),
    reservedAt: exactMailThreadTimestamp(input.reservedAt, "Mail reservation time"),
    state,
    receipt,
  });
  if ((state === "reserved") !== (receipt === null)) throw new Error("MAIL_OUTBOUND_EFFECT_RECEIPT_STATE_CONFLICT");
  if (receipt && (receipt.result !== state || !receiptMatchesEffect(receipt, effect))) {
    throw new Error("MAIL_OUTBOUND_EFFECT_RECEIPT_CONFLICT");
  }
  return effect;
}

function threadFromRow(row: any, workspace: string): MailThreadRecord {
  const thread = admitThreadJson(row.threadJson, workspace);
  if (
    row.threadId !== thread.threadId
    || row.handle !== thread.handle
    || row.project !== thread.project
    || row.sourceIdentity !== thread.sourceIdentity
  ) throw new Error("MAIL_OUTBOUND_THREAD_ROW_CONFLICT");
  return thread;
}

function projectionFromRow(row: any): MailProviderProjection {
  const projection = admitProjectionJson(row.projectionJson);
  if (
    row.threadId !== projection.threadId
    || row.provider !== projection.provider
    || row.accountBinding !== projection.accountBinding
    || row.mailboxAddress !== projection.mailboxAddress
    || row.providerThreadId !== projection.providerThreadId
  ) throw new Error("MAIL_OUTBOUND_PROJECTION_ROW_CONFLICT");
  return projection;
}

function effectFromRow(row: any): MailOutboundEffectRecord {
  const effect = admitEffectJson(row.effectJson);
  if (
    row.outboundEffectId !== effect.outboundEffectId
    || row.threadId !== effect.threadId
    || row.provider !== effect.provider
    || row.accountBinding !== effect.accountBinding
    || row.mailboxAddress !== effect.mailboxAddress
    || row.contentFingerprint !== effect.contentFingerprint
    || row.attemptNumber !== effect.attemptNumber
    || row.state !== effect.state
  ) throw new Error("MAIL_OUTBOUND_EFFECT_ROW_CONFLICT");
  return effect;
}

function assertLaneMatchesEffect(lane: any, effect: MailOutboundEffectRecord): void {
  if (
    lane.threadId !== effect.threadId
    || lane.provider !== effect.provider
    || lane.accountBinding !== effect.accountBinding
    || lane.mailboxAddress !== effect.mailboxAddress
    || lane.outboundEffectId !== effect.outboundEffectId
    || lane.state !== effect.state
  ) throw new Error("MAIL_OUTBOUND_LANE_ROW_CONFLICT");
}

function sameThreadIdentity(left: MailThreadRecord, right: MailThreadRecord): boolean {
  return left.threadId === right.threadId
    && left.handle === right.handle
    && left.workspace === right.workspace
    && left.project === right.project
    && left.threadClass === right.threadClass
    && left.canonicalSubject === right.canonicalSubject
    && left.sourceIdentity === right.sourceIdentity
    && left.continuesFromThreadId === right.continuesFromThreadId;
}

function sameEffectIdentity(left: MailOutboundEffectRecord, right: MailOutboundEffectRecord): boolean {
  return left.outboundEffectId === right.outboundEffectId
    && left.threadId === right.threadId
    && left.handle === right.handle
    && left.provider === right.provider
    && left.accountBinding === right.accountBinding
    && left.mailboxAddress === right.mailboxAddress
    && left.attemptNumber === right.attemptNumber
    && left.contentFingerprint === right.contentFingerprint
    && left.rfcMessageId === right.rfcMessageId;
}

function receiptMatchesEffect(receipt: MailDeliveryReceipt, effect: MailOutboundEffectRecord): boolean {
  return receipt.outboundEffectId === effect.outboundEffectId
    && receipt.threadId === effect.threadId
    && receipt.handle === effect.handle
    && receipt.provider === effect.provider
    && receipt.accountBinding === effect.accountBinding
    && receipt.mailboxAddress === effect.mailboxAddress
    && receipt.attemptNumber === effect.attemptNumber
    && receipt.contentFingerprint === effect.contentFingerprint
    && receipt.rfcMessageId === effect.rfcMessageId;
}

function projectionMatchesEffect(projection: MailProviderProjection, effect: MailOutboundEffectRecord): boolean {
  return projection.threadId === effect.threadId
    && projection.provider === effect.provider
    && projection.accountBinding === effect.accountBinding
    && projection.mailboxAddress === effect.mailboxAddress
    && projection.latestSentFingerprint === effect.contentFingerprint;
}

function retryEffect(base: MailOutboundEffectRecord, attemptNumber: number): MailOutboundEffectRecord {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 2 || attemptNumber > 64) {
    throw new Error("MAIL_OUTBOUND_RETRY_ATTEMPT_INVALID");
  }
  const digest = sha256(stableJson({
    version: 1,
    priorEffectId: base.outboundEffectId,
    threadId: base.threadId,
    provider: base.provider,
    accountBinding: base.accountBinding,
    mailboxAddress: base.mailboxAddress,
    contentFingerprint: base.contentFingerprint,
    attemptNumber,
  }));
  const hex = digest.slice("sha256:".length);
  return admitEffect({
    ...base,
    outboundEffectId: `mailfx_${hex.slice(0, 40)}`,
    attemptNumber,
    rfcMessageId: `<stn.${hex}@mail.stensibly.com>`,
    state: "reserved",
    receipt: null,
  });
}

async function effectById(ctx: any, workspaceId: any, outboundEffectId: string) {
  return await ctx.db
    .query("mailOutboundEffects")
    .withIndex("by_workspace_effect_id", (q: any) => q
      .eq("workspaceId", workspaceId)
      .eq("outboundEffectId", outboundEffectId))
    .unique();
}

async function projectionByIdentity(
  ctx: any,
  workspaceId: any,
  threadId: string,
  provider: string,
  accountBinding: string,
) {
  return await ctx.db
    .query("mailOutboundProviderProjections")
    .withIndex("by_workspace_thread_provider_account", (q: any) => q
      .eq("workspaceId", workspaceId)
      .eq("threadId", threadId)
      .eq("provider", provider)
      .eq("accountBinding", accountBinding))
    .unique();
}

async function insertEffectAndLane(ctx: any, workspaceId: any, effect: MailOutboundEffectRecord) {
  const now = Date.now();
  await ctx.db.insert("mailOutboundEffects", {
    workspaceId,
    outboundEffectId: effect.outboundEffectId,
    threadId: effect.threadId,
    provider: effect.provider,
    accountBinding: effect.accountBinding,
    mailboxAddress: effect.mailboxAddress,
    contentFingerprint: effect.contentFingerprint,
    attemptNumber: effect.attemptNumber,
    state: effect.state,
    effectJson: stableJson(effect),
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("mailOutboundDeliveryLanes", {
    workspaceId,
    threadId: effect.threadId,
    provider: effect.provider,
    accountBinding: effect.accountBinding,
    mailboxAddress: effect.mailboxAddress,
    outboundEffectId: effect.outboundEffectId,
    state: "reserved",
    createdAt: now,
    updatedAt: now,
  });
}

async function upsertProjection(ctx: any, workspaceId: any, projection: MailProviderProjection) {
  const current = await projectionByIdentity(
    ctx,
    workspaceId,
    projection.threadId,
    projection.provider,
    projection.accountBinding,
  );
  const projectionJson = stableJson(projection);
  const now = Date.now();
  if (current) {
    const prior = projectionFromRow(current);
    if (
      prior.mailboxAddress !== projection.mailboxAddress
      || prior.providerThreadId !== projection.providerThreadId
      || prior.rootProviderMessageId !== projection.rootProviderMessageId
      || prior.rootRfcMessageId !== projection.rootRfcMessageId
    ) throw new Error("MAIL_OUTBOUND_PROJECTION_ANCESTRY_CONFLICT");
    await ctx.db.patch(current._id, {
      providerThreadId: projection.providerThreadId,
      projectionJson,
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("mailOutboundProviderProjections", {
    workspaceId,
    threadId: projection.threadId,
    provider: projection.provider,
    accountBinding: projection.accountBinding,
    mailboxAddress: projection.mailboxAddress,
    providerThreadId: projection.providerThreadId,
    projectionJson,
    createdAt: now,
    updatedAt: now,
  });
}

async function recordProviderMessage(ctx: any, workspaceId: any, receipt: MailDeliveryReceipt) {
  const providerMessageId = receipt.providerMessageId!;
  const existing = await ctx.db
    .query("mailOutboundProviderMessages")
    .withIndex("by_workspace_provider_account_message", (q: any) => q
      .eq("workspaceId", workspaceId)
      .eq("provider", receipt.provider)
      .eq("accountBinding", receipt.accountBinding)
      .eq("providerMessageId", providerMessageId))
    .unique();
  if (existing) {
    if (
      existing.outboundEffectId !== receipt.outboundEffectId
      || existing.mailboxAddress !== receipt.mailboxAddress
    ) throw new Error("MAIL_OUTBOUND_PROVIDER_MESSAGE_CONFLICT");
    return;
  }
  const byEffect = await ctx.db
    .query("mailOutboundProviderMessages")
    .withIndex("by_workspace_effect_id", (q: any) => q
      .eq("workspaceId", workspaceId)
      .eq("outboundEffectId", receipt.outboundEffectId))
    .unique();
  if (byEffect) throw new Error("MAIL_OUTBOUND_EFFECT_PROVIDER_MESSAGE_CONFLICT");
  await ctx.db.insert("mailOutboundProviderMessages", {
    workspaceId,
    provider: receipt.provider,
    accountBinding: receipt.accountBinding,
    mailboxAddress: receipt.mailboxAddress,
    providerMessageId,
    outboundEffectId: receipt.outboundEffectId,
    createdAt: Date.now(),
  });
}
