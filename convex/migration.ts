import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import {
  assertSlug,
  ensureProject,
  ensureWorkspace,
  findProject,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  requireServiceSecret,
} from "./lib/domain";
import { mutation } from "./lib/server";
import {
  actorKindValidator,
  artifactKindValidator,
  itemKindValidator,
  itemStatusValidator,
  serviceArgs,
} from "./lib/validators";

const expireClaimRef = makeFunctionReference<"mutation">("claims:expireScheduled");
const tokenScope = v.union(v.literal("read"), v.literal("write"), v.literal("admin"));

export const importProjectsActors = mutation({
  args: {
    ...serviceArgs,
    projects: v.array(v.object({
      id: v.string(),
      name: v.string(),
      createdAt: v.string(),
    })),
    actors: v.array(v.object({
      id: v.string(),
      name: v.string(),
      kind: actorKindValidator,
      updatedAt: v.string(),
    })),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await ensureWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Failed to create workspace");
    let projects = 0;
    let actors = 0;

    for (const source of args.projects) {
      const slug = assertSlug(source.id, "Project");
      const existing = await findProject(ctx, workspace._id, slug);
      const createdAt = timestamp(source.createdAt, `project ${source.id} createdAt`);
      if (existing) {
        await ctx.db.patch(existing._id, {
          name: source.name,
          createdAt,
          updatedAt: Math.max(existing.updatedAt, createdAt),
        });
      } else {
        await ctx.db.insert("projects", {
          workspaceId: workspace._id,
          externalId: `project_${workspaceSlug}_${slug}`,
          slug,
          name: source.name,
          createdAt,
          updatedAt: createdAt,
        });
      }
      projects += 1;
    }

    for (const source of args.actors) {
      const existing = await ctx.db
        .query("actors")
        .withIndex("by_workspace_external", (q) =>
          q.eq("workspaceId", workspace._id).eq("externalId", source.id),
        )
        .unique();
      const value = {
        name: source.name,
        kind: source.kind,
        updatedAt: timestamp(source.updatedAt, `actor ${source.id} updatedAt`),
      };
      if (existing) await ctx.db.patch(existing._id, value);
      else {
        await ctx.db.insert("actors", {
          workspaceId: workspace._id,
          externalId: source.id,
          ...value,
        });
      }
      actors += 1;
    }

    return { projects, actors };
  },
});

export const importItems = mutation({
  args: {
    ...serviceArgs,
    items: v.array(v.object({
      id: v.string(),
      projectId: v.string(),
      kind: itemKindValidator,
      title: v.string(),
      summary: v.union(v.string(), v.null()),
      status: itemStatusValidator,
      priority: v.number(),
      nextAction: v.union(v.string(), v.null()),
      claimedBy: v.union(v.string(), v.null()),
      claimExpiresAt: v.union(v.string(), v.null()),
      version: v.number(),
      createdAt: v.string(),
      updatedAt: v.string(),
    })),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspaceSlug = normalizeWorkspace(args.workspace);
    const workspace = await ensureWorkspace(ctx, workspaceSlug);
    if (!workspace) throw new Error("Failed to create workspace");
    let imported = 0;
    let liveClaims = 0;
    const now = Date.now();

    for (const source of args.items) {
      const projectSlug = assertSlug(source.projectId, "Project");
      const project = await ensureProject(ctx, workspace._id, workspaceSlug, projectSlug);
      if (!project) throw new Error(`Failed to create project ${projectSlug}`);
      const claimedActor = source.claimedBy
        ? await ctx.db
            .query("actors")
            .withIndex("by_workspace_external", (q) =>
              q.eq("workspaceId", workspace._id).eq("externalId", source.claimedBy!),
            )
            .unique()
        : null;
      if (source.claimedBy && !claimedActor) {
        throw new Error(`Item ${source.id} references missing actor ${source.claimedBy}`);
      }

      const requestedExpiry = source.claimExpiresAt
        ? timestamp(source.claimExpiresAt, `item ${source.id} claimExpiresAt`)
        : undefined;
      const claimIsLive = source.status === "active" && Boolean(
        claimedActor && requestedExpiry !== undefined && requestedExpiry > now,
      );
      const status = source.status === "active" && !claimIsLive ? "ready" : source.status;
      const existing = await ctx.db
        .query("items")
        .withIndex("by_workspace_external", (q) =>
          q.eq("workspaceId", workspace._id).eq("externalId", source.id),
        )
        .unique();
      const generation = (existing?.claimGeneration ?? 0) + 1;
      const value = {
        projectId: project._id,
        kind: source.kind,
        title: source.title,
        summary: source.summary ?? undefined,
        status,
        priority: source.priority,
        nextAction: source.nextAction ?? undefined,
        claimedByActorId: claimIsLive ? claimedActor!._id : undefined,
        claimedByExternalId: claimIsLive ? source.claimedBy! : undefined,
        claimExpiresAt: claimIsLive ? requestedExpiry : undefined,
        claimGeneration: generation,
        version: source.version,
        createdAt: timestamp(source.createdAt, `item ${source.id} createdAt`),
        updatedAt: timestamp(source.updatedAt, `item ${source.id} updatedAt`),
      };
      let itemId;
      if (existing) {
        await ctx.db.patch(existing._id, value);
        itemId = existing._id;
      } else {
        itemId = await ctx.db.insert("items", {
          workspaceId: workspace._id,
          externalId: source.id,
          ...value,
        });
      }
      if (claimIsLive && requestedExpiry !== undefined) {
        await ctx.scheduler.runAt(requestedExpiry, expireClaimRef, {
          itemId,
          generation,
        });
        liveClaims += 1;
      }
      imported += 1;
    }

    return { items: imported, liveClaims };
  },
});

export const importEvents = mutation({
  args: {
    ...serviceArgs,
    events: v.array(v.object({
      id: v.string(),
      itemId: v.string(),
      actorId: v.union(v.string(), v.null()),
      type: v.string(),
      payload: v.any(),
      idempotencyKey: v.union(v.string(), v.null()),
      createdAt: v.string(),
    })),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requireWorkspace(ctx, args.workspace);
    let inserted = 0;
    let skipped = 0;

    for (const source of args.events) {
      const existing = await ctx.db
        .query("events")
        .withIndex("by_external_id", (q) => q.eq("externalId", source.id))
        .unique();
      if (existing) {
        skipped += 1;
        continue;
      }
      if (source.idempotencyKey) {
        const idempotent = await ctx.db
          .query("events")
          .withIndex("by_workspace_idempotency", (q) =>
            q.eq("workspaceId", workspace._id).eq("idempotencyKey", source.idempotencyKey!),
          )
          .unique();
        if (idempotent) {
          skipped += 1;
          continue;
        }
      }
      const item = await getItemByExternalId(ctx, workspace._id, source.itemId);
      const actor = source.actorId
        ? await ctx.db
            .query("actors")
            .withIndex("by_workspace_external", (q) =>
              q.eq("workspaceId", workspace._id).eq("externalId", source.actorId!),
            )
            .unique()
        : null;
      if (source.actorId && !actor) {
        throw new Error(`Event ${source.id} references missing actor ${source.actorId}`);
      }
      await ctx.db.insert("events", {
        workspaceId: workspace._id,
        projectId: item.projectId,
        itemId: item._id,
        externalId: source.id,
        actorId: actor?._id,
        actorExternalId: source.actorId ?? undefined,
        type: source.type,
        payload: source.payload,
        idempotencyKey: source.idempotencyKey ?? undefined,
        createdAt: timestamp(source.createdAt, `event ${source.id} createdAt`),
      });
      inserted += 1;
    }
    return { inserted, skipped };
  },
});

export const importArtifacts = mutation({
  args: {
    ...serviceArgs,
    artifacts: v.array(v.object({
      id: v.string(),
      itemId: v.string(),
      actorId: v.string(),
      kind: artifactKindValidator,
      label: v.string(),
      uri: v.string(),
      mimeType: v.union(v.string(), v.null()),
      metadata: v.any(),
      createdAt: v.string(),
    })),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requireWorkspace(ctx, args.workspace);
    let inserted = 0;
    let skipped = 0;

    for (const source of args.artifacts) {
      const existing = await ctx.db
        .query("artifacts")
        .withIndex("by_external_id", (q) => q.eq("externalId", source.id))
        .unique();
      if (existing) {
        skipped += 1;
        continue;
      }
      const item = await getItemByExternalId(ctx, workspace._id, source.itemId);
      const actor = await ctx.db
        .query("actors")
        .withIndex("by_workspace_external", (q) =>
          q.eq("workspaceId", workspace._id).eq("externalId", source.actorId),
        )
        .unique();
      if (!actor) throw new Error(`Artifact ${source.id} references missing actor ${source.actorId}`);
      await ctx.db.insert("artifacts", {
        workspaceId: workspace._id,
        projectId: item.projectId,
        itemId: item._id,
        externalId: source.id,
        actorId: actor._id,
        actorExternalId: source.actorId,
        kind: source.kind,
        label: source.label,
        uri: source.uri,
        mimeType: source.mimeType ?? undefined,
        metadata: source.metadata,
        createdAt: timestamp(source.createdAt, `artifact ${source.id} createdAt`),
      });
      inserted += 1;
    }
    return { inserted, skipped };
  },
});

export const importTokens = mutation({
  args: {
    ...serviceArgs,
    tokens: v.array(v.object({
      id: v.string(),
      name: v.string(),
      secretHash: v.string(),
      scopes: v.array(tokenScope),
      projects: v.union(v.array(v.string()), v.null()),
      createdAt: v.string(),
      revokedAt: v.union(v.string(), v.null()),
    })),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await requireWorkspace(ctx, args.workspace);
    let imported = 0;
    for (const source of args.tokens) {
      const existing = await ctx.db
        .query("apiTokens")
        .withIndex("by_external_id", (q) => q.eq("externalId", source.id))
        .unique();
      const value = {
        name: source.name,
        secretHash: source.secretHash,
        scopes: source.scopes,
        projects: source.projects ?? undefined,
        createdAt: timestamp(source.createdAt, `token ${source.id} createdAt`),
        revokedAt: source.revokedAt
          ? timestamp(source.revokedAt, `token ${source.id} revokedAt`)
          : undefined,
      };
      if (existing) await ctx.db.patch(existing._id, value);
      else {
        await ctx.db.insert("apiTokens", {
          workspaceId: workspace._id,
          externalId: source.id,
          ...value,
        });
      }
      imported += 1;
    }
    return { tokens: imported };
  },
});

async function requireWorkspace(ctx: any, workspaceValue: string | undefined) {
  const slug = normalizeWorkspace(workspaceValue);
  const workspace = await findWorkspace(ctx, slug);
  if (!workspace) throw new Error(`Workspace ${slug} does not exist; import projects and actors first`);
  return workspace;
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is not a valid timestamp`);
  return parsed;
}
