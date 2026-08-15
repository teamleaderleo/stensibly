import { v } from "convex/values";
import { stableJson } from "../src/canonical-json";
import type {
  CurrentDurableStnMailboxState,
  GmailMailboxDispositionEffect,
  GmailMailboxDispositionEffectRecord,
  GmailMailboxDispositionReconciliationPhase,
  GmailMailboxDispositionSettledOutcome,
} from "../src/gmail-mailbox-disposition-effect";
import {
  freezeMailDeliveryReceipt,
  type MailDeliveryReceipt,
} from "../src/mail-provider";
import type { Doc, Id } from "./_generated/dataModel";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type QueryContext,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumJsonBytes = 64 * 1024;
const encoder = new TextEncoder();
type ReadCtx = QueryContext;

export const putCurrentState = mutation({
  args: { ...serviceArgs, stateJson: v.string() },
  handler: async (ctx, args) => {
    const workspace = await requiredWorkspace(ctx, args.serviceSecret, args.workspace);
    const state = admitCurrentStateJson(args.stateJson);
    const stateJson = stableJson(state);
    const existing = await ctx.db
      .query("gmailMailboxDispositionStates")
      .withIndex("by_workspace_id_and_stn_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("stnThreadId", state.stnThreadId))
      .unique();
    if (existing) {
      const current = admitCurrentStateJson(existing.stateJson);
      if (current.revision === state.revision) {
        if (stableJson(current) !== stateJson) throw new Error("GMAIL_DISPOSITION_STATE_REVISION_CONFLICT");
        return { stateJson: existing.stateJson, duplicate: true };
      }
      await ctx.db.patch(existing._id, { revision: state.revision, stateJson, updatedAt: Date.now() });
      return { stateJson, duplicate: false };
    }
    const now = Date.now();
    await ctx.db.insert("gmailMailboxDispositionStates", {
      workspaceId: workspace._id,
      stnThreadId: state.stnThreadId,
      revision: state.revision,
      stateJson,
      createdAt: now,
      updatedAt: now,
    });
    return { stateJson, duplicate: false };
  },
});

export const getCurrentState = query({
  args: { ...serviceArgs, stnThreadId: v.string() },
  handler: async (ctx, args) => {
    const workspace = await optionalWorkspace(ctx, args.serviceSecret, args.workspace);
    if (!workspace) return null;
    const stnThreadId = identifier(args.stnThreadId, "STN thread ID", 240);
    const row = await ctx.db
      .query("gmailMailboxDispositionStates")
      .withIndex("by_workspace_id_and_stn_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("stnThreadId", stnThreadId))
      .unique();
    return row ? stableJson(admitCurrentStateJson(row.stateJson)) : null;
  },
});

export const recordSettledDelivery = mutation({
  args: { ...serviceArgs, receiptJson: v.string() },
  handler: async (ctx, args) => {
    const workspace = await requiredWorkspace(ctx, args.serviceSecret, args.workspace);
    const receipt = admitSettledGmailReceipt(args.receiptJson);
    const receiptJson = stableJson(receipt);
    const existing = await ctx.db
      .query("gmailMailboxDispositionTargets")
      .withIndex("by_workspace_id_and_stn_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("stnThreadId", receipt.threadId))
      .unique();
    if (existing) {
      if (
        existing.provider !== receipt.provider
        || existing.accountBinding !== receipt.accountBinding
        || existing.mailboxAddress !== receipt.mailboxAddress
        || existing.providerThreadId !== receipt.providerThreadId
      ) throw new Error("GMAIL_DISPOSITION_TARGET_IDENTITY_CONFLICT");
      const comparison = Date.parse(receipt.attemptedAt) - Date.parse(existing.attemptedAt);
      if (comparison < 0) return { receiptJson: existing.receiptJson, outcome: "stale" as const };
      if (comparison === 0) {
        if (existing.receiptJson !== receiptJson) throw new Error("GMAIL_DISPOSITION_TARGET_RECEIPT_CONFLICT");
        return { receiptJson, outcome: "replay" as const };
      }
      await ctx.db.patch(existing._id, {
        providerMessageId: receipt.providerMessageId!,
        attemptedAt: receipt.attemptedAt,
        receiptJson,
        updatedAt: Date.now(),
      });
      return { receiptJson, outcome: "updated" as const };
    }
    const now = Date.now();
    await ctx.db.insert("gmailMailboxDispositionTargets", {
      workspaceId: workspace._id,
      stnThreadId: receipt.threadId,
      provider: "gmail",
      accountBinding: receipt.accountBinding,
      mailboxAddress: receipt.mailboxAddress,
      providerThreadId: receipt.providerThreadId!,
      providerMessageId: receipt.providerMessageId!,
      attemptedAt: receipt.attemptedAt,
      receiptJson,
      createdAt: now,
      updatedAt: now,
    });
    return { receiptJson, outcome: "recorded" as const };
  },
});

export const getSettledDelivery = query({
  args: { ...serviceArgs, stnThreadId: v.string() },
  handler: async (ctx, args) => {
    const workspace = await optionalWorkspace(ctx, args.serviceSecret, args.workspace);
    if (!workspace) return null;
    const stnThreadId = identifier(args.stnThreadId, "STN thread ID", 240);
    const row = await ctx.db
      .query("gmailMailboxDispositionTargets")
      .withIndex("by_workspace_id_and_stn_thread_id", (q) => q
        .eq("workspaceId", workspace._id)
        .eq("stnThreadId", stnThreadId))
      .unique();
    return row ? stableJson(admitSettledGmailReceipt(row.receiptJson)) : null;
  },
});

export const getEffect = query({
  args: { ...serviceArgs, effectId: v.string() },
  handler: async (ctx, args) => {
    const workspace = await optionalWorkspace(ctx, args.serviceSecret, args.workspace);
    if (!workspace) return null;
    const row = await effectById(ctx, workspace._id, identifier(args.effectId, "Gmail disposition effect ID", 4096));
    return row ? stableJson(recordFromEffectRow(row)) : null;
  },
});

export const findOutstanding = query({
  args: {
    ...serviceArgs,
    accountBinding: v.string(),
    mailboxAddress: v.string(),
    providerThreadId: v.string(),
    providerMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await optionalWorkspace(ctx, args.serviceSecret, args.workspace);
    if (!workspace) return null;
    const target = targetIdentity(args);
    const lane = await laneByTarget(ctx, workspace._id, target);
    if (!lane) return null;
    const row = await effectById(ctx, workspace._id, lane.effectId);
    if (!row) throw new Error("GMAIL_DISPOSITION_LANE_EFFECT_MISSING");
    const record = recordFromEffectRow(row);
    if (record.status === "settled") throw new Error("GMAIL_DISPOSITION_SETTLED_LANE_CONFLICT");
    return stableJson(record);
  },
});

export const reserveEffect = mutation({
  args: { ...serviceArgs, effectJson: v.string() },
  handler: async (ctx, args) => {
    const workspace = await requiredWorkspace(ctx, args.serviceSecret, args.workspace);
    const effect = admitEffectJson(args.effectJson);
    const effectJson = stableJson(effect);
    const existing = await effectById(ctx, workspace._id, effect.effectId);
    if (existing) {
      const record = recordFromEffectRow(existing);
      if (stableJson(record.effect) !== effectJson) throw new Error("GMAIL_DISPOSITION_EFFECT_IDENTITY_CONFLICT");
      return { outcome: "existing" as const, recordJson: stableJson(record) };
    }
    const lane = await laneByTarget(ctx, workspace._id, effect.binding);
    if (lane) {
      const row = await effectById(ctx, workspace._id, lane.effectId);
      if (!row) throw new Error("GMAIL_DISPOSITION_LANE_EFFECT_MISSING");
      return { outcome: "blocked" as const, recordJson: stableJson(recordFromEffectRow(row)) };
    }
    const now = Date.now();
    await ctx.db.insert("gmailMailboxDispositionEffects", {
      workspaceId: workspace._id,
      effectId: effect.effectId,
      stnThreadId: effect.binding.stnThreadId,
      provider: "gmail",
      accountBinding: effect.binding.accountBinding,
      mailboxAddress: effect.binding.mailboxAddress,
      providerThreadId: effect.binding.providerThreadId,
      providerMessageId: effect.binding.providerMessageId,
      stateRevision: effect.stnStateRevision,
      status: "reserved",
      reconciliationPhase: null,
      settledOutcome: null,
      effectJson,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("gmailMailboxDispositionLanes", {
      workspaceId: workspace._id,
      provider: "gmail",
      accountBinding: effect.binding.accountBinding,
      mailboxAddress: effect.binding.mailboxAddress,
      providerThreadId: effect.binding.providerThreadId,
      providerMessageId: effect.binding.providerMessageId,
      effectId: effect.effectId,
      status: "reserved",
      createdAt: now,
      updatedAt: now,
    });
    return { outcome: "reserved" as const, recordJson: stableJson(recordFromValues(effect, "reserved", null, null)) };
  },
});

export const markReconciliationRequired = mutation({
  args: { ...serviceArgs, effectId: v.string(), phase: v.string() },
  handler: async (ctx, args) => {
    const workspace = await requiredWorkspace(ctx, args.serviceSecret, args.workspace);
    const effectId = identifier(args.effectId, "Gmail disposition effect ID", 4096);
    const phase = admitPhase(args.phase);
    const row = await requiredEffect(ctx, workspace._id, effectId);
    const record = recordFromEffectRow(row);
    if (record.status === "settled") throw new Error("GMAIL_DISPOSITION_EFFECT_ALREADY_SETTLED");
    await ctx.db.patch(row._id, {
      status: "reconciliation_required",
      reconciliationPhase: phase,
      settledOutcome: null,
      updatedAt: Date.now(),
    });
    const lane = await requiredLaneByEffect(ctx, workspace._id, effectId);
    await ctx.db.patch(lane._id, { status: "reconciliation_required", updatedAt: Date.now() });
    return stableJson(recordFromValues(record.effect, "reconciliation_required", phase, null));
  },
});

export const markSettled = mutation({
  args: { ...serviceArgs, effectId: v.string(), outcome: v.string() },
  handler: async (ctx, args) => {
    const workspace = await requiredWorkspace(ctx, args.serviceSecret, args.workspace);
    const effectId = identifier(args.effectId, "Gmail disposition effect ID", 4096);
    const outcome = admitSettledOutcome(args.outcome);
    const row = await requiredEffect(ctx, workspace._id, effectId);
    const current = recordFromEffectRow(row);
    if (current.status === "settled") {
      if (current.settledOutcome !== outcome) throw new Error("GMAIL_DISPOSITION_SETTLEMENT_CONFLICT");
      return stableJson(current);
    }
    await ctx.db.patch(row._id, {
      status: "settled",
      reconciliationPhase: null,
      settledOutcome: outcome,
      updatedAt: Date.now(),
    });
    const lane = await requiredLaneByEffect(ctx, workspace._id, effectId);
    await ctx.db.delete(lane._id);
    return stableJson(recordFromValues(current.effect, "settled", null, outcome));
  },
});

export const releasePreconditionRetry = mutation({
  args: { ...serviceArgs, effectId: v.string() },
  handler: async (ctx, args) => {
    const workspace = await requiredWorkspace(ctx, args.serviceSecret, args.workspace);
    const effectId = identifier(args.effectId, "Gmail disposition effect ID", 4096);
    const row = await requiredEffect(ctx, workspace._id, effectId);
    const record = recordFromEffectRow(row);
    if (record.status !== "reconciliation_required" || record.reconciliationPhase !== "precondition_read") {
      throw new Error("GMAIL_DISPOSITION_PRECONDITION_RELEASE_CONFLICT");
    }
    const lane = await requiredLaneByEffect(ctx, workspace._id, effectId);
    await ctx.db.delete(lane._id);
    await ctx.db.delete(row._id);
    return { released: true };
  },
});

async function requiredWorkspace(ctx: ReadCtx, serviceSecret: string, workspace: string | undefined) {
  const value = await optionalWorkspace(ctx, serviceSecret, workspace);
  if (!value) throw new Error("GMAIL_DISPOSITION_WORKSPACE_NOT_FOUND");
  return value;
}

async function optionalWorkspace(ctx: ReadCtx, serviceSecret: string, workspace: string | undefined) {
  requireServiceSecret(serviceSecret);
  return await findWorkspace(ctx, normalizeWorkspace(workspace));
}

function admitCurrentStateJson(value: string): CurrentDurableStnMailboxState {
  const source = jsonRecord(value, "current STN state");
  if (source.source !== "durable_stn_state") throw new Error("GMAIL_DISPOSITION_STATE_PROVENANCE_INVALID");
  if (source.state !== "active" && source.state !== "waiting" && source.state !== "resolved") throw new Error("GMAIL_DISPOSITION_STATE_INVALID");
  if (!isAttentionClass(source.attentionClass) || typeof source.operatorAttentionRequired !== "boolean") {
    throw new Error("GMAIL_DISPOSITION_ATTENTION_STATE_INVALID");
  }
  return Object.freeze({
    source: "durable_stn_state",
    stnThreadId: identifier(source.stnThreadId, "STN thread ID", 240),
    revision: identifier(source.revision, "STN state revision", 320),
    attentionClass: source.attentionClass,
    operatorAttentionRequired: source.operatorAttentionRequired,
    state: source.state,
  });
}

function admitEffectJson(value: string): GmailMailboxDispositionEffect {
  const source = jsonRecord(value, "Gmail disposition effect");
  if (source.version !== "gmail-mailbox-disposition-effect/v1" || source.authorizesMailSend !== false) {
    throw new Error("GMAIL_DISPOSITION_EFFECT_VERSION_INVALID");
  }
  const binding = objectRecord(source.binding, "Gmail disposition binding");
  if (binding.source !== "settled_gmail_message_binding" || binding.provider !== "gmail") throw new Error("GMAIL_DISPOSITION_EFFECT_BINDING_INVALID");
  const disposition = objectRecord(source.disposition, "Gmail disposition policy");
  if (
    disposition.label !== "Stensibly"
    || typeof disposition.archive !== "boolean"
    || typeof disposition.markRead !== "boolean"
    || !isDispositionReason(disposition.reason)
  ) throw new Error("GMAIL_DISPOSITION_EFFECT_POLICY_INVALID");
  return Object.freeze({
    version: "gmail-mailbox-disposition-effect/v1",
    effectId: identifier(source.effectId, "Gmail disposition effect ID", 4096),
    binding: Object.freeze({
      source: "settled_gmail_message_binding",
      provider: "gmail",
      stnThreadId: identifier(binding.stnThreadId, "STN thread ID", 240),
      accountBinding: identifier(binding.accountBinding, "Gmail account binding", 320),
      mailboxAddress: identifier(binding.mailboxAddress, "Gmail mailbox address", 320),
      providerThreadId: identifier(binding.providerThreadId, "Gmail thread ID", 320),
      providerMessageId: identifier(binding.providerMessageId, "Gmail message ID", 320),
      stensiblyLabelId: identifier(binding.stensiblyLabelId, "Stensibly label ID", 160),
    }),
    stnStateRevision: identifier(source.stnStateRevision, "STN state revision", 320),
    disposition: Object.freeze({ label: "Stensibly", archive: disposition.archive, markRead: disposition.markRead, reason: disposition.reason }),
    requiredLabelIds: labels(source.requiredLabelIds, "required Gmail labels"),
    forbiddenLabelIds: labels(source.forbiddenLabelIds, "forbidden Gmail labels"),
    authorizesMailSend: false,
  });
}

function admitSettledGmailReceipt(value: string): MailDeliveryReceipt {
  const receipt = freezeMailDeliveryReceipt(jsonRecord(value, "Gmail delivery receipt") as unknown as MailDeliveryReceipt);
  if (
    receipt.provider !== "gmail"
    || (receipt.result !== "sent" && receipt.result !== "reconciled")
    || receipt.providerThreadId === null
    || receipt.providerMessageId === null
  ) throw new Error("GMAIL_DISPOSITION_SETTLED_RECEIPT_REQUIRED");
  return receipt;
}

function recordFromEffectRow(row: Doc<"gmailMailboxDispositionEffects">): GmailMailboxDispositionEffectRecord {
  return recordFromValues(
    admitEffectJson(row.effectJson),
    row.status,
    row.reconciliationPhase === null ? null : admitPhase(row.reconciliationPhase),
    row.settledOutcome === null ? null : admitSettledOutcome(row.settledOutcome),
  );
}

function recordFromValues(
  effect: GmailMailboxDispositionEffect,
  status: GmailMailboxDispositionEffectRecord["status"],
  reconciliationPhase: GmailMailboxDispositionReconciliationPhase | null,
  settledOutcome: GmailMailboxDispositionSettledOutcome | null,
): GmailMailboxDispositionEffectRecord {
  return Object.freeze({ effect, status, reconciliationPhase, settledOutcome });
}

async function effectById(ctx: ReadCtx, workspaceId: Id<"workspaces">, effectId: string) {
  return await ctx.db
    .query("gmailMailboxDispositionEffects")
    .withIndex("by_workspace_id_and_effect_id", (q) => q.eq("workspaceId", workspaceId).eq("effectId", effectId))
    .unique();
}

async function requiredEffect(ctx: ReadCtx, workspaceId: Id<"workspaces">, effectId: string): Promise<Doc<"gmailMailboxDispositionEffects">> {
  const row = await effectById(ctx, workspaceId, effectId);
  if (!row) throw new Error("GMAIL_DISPOSITION_EFFECT_NOT_FOUND");
  return row;
}

async function laneByTarget(
  ctx: ReadCtx,
  workspaceId: Id<"workspaces">,
  target: { accountBinding: string; mailboxAddress: string; providerThreadId: string; providerMessageId: string },
) {
  return await ctx.db
    .query("gmailMailboxDispositionLanes")
    .withIndex("by_workspace_id_and_provider_and_account_binding_and_mailbox_address_and_provider_thread_id_and_provider_message_id", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("provider", "gmail")
      .eq("accountBinding", target.accountBinding)
      .eq("mailboxAddress", target.mailboxAddress)
      .eq("providerThreadId", target.providerThreadId)
      .eq("providerMessageId", target.providerMessageId))
    .unique();
}

async function requiredLaneByEffect(ctx: ReadCtx, workspaceId: Id<"workspaces">, effectId: string) {
  const lane = await ctx.db
    .query("gmailMailboxDispositionLanes")
    .withIndex("by_workspace_id_and_effect_id", (q) => q.eq("workspaceId", workspaceId).eq("effectId", effectId))
    .unique();
  if (!lane) throw new Error("GMAIL_DISPOSITION_LANE_NOT_FOUND");
  return lane;
}

function targetIdentity(source: Record<string, unknown>) {
  return {
    accountBinding: identifier(source.accountBinding, "Gmail account binding", 320),
    mailboxAddress: identifier(source.mailboxAddress, "Gmail mailbox address", 320),
    providerThreadId: identifier(source.providerThreadId, "Gmail thread ID", 320),
    providerMessageId: identifier(source.providerMessageId, "Gmail message ID", 320),
  };
}

function admitPhase(value: unknown): GmailMailboxDispositionReconciliationPhase {
  if (value === "interrupted" || value === "precondition_read" || value === "mutation_outcome" || value === "post_mutation_readback") return value;
  throw new Error("GMAIL_DISPOSITION_RECONCILIATION_PHASE_INVALID");
}

function admitSettledOutcome(value: unknown): GmailMailboxDispositionSettledOutcome {
  if (value === "applied" || value === "noop" || value === "ignored_draft" || value === "reconciled") return value;
  throw new Error("GMAIL_DISPOSITION_SETTLED_OUTCOME_INVALID");
}

function isAttentionClass(value: unknown): value is CurrentDurableStnMailboxState["attentionClass"] {
  return value === "handoff" || value === "review" || value === "decision" || value === "incident";
}

function isDispositionReason(value: unknown): value is GmailMailboxDispositionEffect["disposition"]["reason"] {
  return value === "operator_attention" || value === "routine" || value === "waiting" || value === "resolved";
}

function labels(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error(`${label} invalid`);
  return Object.freeze([...new Set(value.map((item) => identifier(item, "Gmail label ID", 160)))]);
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length < 2 || encoder.encode(value).byteLength > maximumJsonBytes) throw new Error(`${label} JSON invalid`);
  try {
    return objectRecord(JSON.parse(value), label);
  } catch {
    throw new Error(`${label} JSON invalid`);
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} invalid`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value !== value.trim()
    || /[\r\n\u0000]/u.test(value)
    || encoder.encode(value).byteLength > maximumBytes
  ) throw new Error(`${label} invalid`);
  return value;
}
