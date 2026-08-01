import { v } from "convex/values";
import type { GitHubProviderReceipt } from "../src/github-provider-contracts";
import {
  canonicalGitHubProviderReceiptJson,
  fingerprintGitHubProviderReceipt,
  interruptedGitHubProviderReceipt,
  parseGitHubProviderReceiptJson,
} from "../src/github-provider-receipt-admission";
import {
  assertSlug,
  findProject,
  findWorkspace,
  normalizeWorkspace,
  requireServiceSecret,
  type ProjectId,
  type QueryContext,
  type WorkspaceId,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

const reservationOutcome = v.union(
  v.literal("reserved"),
  v.literal("replay"),
  v.literal("conflict"),
);
const reservationResult = v.object({
  outcome: reservationOutcome,
  receiptJson: v.string(),
});

interface ResolvedProject {
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  projectSlug: string;
}

export const reserve = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    receiptJson: v.string(),
  },
  returns: reservationResult,
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project);
    const requested = receiptForProject(args.receiptJson, scope.projectSlug);
    const currentRow = await ctx.db
      .query("githubProviderReceipts")
      .withIndex("by_project_idempotency", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("idempotencyKey", requested.idempotencyKey)
      )
      .unique();

    if (!currentRow) {
      const receiptJson = canonicalGitHubProviderReceiptJson(requested);
      const id = await ctx.db.insert("githubProviderReceipts", {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        externalId: requested.id,
        idempotencyKey: requested.idempotencyKey,
        repositoryFullName: requested.repositoryFullName,
        operation: requested.operation,
        actorId: requested.actorId,
        clientId: requested.clientId,
        parametersSha256: requested.parametersSha256,
        state: requested.state,
        receiptJson,
        receiptSha256: fingerprintGitHubProviderReceipt(requested),
        createdAt: Date.parse(requested.createdAt),
        updatedAt: Date.parse(requested.updatedAt),
      });
      const inserted = await ctx.db.get("githubProviderReceipts", id);
      if (!inserted) throw new Error("GITHUB_PROVIDER_RECEIPT_MISSING");
      const admitted = admitStoredReceipt(
        inserted,
        scope.workspaceId,
        scope.projectId,
        scope.projectSlug,
      );
      return {
        outcome: "reserved" as const,
        receiptJson: canonicalGitHubProviderReceiptJson(admitted),
      };
    }

    const current = admitStoredReceipt(
      currentRow,
      scope.workspaceId,
      scope.projectId,
      scope.projectSlug,
    );
    const sameRequest = sameReplayIdentity(current, requested);
    if (sameRequest && current.state === "reserved") {
      const pending = interruptedGitHubProviderReceipt(current);
      const receiptJson = canonicalGitHubProviderReceiptJson(pending);
      await ctx.db.patch(currentRow._id, {
        state: pending.state,
        receiptJson,
        receiptSha256: fingerprintGitHubProviderReceipt(pending),
        updatedAt: Date.parse(pending.updatedAt),
      });
      const updated = await ctx.db.get("githubProviderReceipts", currentRow._id);
      if (!updated) throw new Error("GITHUB_PROVIDER_RECEIPT_MISSING");
      return {
        outcome: "replay" as const,
        receiptJson: canonicalGitHubProviderReceiptJson(admitStoredReceipt(
          updated,
          scope.workspaceId,
          scope.projectId,
          scope.projectSlug,
        )),
      };
    }
    return {
      outcome: sameRequest ? "replay" as const : "conflict" as const,
      receiptJson: canonicalGitHubProviderReceiptJson(current),
    };
  },
});

export const update = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    receiptJson: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project);
    const requested = receiptForProject(args.receiptJson, scope.projectSlug);
    const currentRow = await ctx.db
      .query("githubProviderReceipts")
      .withIndex("by_project_idempotency", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("idempotencyKey", requested.idempotencyKey)
      )
      .unique();
    if (!currentRow) {
      throw new Error("GITHUB_PROVIDER_RECEIPT_NOT_RESERVED");
    }
    const current = admitStoredReceipt(
      currentRow,
      scope.workspaceId,
      scope.projectId,
      scope.projectSlug,
    );
    if (!sameReservationIdentity(current, requested)) {
      throw new Error("GITHUB_PROVIDER_RECEIPT_UPDATE_IDENTITY_MISMATCH");
    }
    const receiptJson = canonicalGitHubProviderReceiptJson(requested);
    await ctx.db.patch(currentRow._id, {
      state: requested.state,
      receiptJson,
      receiptSha256: fingerprintGitHubProviderReceipt(requested),
      updatedAt: Date.parse(requested.updatedAt),
    });
    const updated = await ctx.db.get("githubProviderReceipts", currentRow._id);
    if (!updated) throw new Error("GITHUB_PROVIDER_RECEIPT_MISSING");
    return canonicalGitHubProviderReceiptJson(admitStoredReceipt(
      updated,
      scope.workspaceId,
      scope.projectId,
      scope.projectSlug,
    ));
  },
});

export const get = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project, false);
    if (!scope) return null;
    const idempotencyKey = boundedIdempotencyKey(args.idempotencyKey);
    const row = await ctx.db
      .query("githubProviderReceipts")
      .withIndex("by_project_idempotency", (q) =>
        q.eq("projectId", scope.projectId).eq("idempotencyKey", idempotencyKey)
      )
      .unique();
    return row
      ? canonicalGitHubProviderReceiptJson(admitStoredReceipt(
        row,
        scope.workspaceId,
        scope.projectId,
        scope.projectSlug,
      ))
      : null;
  },
});

function receiptForProject(
  receiptJson: string,
  project: string,
): GitHubProviderReceipt {
  const receipt = parseGitHubProviderReceiptJson(receiptJson);
  if (receipt.project !== project) {
    throw new Error("GITHUB_PROVIDER_RECEIPT_PROJECT_MISMATCH");
  }
  return receipt;
}

function admitStoredReceipt(
  row: {
    workspaceId: unknown;
    projectId: unknown;
    externalId: string;
    idempotencyKey: string;
    repositoryFullName: string;
    operation: string;
    actorId: string;
    clientId: string;
    parametersSha256: string;
    state: string;
    receiptJson: string;
    receiptSha256: string;
    createdAt: number;
    updatedAt: number;
  },
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  project: string,
): GitHubProviderReceipt {
  const receipt = receiptForProject(row.receiptJson, project);
  if (
    row.workspaceId !== workspaceId
    || row.projectId !== projectId
    || row.externalId !== receipt.id
    || row.idempotencyKey !== receipt.idempotencyKey
    || row.repositoryFullName !== receipt.repositoryFullName
    || row.operation !== receipt.operation
    || row.actorId !== receipt.actorId
    || row.clientId !== receipt.clientId
    || row.parametersSha256 !== receipt.parametersSha256
    || row.state !== receipt.state
    || row.receiptSha256 !== fingerprintGitHubProviderReceipt(receipt)
    || row.createdAt !== Date.parse(receipt.createdAt)
    || row.updatedAt !== Date.parse(receipt.updatedAt)
  ) {
    throw new Error("GITHUB_PROVIDER_RECEIPT_STORED_ROW_INVALID");
  }
  return receipt;
}

function sameReplayIdentity(
  current: GitHubProviderReceipt,
  candidate: GitHubProviderReceipt,
): boolean {
  return current.version === candidate.version
    && current.project === candidate.project
    && current.provider === candidate.provider
    && current.repositoryFullName === candidate.repositoryFullName
    && current.operation === candidate.operation
    && current.target === candidate.target
    && current.actorId === candidate.actorId
    && current.clientId === candidate.clientId
    && current.connectionId === candidate.connectionId
    && current.installationId === candidate.installationId
    && current.bindingId === candidate.bindingId
    && current.attachmentId === candidate.attachmentId
    && current.attachmentSnapshotSha256
      === candidate.attachmentSnapshotSha256
    && current.capabilityGrantId === candidate.capabilityGrantId
    && current.approvalId === candidate.approvalId
    && current.idempotencyKey === candidate.idempotencyKey
    && current.parametersSha256 === candidate.parametersSha256;
}

function sameReservationIdentity(
  current: GitHubProviderReceipt,
  candidate: GitHubProviderReceipt,
): boolean {
  return current.id === candidate.id
    && current.createdAt === candidate.createdAt
    && sameReplayIdentity(current, candidate);
}

async function resolveProject(
  ctx: QueryContext,
  workspaceInput: string | undefined,
  projectInput: string,
  required?: true,
): Promise<ResolvedProject>;
async function resolveProject(
  ctx: QueryContext,
  workspaceInput: string | undefined,
  projectInput: string,
  required: false,
): Promise<ResolvedProject | null>;
async function resolveProject(
  ctx: QueryContext,
  workspaceInput: string | undefined,
  projectInput: string,
  required = true,
): Promise<ResolvedProject | null> {
  const workspaceSlug = normalizeWorkspace(workspaceInput);
  const workspace = await findWorkspace(ctx, workspaceSlug);
  if (!workspace) {
    if (!required) return null;
    throw new Error("GITHUB_PROVIDER_RECEIPT_WORKSPACE_NOT_FOUND");
  }
  const projectSlug = assertSlug(projectInput, "Project");
  const project = await findProject(ctx, workspace._id, projectSlug);
  if (!project) {
    if (!required) return null;
    throw new Error("GITHUB_PROVIDER_RECEIPT_PROJECT_NOT_FOUND");
  }
  return {
    workspaceId: workspace._id,
    projectId: project._id,
    projectSlug,
  };
}

function boundedIdempotencyKey(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 240
    || value.trim() !== value
  ) {
    throw new RangeError("GitHub provider idempotency key is invalid");
  }
  return value;
}
