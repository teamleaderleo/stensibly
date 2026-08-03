import { v } from "convex/values";
import {
  admitGitHubRepositoryWriteReceipt,
  canonicalGitHubRepositoryWriteReceiptJson,
  fingerprintGitHubRepositoryWriteReceipt,
  parseGitHubRepositoryWriteReceiptJson,
} from "../src/github-repository-write-receipt-admission";
import type {
  GitHubRepositoryWriteReceipt,
} from "../src/github-repository-write-provider-service";
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
  v.literal("blocked"),
);
const reservationResult = v.object({
  outcome: reservationOutcome,
  receiptJson: v.string(),
});
const transitionAction = v.union(
  v.literal("reject_and_release"),
  v.literal("hold_for_reconciliation"),
  v.literal("record_verified"),
  v.literal("hold_verified_for_reconciliation"),
  v.literal("release_verified"),
);

type TransitionAction =
  | "reject_and_release"
  | "hold_for_reconciliation"
  | "record_verified"
  | "hold_verified_for_reconciliation"
  | "release_verified";

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
    if (
      requested.state !== "reserved"
      || requested.dispatchCount !== 0
      || requested.verified !== null
      || requested.error !== null
    ) {
      throw new Error("GITHUB_REPOSITORY_WRITE_RESERVATION_INVALID");
    }

    const currentRow = await ctx.db
      .query("githubRepositoryWriteReceipts")
      .withIndex("by_project_idempotency", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("idempotencyKey", requested.idempotencyKey)
      )
      .unique();
    if (currentRow) {
      const current = admitStoredReceipt(currentRow, scope);
      return {
        outcome: sameRequest(current, requested)
          ? "replay" as const
          : "conflict" as const,
        receiptJson: canonicalGitHubRepositoryWriteReceiptJson(current),
      };
    }

    const laneRow = await ctx.db
      .query("githubRepositoryWriteLanes")
      .withIndex("by_project_ref", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("repositoryFullName", requested.repositoryFullName)
          .eq("targetRef", requested.targetRef)
      )
      .unique();
    if (laneRow) {
      const ownerRow = await ctx.db
        .query("githubRepositoryWriteReceipts")
        .withIndex("by_project_external", (q) =>
          q.eq("projectId", scope.projectId)
            .eq("externalId", laneRow.ownerReceiptExternalId)
        )
        .unique();
      if (!ownerRow) throw new Error("GITHUB_REPOSITORY_WRITE_LANE_OWNER_MISSING");
      const owner = admitStoredReceipt(ownerRow, scope);
      admitStoredLane(laneRow, scope, owner);
      if (!blocksLane(owner)) {
        throw new Error("GITHUB_REPOSITORY_WRITE_TERMINAL_LANE_RETAINED");
      }
      return {
        outcome: "blocked" as const,
        receiptJson: canonicalGitHubRepositoryWriteReceiptJson(owner),
      };
    }

    const receiptJson = canonicalGitHubRepositoryWriteReceiptJson(requested);
    const receiptId = await ctx.db.insert("githubRepositoryWriteReceipts", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      externalId: requested.id,
      idempotencyKey: requested.idempotencyKey,
      repositoryFullName: requested.repositoryFullName,
      targetRef: requested.targetRef,
      state: requested.state,
      receiptJson,
      receiptSha256: fingerprintGitHubRepositoryWriteReceipt(requested),
      createdAt: Date.parse(requested.createdAt),
      updatedAt: Date.parse(requested.updatedAt),
    });
    await ctx.db.insert("githubRepositoryWriteLanes", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      repositoryFullName: requested.repositoryFullName,
      targetRef: requested.targetRef,
      ownerReceiptExternalId: requested.id,
      expectedParentSha: requested.expectedParentSha,
      createdAt: Date.parse(requested.createdAt),
      updatedAt: Date.parse(requested.updatedAt),
    });
    const inserted = await ctx.db.get(receiptId);
    if (!inserted) throw new Error("GITHUB_REPOSITORY_WRITE_RECEIPT_MISSING");
    return {
      outcome: "reserved" as const,
      receiptJson: canonicalGitHubRepositoryWriteReceiptJson(
        admitStoredReceipt(inserted, scope),
      ),
    };
  },
});

export const transition = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    action: transitionAction,
    currentReceiptJson: v.string(),
    nextReceiptJson: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project);
    const currentInput = receiptForProject(
      args.currentReceiptJson,
      scope.projectSlug,
    );
    const nextInput = receiptForProject(args.nextReceiptJson, scope.projectSlug);
    const row = await ctx.db
      .query("githubRepositoryWriteReceipts")
      .withIndex("by_project_idempotency", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("idempotencyKey", currentInput.idempotencyKey)
      )
      .unique();
    if (!row) throw new Error("GITHUB_REPOSITORY_WRITE_NOT_RESERVED");
    const stored = admitStoredReceipt(row, scope);
    if (!validCurrentTransitionView(stored, currentInput)) {
      throw new Error("GITHUB_REPOSITORY_WRITE_STALE_TRANSITION");
    }
    if (Date.parse(nextInput.updatedAt) < Date.parse(currentInput.updatedAt)) {
      throw new Error("GITHUB_REPOSITORY_WRITE_TRANSITION_TIME_REGRESSION");
    }
    const expected = expectedTransition(args.action, currentInput, nextInput);
    if (
      canonicalGitHubRepositoryWriteReceiptJson(expected)
      !== canonicalGitHubRepositoryWriteReceiptJson(nextInput)
    ) {
      throw new Error("GITHUB_REPOSITORY_WRITE_TRANSITION_INVALID");
    }

    const laneRow = await ctx.db
      .query("githubRepositoryWriteLanes")
      .withIndex("by_project_ref", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("repositoryFullName", stored.repositoryFullName)
          .eq("targetRef", stored.targetRef)
      )
      .unique();
    if (!laneRow) throw new Error("GITHUB_REPOSITORY_WRITE_LANE_MISSING");
    admitStoredLane(laneRow, scope, stored);

    const receiptJson = canonicalGitHubRepositoryWriteReceiptJson(expected);
    await ctx.db.patch(row._id, {
      state: expected.state,
      receiptJson,
      receiptSha256: fingerprintGitHubRepositoryWriteReceipt(expected),
      updatedAt: Date.parse(expected.updatedAt),
    });
    if (args.action === "reject_and_release" || args.action === "release_verified") {
      await ctx.db.delete(laneRow._id);
    } else {
      await ctx.db.patch(laneRow._id, {
        updatedAt: Date.parse(expected.updatedAt),
      });
    }
    const updated = await ctx.db.get(row._id);
    if (!updated) throw new Error("GITHUB_REPOSITORY_WRITE_RECEIPT_MISSING");
    return canonicalGitHubRepositoryWriteReceiptJson(
      admitStoredReceipt(updated, scope),
    );
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
      .query("githubRepositoryWriteReceipts")
      .withIndex("by_project_idempotency", (q) =>
        q.eq("projectId", scope.projectId).eq("idempotencyKey", idempotencyKey)
      )
      .unique();
    return row
      ? canonicalGitHubRepositoryWriteReceiptJson(admitStoredReceipt(row, scope))
      : null;
  },
});

function expectedTransition(
  action: TransitionAction,
  current: GitHubRepositoryWriteReceipt,
  proposed: GitHubRepositoryWriteReceipt,
): GitHubRepositoryWriteReceipt {
  if (!sameReservationIdentity(current, proposed)) {
    throw new Error("GITHUB_REPOSITORY_WRITE_TRANSITION_IDENTITY_MISMATCH");
  }
  if (action === "reject_and_release") {
    return admitGitHubRepositoryWriteReceipt({
      ...current,
      state: "rejected",
      updatedAt: proposed.updatedAt,
      error: {
        code: proposed.error?.code,
        retry: "do_not_retry",
      },
    });
  }
  if (action === "hold_for_reconciliation") {
    return admitGitHubRepositoryWriteReceipt({
      ...current,
      state: "pending_reconciliation",
      updatedAt: proposed.updatedAt,
      error: {
        code: proposed.error?.code,
        retry: "reconcile_before_retry",
      },
    });
  }
  if (action === "record_verified") {
    return admitGitHubRepositoryWriteReceipt({
      ...current,
      state: "verified_pending_release",
      dispatchCount: 1,
      updatedAt: proposed.verified?.verifiedAt,
      verified: proposed.verified,
      error: {
        code: "repository_write_settlement_incomplete",
        retry: "reconcile_before_retry",
      },
    });
  }
  if (action === "hold_verified_for_reconciliation") {
    return admitGitHubRepositoryWriteReceipt({
      ...current,
      state: "verified_pending_release",
      dispatchCount: 1,
      updatedAt: proposed.updatedAt,
      verified: proposed.verified,
      error: {
        code: proposed.error?.code,
        retry: "reconcile_before_retry",
      },
    });
  }
  if (current.state !== "verified_pending_release" || current.verified === null) {
    throw new Error("GITHUB_REPOSITORY_WRITE_RELEASE_NOT_VERIFIED");
  }
  return admitGitHubRepositoryWriteReceipt({
    ...current,
    state: "succeeded",
    updatedAt: proposed.updatedAt,
    error: null,
  });
}

function validCurrentTransitionView(
  stored: GitHubRepositoryWriteReceipt,
  candidate: GitHubRepositoryWriteReceipt,
): boolean {
  if (!sameReservationIdentity(stored, candidate)) return false;
  if (
    stored.state === "reserved"
    && stored.dispatchCount === 0
    && candidate.state === "reserved"
    && candidate.dispatchCount === 1
    && candidate.updatedAt === stored.updatedAt
    && candidate.verified === null
    && candidate.error === null
  ) {
    return true;
  }
  return canonicalGitHubRepositoryWriteReceiptJson(stored)
    === canonicalGitHubRepositoryWriteReceiptJson(candidate);
}

function receiptForProject(
  receiptJson: string,
  project: string,
): GitHubRepositoryWriteReceipt {
  const receipt = parseGitHubRepositoryWriteReceiptJson(receiptJson);
  if (receipt.project !== project) {
    throw new Error("GITHUB_REPOSITORY_WRITE_PROJECT_MISMATCH");
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
    targetRef: string;
    state: string;
    receiptJson: string;
    receiptSha256: string;
    createdAt: number;
    updatedAt: number;
  },
  scope: ResolvedProject,
): GitHubRepositoryWriteReceipt {
  const receipt = receiptForProject(row.receiptJson, scope.projectSlug);
  if (
    row.workspaceId !== scope.workspaceId
    || row.projectId !== scope.projectId
    || row.externalId !== receipt.id
    || row.idempotencyKey !== receipt.idempotencyKey
    || row.repositoryFullName !== receipt.repositoryFullName
    || row.targetRef !== receipt.targetRef
    || row.state !== receipt.state
    || row.receiptSha256 !== fingerprintGitHubRepositoryWriteReceipt(receipt)
    || row.createdAt !== Date.parse(receipt.createdAt)
    || row.updatedAt !== Date.parse(receipt.updatedAt)
  ) {
    throw new Error("GITHUB_REPOSITORY_WRITE_STORED_ROW_INVALID");
  }
  return receipt;
}

function admitStoredLane(
  row: {
    workspaceId: unknown;
    projectId: unknown;
    repositoryFullName: string;
    targetRef: string;
    ownerReceiptExternalId: string;
    expectedParentSha: string;
    createdAt: number;
    updatedAt: number;
  },
  scope: ResolvedProject,
  owner: GitHubRepositoryWriteReceipt,
): void {
  if (
    row.workspaceId !== scope.workspaceId
    || row.projectId !== scope.projectId
    || row.repositoryFullName !== owner.repositoryFullName
    || row.targetRef !== owner.targetRef
    || row.ownerReceiptExternalId !== owner.id
    || row.expectedParentSha !== owner.expectedParentSha
    || row.createdAt !== Date.parse(owner.createdAt)
    || row.updatedAt !== Date.parse(owner.updatedAt)
  ) {
    throw new Error("GITHUB_REPOSITORY_WRITE_LANE_INVALID");
  }
}

function blocksLane(receipt: GitHubRepositoryWriteReceipt): boolean {
  return receipt.state === "reserved"
    || receipt.state === "pending_reconciliation"
    || receipt.state === "verified_pending_release";
}

function sameRequest(
  current: GitHubRepositoryWriteReceipt,
  candidate: GitHubRepositoryWriteReceipt,
): boolean {
  return current.requestSha256 === candidate.requestSha256
    && current.payloadSha256 === candidate.payloadSha256
    && current.repositoryFullName === candidate.repositoryFullName
    && current.targetRef === candidate.targetRef
    && current.path === candidate.path
    && current.operation === candidate.operation
    && current.expectedParentSha === candidate.expectedParentSha
    && current.actorId === candidate.actorId
    && current.clientId === candidate.clientId;
}

function sameReservationIdentity(
  current: GitHubRepositoryWriteReceipt,
  candidate: GitHubRepositoryWriteReceipt,
): boolean {
  return current.version === candidate.version
    && current.id === candidate.id
    && current.project === candidate.project
    && current.repositoryFullName === candidate.repositoryFullName
    && current.targetRef === candidate.targetRef
    && current.path === candidate.path
    && current.operation === candidate.operation
    && current.expectedParentSha === candidate.expectedParentSha
    && current.requestSha256 === candidate.requestSha256
    && current.payloadSha256 === candidate.payloadSha256
    && current.actorId === candidate.actorId
    && current.clientId === candidate.clientId
    && current.idempotencyKey === candidate.idempotencyKey
    && current.createdAt === candidate.createdAt;
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
    throw new Error("GITHUB_REPOSITORY_WRITE_WORKSPACE_NOT_FOUND");
  }
  const projectSlug = assertSlug(projectInput, "Project");
  const project = await findProject(ctx, workspace._id, projectSlug);
  if (!project) {
    if (!required) return null;
    throw new Error("GITHUB_REPOSITORY_WRITE_PROJECT_NOT_FOUND");
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
    throw new RangeError("GitHub repository write idempotency key is invalid");
  }
  return value;
}
