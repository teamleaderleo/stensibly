import { v } from "convex/values";
import type { ApplicationWorkBindingV1 } from "../src/application-lane-binding";
import {
  ApplicationLaneBindingConflictError,
  ApplicationLaneBindingNotFoundError,
  ApplicationLaneBindingStorageError,
  admitBindApplicationLaneCommand,
  admitRetireApplicationLaneBindingCommand,
  canonicalApplicationWorkBindingInputJson,
  exactApplicationLaneBindingId,
  exactApplicationLaneBindingItemId,
  exactApplicationLaneBindingProjectReadLimit,
  parseApplicationWorkBindingInputJson,
  retireApplicationWorkBinding,
} from "../src/application-lane-binding-store";
import {
  assertSlug,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
  type ItemId,
  type ProjectId,
  type QueryContext,
  type WorkspaceId,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import { serviceArgs } from "./lib/validators";

interface ResolvedProject {
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  projectSlug: string;
}

type StoredBindingRow = {
  workspaceId: unknown;
  projectId: unknown;
  itemId: ItemId;
  itemExternalId: string;
  externalId: string;
  generation: number;
  provider: string;
  laneRef: string;
  laneGeneration: number;
  status: string;
  bindingJson: string;
  bindingFingerprint: string;
  isCurrent: boolean;
  idempotencyKey: string;
  requestJson: string;
  recordedAt: number;
};

export const bind = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    bindingJson: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project);
    const binding = bindingForProject(args.bindingJson, scope.projectSlug);
    const command = admitBindApplicationLaneCommand({
      binding: JSON.parse(canonicalApplicationWorkBindingInputJson(binding)),
      idempotencyKey: args.idempotencyKey,
    });
    const replay = await bindingByIdempotency(
      ctx,
      scope.workspaceId,
      command.idempotencyKey,
    );
    if (replay) {
      if (replay.requestJson !== command.requestJson) {
        throw new Error("APPLICATION_LANE_BINDING_IDEMPOTENCY_CONFLICT");
      }
      return canonicalApplicationWorkBindingInputJson(
        await admitStoredBinding(ctx, replay, scope),
      );
    }

    const item = await getItemByExternalId(
      ctx,
      scope.workspaceId,
      command.binding.itemId,
    );
    if (item.projectId !== scope.projectId) {
      throw new Error("APPLICATION_LANE_BINDING_ITEM_PROJECT_MISMATCH");
    }
    const existing = await currentBindingRow(
      ctx,
      scope.projectId,
      command.binding.id,
    );
    if (existing) {
      throw new Error("APPLICATION_LANE_BINDING_ID_ALREADY_EXISTS");
    }

    await ctx.db.insert("applicationLaneBindings", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      itemId: item._id,
      itemExternalId: command.binding.itemId,
      externalId: command.binding.id,
      generation: command.binding.generation,
      provider: "elatura",
      laneRef: command.binding.laneRef,
      laneGeneration: command.binding.laneGeneration,
      status: "active",
      bindingJson: command.bindingInputJson,
      bindingFingerprint: command.binding.fingerprint,
      isCurrent: true,
      idempotencyKey: command.idempotencyKey,
      requestJson: command.requestJson,
      recordedAt: Date.parse(command.binding.createdAt),
    });

    const stored = await currentBindingRow(
      ctx,
      scope.projectId,
      command.binding.id,
    );
    if (!stored) throw new Error("APPLICATION_LANE_BINDING_MISSING");
    return canonicalApplicationWorkBindingInputJson(
      await admitStoredBinding(ctx, stored, scope),
    );
  },
});

export const get = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    bindingId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project, false);
    if (!scope) return null;
    const bindingId = exactApplicationLaneBindingId(args.bindingId);
    const row = await currentBindingRow(ctx, scope.projectId, bindingId);
    if (!row) return null;
    return canonicalApplicationWorkBindingInputJson(
      await admitStoredBinding(ctx, row, scope),
    );
  },
});

export const listCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    itemId: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project, false);
    if (!scope) return [];
    const itemExternalId = exactApplicationLaneBindingItemId(args.itemId);
    const item = await ctx.db
      .query("items")
      .withIndex("by_workspace_external", (q) =>
        q.eq("workspaceId", scope.workspaceId).eq("externalId", itemExternalId)
      )
      .unique();
    if (!item || item.projectId !== scope.projectId) return [];
    const rows = await ctx.db
      .query("applicationLaneBindings")
      .withIndex("by_item_id_and_status_and_is_current_and_generation", (q) =>
        q.eq("itemId", item._id)
          .eq("status", "active")
          .eq("isCurrent", true)
      )
      .order("asc")
      .collect();
    return await Promise.all(rows.map(async (row) =>
      canonicalApplicationWorkBindingInputJson(
        await admitStoredBinding(ctx, row, scope),
      )
    ));
  },
});

export const listProjectCurrent = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    limit: v.number(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const limit = exactApplicationLaneBindingProjectReadLimit(args.limit);
    const scope = await resolveProject(ctx, args.workspace, args.project, false);
    if (!scope) return [];
    const rows = await ctx.db
      .query("applicationLaneBindings")
      .withIndex("by_project_current_item_binding", (q) =>
        q.eq("projectId", scope.projectId)
          .eq("status", "active")
          .eq("isCurrent", true)
      )
      .order("asc")
      .take(limit + 1);
    return await Promise.all(rows.map(async (row) =>
      canonicalApplicationWorkBindingInputJson(
        await admitStoredBinding(ctx, row, scope),
      )
    ));
  },
});

export const history = query({
  args: {
    ...serviceArgs,
    project: v.string(),
    bindingId: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project, false);
    if (!scope) return [];
    const bindingId = exactApplicationLaneBindingId(args.bindingId);
    const rows = await ctx.db
      .query("applicationLaneBindings")
      .withIndex("by_project_id_and_external_id_and_generation", (q) =>
        q.eq("projectId", scope.projectId).eq("externalId", bindingId)
      )
      .order("asc")
      .collect();
    return await Promise.all(rows.map(async (row) =>
      canonicalApplicationWorkBindingInputJson(
        await admitStoredBinding(ctx, row, scope),
      )
    ));
  },
});

export const retire = mutation({
  args: {
    ...serviceArgs,
    project: v.string(),
    bindingId: v.string(),
    expectedGeneration: v.number(),
    retiredAt: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const scope = await resolveProject(ctx, args.workspace, args.project);
    const command = admitRetireApplicationLaneBindingCommand({
      project: scope.projectSlug,
      bindingId: args.bindingId,
      expectedGeneration: args.expectedGeneration,
      retiredAt: args.retiredAt,
      idempotencyKey: args.idempotencyKey,
    });
    const replay = await bindingByIdempotency(
      ctx,
      scope.workspaceId,
      command.idempotencyKey,
    );
    if (replay) {
      if (replay.requestJson !== command.requestJson) {
        throw new Error("APPLICATION_LANE_BINDING_IDEMPOTENCY_CONFLICT");
      }
      return canonicalApplicationWorkBindingInputJson(
        await admitStoredBinding(ctx, replay, scope),
      );
    }

    const currentRow = await currentBindingRow(
      ctx,
      scope.projectId,
      command.bindingId,
    );
    if (!currentRow) {
      throw new Error("APPLICATION_LANE_BINDING_NOT_FOUND");
    }
    const current = await admitStoredBinding(ctx, currentRow, scope);
    let retired: ApplicationWorkBindingV1;
    try {
      retired = retireApplicationWorkBinding(current, command);
    } catch (error) {
      if (
        error instanceof ApplicationLaneBindingConflictError
        || error instanceof ApplicationLaneBindingNotFoundError
      ) {
        throw new Error("APPLICATION_LANE_BINDING_CONFLICT");
      }
      throw error;
    }

    await ctx.db.patch(currentRow._id, { isCurrent: false });
    await ctx.db.insert("applicationLaneBindings", {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      itemId: currentRow.itemId,
      itemExternalId: current.itemId,
      externalId: retired.id,
      generation: retired.generation,
      provider: "elatura",
      laneRef: retired.laneRef,
      laneGeneration: retired.laneGeneration,
      status: "retired",
      bindingJson: canonicalApplicationWorkBindingInputJson(retired),
      bindingFingerprint: retired.fingerprint,
      isCurrent: true,
      idempotencyKey: command.idempotencyKey,
      requestJson: command.requestJson,
      recordedAt: Date.parse(command.retiredAt),
    });

    const stored = await currentBindingRow(
      ctx,
      scope.projectId,
      retired.id,
    );
    if (!stored) throw new Error("APPLICATION_LANE_BINDING_MISSING");
    return canonicalApplicationWorkBindingInputJson(
      await admitStoredBinding(ctx, stored, scope),
    );
  },
});

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
    throw new Error("APPLICATION_LANE_BINDING_WORKSPACE_NOT_FOUND");
  }
  const projectSlug = assertSlug(projectInput, "Project");
  const project = await findProject(ctx, workspace._id, projectSlug);
  if (!project) {
    if (!required) return null;
    throw new Error("APPLICATION_LANE_BINDING_PROJECT_NOT_FOUND");
  }
  return {
    workspaceId: workspace._id,
    projectId: project._id,
    projectSlug,
  };
}

function bindingForProject(
  bindingJson: string,
  project: string,
): ApplicationWorkBindingV1 {
  const binding = parseApplicationWorkBindingInputJson(bindingJson);
  if (binding.project !== project) {
    throw new Error("APPLICATION_LANE_BINDING_PROJECT_MISMATCH");
  }
  return binding;
}

async function bindingByIdempotency(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
) {
  return await ctx.db
    .query("applicationLaneBindings")
    .withIndex("by_workspace_id_and_idempotency_key", (q) =>
      q.eq("workspaceId", workspaceId).eq("idempotencyKey", idempotencyKey)
    )
    .unique();
}

async function currentBindingRow(
  ctx: QueryContext,
  projectId: ProjectId,
  bindingId: string,
) {
  return await ctx.db
    .query("applicationLaneBindings")
    .withIndex("by_project_id_and_external_id_and_is_current", (q) =>
      q.eq("projectId", projectId)
        .eq("externalId", bindingId)
        .eq("isCurrent", true)
    )
    .unique();
}

async function admitStoredBinding(
  ctx: QueryContext,
  row: StoredBindingRow,
  scope: ResolvedProject,
): Promise<ApplicationWorkBindingV1> {
  let binding: ApplicationWorkBindingV1;
  try {
    binding = parseApplicationWorkBindingInputJson(row.bindingJson);
  } catch {
    throw new ApplicationLaneBindingStorageError();
  }
  const item = await ctx.db.get(row.itemId);
  const recordedAt = binding.retiredAt === null
    ? Date.parse(binding.createdAt)
    : Date.parse(binding.retiredAt);
  const valid = row.workspaceId === scope.workspaceId
    && row.projectId === scope.projectId
    && item !== null
    && item.workspaceId === scope.workspaceId
    && item.projectId === scope.projectId
    && item.externalId === binding.itemId
    && row.itemExternalId === binding.itemId
    && row.externalId === binding.id
    && row.generation === binding.generation
    && row.provider === "elatura"
    && row.laneRef === binding.laneRef
    && row.laneGeneration === binding.laneGeneration
    && row.status === (binding.retiredAt === null ? "active" : "retired")
    && row.bindingFingerprint === binding.fingerprint
    && typeof row.isCurrent === "boolean"
    && typeof row.idempotencyKey === "string"
    && row.idempotencyKey.length > 0
    && typeof row.requestJson === "string"
    && row.requestJson.length > 0
    && row.recordedAt === recordedAt;
  if (!valid) throw new ApplicationLaneBindingStorageError();
  return binding;
}
