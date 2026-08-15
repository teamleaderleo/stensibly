import { defineTable } from "convex/server";
import { v } from "convex/values";
import { mailSemanticAdmissionProviderMessageIndex } from "./mailSemanticAdmissionIndexes";

export const mailSemanticAdmissionTables = {
  mailSemanticAdmissions: defineTable({
    workspaceId: v.id("workspaces"),
    provider: v.literal("gmail"),
    mailboxBindingId: v.string(),
    providerMessageId: v.string(),
    providerThreadId: v.string(),
    threadId: v.string(),
    admissionId: v.string(),
    messageContentFingerprint: v.string(),
    admissionFingerprint: v.string(),
    admissionJson: v.string(),
    createdAt: v.number(),
  })
    .index(mailSemanticAdmissionProviderMessageIndex, [
      "workspaceId",
      "provider",
      "mailboxBindingId",
      "providerMessageId",
    ])
    .index("by_workspace_id_and_thread_id_and_created_at", [
      "workspaceId",
      "threadId",
      "createdAt",
    ]),
};
