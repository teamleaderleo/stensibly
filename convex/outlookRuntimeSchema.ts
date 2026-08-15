import { defineTable } from "convex/server";
import { v } from "convex/values";

export const outlookRuntimeTables = {
  outlookRuntimeAuth: defineTable({
    workspaceId: v.id("workspaces"),
    mailboxBindingId: v.string(),
    sealedRefreshToken: v.string(),
    generation: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_workspace_id_and_mailbox_binding_id", [
    "workspaceId",
    "mailboxBindingId",
  ]),
};
