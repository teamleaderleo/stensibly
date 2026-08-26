import { v } from "convex/values";
import {
  parseAccountUsageReservationReceipt,
  reconcileAccountUsage,
  reserveAccountUsage,
  settleAccountUsage,
  type AccountUsageReservationReceipt,
  type AccountUsageSubjectKind,
} from "../src/account-usage-reservation";
import {
  ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS,
  compileAccountUsageWindowEvidence,
} from "../src/account-usage-window";
import { containsRealisticRetainedCredential } from "../src/github-retained-credential-policy";
import {
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type MutationContext,
  type QueryContext,
  type WorkspaceId,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const subjectKindValidator = v.union(
  v.literal("account"),
  v.literal("authorization"),
);
const serviceClassValidator = v.union(
  v.literal("hosted_read"),
  v.literal("hosted_write"),
  v.literal("provider_backed_effect"),
);
const settlementOutcomeValidator = v.union(
  v.literal("consumed"),
  v.literal("released"),
  v.literal("ambiguous"),
);
const reconciliationOutcomeValidator = v.union(
  v.literal("consumed"),
  v.literal("released"),
);
const reservationResult = v.object({
  outcome: v.union(
    v.literal("reserved"),
    v.literal("replay"),
    v.literal("conflict"),
  ),
  receiptJson: v.string(),
});

const RECEIPT_JSON_MAX_BYTES = 8_192;
const EVIDENCE_JSON_MAX_BYTES = 8_192;
const boundedIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;

export const reserve = mutation({
  args: {
    ...serviceArgs,
    subjectKind: subjectKindValidator,
    subjectId: v.string(),
    serviceClass: serviceClassValidator,
    windowId: v.string(),
    requestIdentity: v.string(),
    units: v.number(),
    admissionDecisionFingerprint: v.string(),
    currentTime: v.string(),
  },
  returns: reservationResult,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveWorkspace(ctx, args.workspace);
    const requested = reserveAccountUsage({
      subject: {
        kind: args.subjectKind,
        id: args.subjectId,
        workspace: scope.workspaceSlug,
      },
      serviceClass: args.serviceClass,
      windowId: args.windowId,
      requestIdentity: args.requestIdentity,
      units: args.units,
      admissionDecisionFingerprint: args.admissionDecisionFingerprint,
      currentTime: args.currentTime,
    });
    const currentRow = await findReservationRow(
      ctx,
      scope.workspaceId,
      requested.subject.kind,
      requested.subject.id,
      requested.requestIdentity,
    );

    if (!currentRow) {
      const receiptJson = canonicalReceiptJson(requested);
      const id = await ctx.db.insert("accountUsageReservations", {
        workspaceId: scope.workspaceId,
        subjectKind: requested.subject.kind,
        subjectExternalId: requested.subject.id,
        requestIdentity: requested.requestIdentity,
        serviceClass: requested.serviceClass,
        windowId: requested.windowId,
        intentFingerprint: requested.intentFingerprint,
        state: requested.state,
        receiptJson,
        receiptFingerprint: requested.receiptFingerprint,
        reservedAt: Date.parse(requested.reservedAt),
        updatedAt: Date.parse(requested.updatedAt),
      });
      const inserted = await ctx.db.get("accountUsageReservations", id);
      if (!inserted) throw new Error("ACCOUNT_USAGE_RESERVATION_MISSING");
      return {
        outcome: "reserved" as const,
        receiptJson: canonicalReceiptJson(admitStoredReceipt(
          inserted,
          scope.workspaceId,
          scope.workspaceSlug,
        )),
      };
    }

    const current = admitStoredReceipt(
      currentRow,
      scope.workspaceId,
      scope.workspaceSlug,
    );
    try {
      const replay = reserveAccountUsage({
        subject: requested.subject,
        serviceClass: requested.serviceClass,
        windowId: requested.windowId,
        requestIdentity: requested.requestIdentity,
        units: requested.units,
        admissionDecisionFingerprint: requested.admissionDecisionFingerprint,
        currentTime: args.currentTime,
      }, current);
      return {
        outcome: "replay" as const,
        receiptJson: canonicalReceiptJson(replay),
      };
    } catch (error) {
      if (
        error instanceof Error
        && error.message === "Account usage reservation replay conflicts with the existing intent"
      ) {
        return {
          outcome: "conflict" as const,
          receiptJson: canonicalReceiptJson(current),
        };
      }
      throw error;
    }
  },
});

export const get = query({
  args: {
    ...serviceArgs,
    subjectKind: subjectKindValidator,
    subjectId: v.string(),
    requestIdentity: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveWorkspace(ctx, args.workspace, false);
    if (!scope) return null;
    const row = await findReservationRow(
      ctx,
      scope.workspaceId,
      args.subjectKind,
      args.subjectId,
      args.requestIdentity,
    );
    return row
      ? canonicalReceiptJson(admitStoredReceipt(
        row,
        scope.workspaceId,
        scope.workspaceSlug,
      ))
      : null;
  },
});

export const readWindow = query({
  args: {
    ...serviceArgs,
    subjectKind: subjectKindValidator,
    subjectId: v.string(),
    serviceClass: serviceClassValidator,
    windowId: v.string(),
    observedAt: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveWorkspace(ctx, args.workspace);
    const subjectId = boundedIdentity(args.subjectId, "usage subject id", 240);
    const windowId = boundedIdentity(args.windowId, "allowance window id", 240);
    const rows = await ctx.db
      .query("accountUsageReservations")
      .withIndex(
        "by_workspace_subject_window",
        (q) => q
          .eq("workspaceId", scope.workspaceId)
          .eq("subjectKind", args.subjectKind)
          .eq("subjectExternalId", subjectId)
          .eq("serviceClass", args.serviceClass)
          .eq("windowId", windowId),
      )
      .take(ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS + 1);
    if (rows.length > ACCOUNT_USAGE_WINDOW_MAX_RECEIPTS) {
      throw new Error("ACCOUNT_USAGE_WINDOW_TOO_LARGE");
    }
    const receipts = rows.map((row) => admitStoredReceipt(
      row,
      scope.workspaceId,
      scope.workspaceSlug,
    ));
    const evidence = compileAccountUsageWindowEvidence({
      subject: {
        kind: args.subjectKind,
        id: subjectId,
        workspace: scope.workspaceSlug,
      },
      serviceClass: args.serviceClass,
      windowId,
      observedAt: args.observedAt,
      receipts,
    });
    const json = JSON.stringify(evidence);
    if (json.length > EVIDENCE_JSON_MAX_BYTES) {
      throw new Error("ACCOUNT_USAGE_WINDOW_EVIDENCE_JSON_INVALID");
    }
    return json;
  },
});

export const settle = mutation({
  args: {
    ...serviceArgs,
    subjectKind: subjectKindValidator,
    subjectId: v.string(),
    requestIdentity: v.string(),
    outcome: settlementOutcomeValidator,
    settlementReference: v.string(),
    currentTime: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveWorkspace(ctx, args.workspace);
    const currentRow = await requireReservationRow(
      ctx,
      scope.workspaceId,
      args.subjectKind,
      args.subjectId,
      args.requestIdentity,
    );
    const current = admitStoredReceipt(
      currentRow,
      scope.workspaceId,
      scope.workspaceSlug,
    );
    const next = settleAccountUsage(current, {
      outcome: args.outcome,
      settlementReference: args.settlementReference,
      currentTime: args.currentTime,
    });
    return await persistTransition(
      ctx,
      currentRow,
      next,
      scope.workspaceId,
      scope.workspaceSlug,
    );
  },
});

export const reconcile = mutation({
  args: {
    ...serviceArgs,
    subjectKind: subjectKindValidator,
    subjectId: v.string(),
    requestIdentity: v.string(),
    outcome: reconciliationOutcomeValidator,
    reconciliationReference: v.string(),
    currentTime: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveWorkspace(ctx, args.workspace);
    const currentRow = await requireReservationRow(
      ctx,
      scope.workspaceId,
      args.subjectKind,
      args.subjectId,
      args.requestIdentity,
    );
    const current = admitStoredReceipt(
      currentRow,
      scope.workspaceId,
      scope.workspaceSlug,
    );
    const next = reconcileAccountUsage(current, {
      outcome: args.outcome,
      reconciliationReference: args.reconciliationReference,
      currentTime: args.currentTime,
    });
    return await persistTransition(
      ctx,
      currentRow,
      next,
      scope.workspaceId,
      scope.workspaceSlug,
    );
  },
});

interface ResolvedWorkspace {
  workspaceId: WorkspaceId;
  workspaceSlug: string;
}

async function resolveWorkspace(
  ctx: QueryContext,
  workspaceInput: string | undefined,
  required?: true,
): Promise<ResolvedWorkspace>;
async function resolveWorkspace(
  ctx: QueryContext,
  workspaceInput: string | undefined,
  required: false,
): Promise<ResolvedWorkspace | null>;
async function resolveWorkspace(
  ctx: QueryContext,
  workspaceInput: string | undefined,
  required = true,
): Promise<ResolvedWorkspace | null> {
  const workspaceSlug = normalizeWorkspace(workspaceInput);
  const workspace = await findWorkspace(ctx, workspaceSlug);
  if (!workspace) {
    if (!required) return null;
    throw new Error("ACCOUNT_USAGE_RESERVATION_WORKSPACE_NOT_FOUND");
  }
  return { workspaceId: workspace._id, workspaceSlug };
}

async function findReservationRow(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  subjectKind: AccountUsageSubjectKind,
  subjectIdInput: string,
  requestIdentityInput: string,
) {
  const subjectId = boundedIdentity(subjectIdInput, "usage subject id", 240);
  const requestIdentity = boundedIdentity(
    requestIdentityInput,
    "request identity",
    240,
  );
  return await ctx.db
    .query("accountUsageReservations")
    .withIndex(
      "by_workspace_subject_request",
      (q) => q
        .eq("workspaceId", workspaceId)
        .eq("subjectKind", subjectKind)
        .eq("subjectExternalId", subjectId)
        .eq("requestIdentity", requestIdentity),
    )
    .unique();
}

async function requireReservationRow(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  subjectKind: AccountUsageSubjectKind,
  subjectId: string,
  requestIdentity: string,
) {
  const row = await findReservationRow(
    ctx,
    workspaceId,
    subjectKind,
    subjectId,
    requestIdentity,
  );
  if (!row) throw new Error("ACCOUNT_USAGE_RESERVATION_NOT_FOUND");
  return row;
}

function admitStoredReceipt(
  row: {
    workspaceId: unknown;
    subjectKind: string;
    subjectExternalId: string;
    requestIdentity: string;
    serviceClass: string;
    windowId: string;
    intentFingerprint: string;
    state: string;
    receiptJson: string;
    receiptFingerprint: string;
    reservedAt: number;
    updatedAt: number;
  },
  workspaceId: WorkspaceId,
  workspaceSlug: string,
): AccountUsageReservationReceipt {
  const receipt = parseReceiptJson(row.receiptJson);
  if (
    row.workspaceId !== workspaceId
    || receipt.subject.workspace !== workspaceSlug
    || row.subjectKind !== receipt.subject.kind
    || row.subjectExternalId !== receipt.subject.id
    || row.requestIdentity !== receipt.requestIdentity
    || row.serviceClass !== receipt.serviceClass
    || row.windowId !== receipt.windowId
    || row.intentFingerprint !== receipt.intentFingerprint
    || row.state !== receipt.state
    || row.receiptFingerprint !== receipt.receiptFingerprint
    || row.reservedAt !== Date.parse(receipt.reservedAt)
    || row.updatedAt !== Date.parse(receipt.updatedAt)
    || row.receiptJson !== canonicalReceiptJson(receipt)
  ) {
    throw new Error("ACCOUNT_USAGE_RESERVATION_STORED_ROW_INVALID");
  }
  return receipt;
}

async function persistTransition(
  ctx: MutationContext,
  row: { _id: any },
  next: AccountUsageReservationReceipt,
  workspaceId: WorkspaceId,
  workspaceSlug: string,
): Promise<string> {
  const receiptJson = canonicalReceiptJson(next);
  await ctx.db.patch(row._id, {
    state: next.state,
    receiptJson,
    receiptFingerprint: next.receiptFingerprint,
    updatedAt: Date.parse(next.updatedAt),
  });
  const updated = await ctx.db.get("accountUsageReservations", row._id);
  if (!updated) throw new Error("ACCOUNT_USAGE_RESERVATION_MISSING");
  return canonicalReceiptJson(admitStoredReceipt(
    updated,
    workspaceId,
    workspaceSlug,
  ));
}

function parseReceiptJson(value: string): AccountUsageReservationReceipt {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > RECEIPT_JSON_MAX_BYTES
    || value.trim() !== value
  ) {
    throw new Error("ACCOUNT_USAGE_RESERVATION_JSON_INVALID");
  }
  try {
    return parseAccountUsageReservationReceipt(JSON.parse(value));
  } catch {
    throw new Error("ACCOUNT_USAGE_RESERVATION_JSON_INVALID");
  }
}

function canonicalReceiptJson(value: unknown): string {
  const receipt = parseAccountUsageReservationReceipt(value);
  const json = JSON.stringify(receipt);
  if (json.length > RECEIPT_JSON_MAX_BYTES) {
    throw new Error("ACCOUNT_USAGE_RESERVATION_JSON_INVALID");
  }
  return json;
}

function boundedIdentity(
  value: string,
  field: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || !boundedIdentityPattern.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError(`${field} cannot retain credential-like text`);
  }
  return value;
}
