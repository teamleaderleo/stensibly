import { defineTable } from "convex/server";
import { v } from "convex/values";

const subjectKind = v.union(
  v.literal("account"),
  v.literal("authorization"),
);
const serviceClass = v.union(
  v.literal("hosted_read"),
  v.literal("hosted_write"),
  v.literal("provider_backed_effect"),
);
const reservationState = v.union(
  v.literal("reserved"),
  v.literal("consumed"),
  v.literal("released"),
  v.literal("ambiguous"),
);

export const accountUsageTables = {
  accountUsageReservations: defineTable({
    workspaceId: v.id("workspaces"),
    subjectKind,
    subjectExternalId: v.string(),
    requestIdentity: v.string(),
    serviceClass,
    windowId: v.string(),
    intentFingerprint: v.string(),
    state: reservationState,
    receiptJson: v.string(),
    receiptFingerprint: v.string(),
    reservedAt: v.number(),
    updatedAt: v.number(),
  })
    .index(
      "by_workspace_subject_request",
      [
        "workspaceId",
        "subjectKind",
        "subjectExternalId",
        "requestIdentity",
      ],
    )
    .index(
      "by_workspace_subject_window",
      [
        "workspaceId",
        "subjectKind",
        "subjectExternalId",
        "serviceClass",
        "windowId",
      ],
    ),
};
