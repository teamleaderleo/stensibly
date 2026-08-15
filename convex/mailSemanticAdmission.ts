import { v } from "convex/values";
import { admitMailSemanticAdmissionEvidenceJson } from "../src/mail-semantic-admission-evidence";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const maximumThreadAdmissions = 100;

export const get = query({
  args: {
    ...serviceArgs,
    provider: v.literal("gmail"),
    mailboxBindingId: v.string(),
    providerMessageId: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return null;
    const row = await ctx.db
      .query("mailSemanticAdmissions")
      .withIndex(
        "by_workspace_id_and_provider_and_mailbox_binding_id_and_provider_message_id",
        (q) => q.eq("workspaceId", workspace._id)
          .eq("provider", "gmail")
          .eq("mailboxBindingId", args.mailboxBindingId)
          .eq("providerMessageId", args.providerMessageId),
      )
      .unique();
    return row?.admissionJson ?? null;
  },
});

export const admit = mutation({
  args: {
    ...serviceArgs,
    admissionJson: v.string(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error("MAIL_SEMANTIC_WORKSPACE_NOT_FOUND");
    const evidence = admitMailSemanticAdmissionEvidenceJson(args.admissionJson);
    const existing = await ctx.db
      .query("mailSemanticAdmissions")
      .withIndex(
        "by_workspace_id_and_provider_and_mailbox_binding_id_and_provider_message_id",
        (q) => q.eq("workspaceId", workspace._id)
          .eq("provider", evidence.provider)
          .eq("mailboxBindingId", evidence.mailboxBindingId)
          .eq("providerMessageId", evidence.providerMessageId),
      )
      .unique();
    if (existing) {
      const prior = admitMailSemanticAdmissionEvidenceJson(existing.admissionJson);
      if (existing.messageContentFingerprint !== evidence.messageContentFingerprint) {
        throw new Error("MAIL_SEMANTIC_PROVIDER_CONTENT_CONFLICT");
      }
      if (
        prior.threadId !== evidence.threadId
        || prior.providerThreadId !== evidence.providerThreadId
        || prior.replyClass !== evidence.replyClass
        || prior.replyFingerprint !== evidence.replyFingerprint
        || prior.authorityFingerprint !== evidence.authorityFingerprint
      ) {
        throw new Error("MAIL_SEMANTIC_ADMISSION_CONFLICT");
      }
      return { duplicate: true, admissionJson: existing.admissionJson };
    }

    await ctx.db.insert("mailSemanticAdmissions", {
      workspaceId: workspace._id,
      provider: evidence.provider,
      mailboxBindingId: evidence.mailboxBindingId,
      providerMessageId: evidence.providerMessageId,
      providerThreadId: evidence.providerThreadId,
      threadId: evidence.threadId,
      admissionId: evidence.admissionId,
      messageContentFingerprint: evidence.messageContentFingerprint,
      admissionFingerprint: evidence.admissionFingerprint,
      admissionJson: args.admissionJson,
      createdAt: Date.now(),
    });
    return { duplicate: false, admissionJson: args.admissionJson };
  },
});

export const listRecentForThread = query({
  args: {
    ...serviceArgs,
    threadId: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) return [];
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > maximumThreadAdmissions) {
      throw new RangeError("Mail semantic thread admission limit is invalid");
    }
    const rows = await ctx.db
      .query("mailSemanticAdmissions")
      .withIndex("by_workspace_id_and_thread_id_and_created_at", (q) =>
        q.eq("workspaceId", workspace._id).eq("threadId", args.threadId),
      )
      .order("desc")
      .take(args.limit);
    return rows.map((row) => row.admissionJson);
  },
});
