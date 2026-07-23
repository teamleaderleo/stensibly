import { v } from "convex/values";
import {
  appendEvent,
  assertOptionalText,
  assertText,
  findWorkspace,
  getItemByExternalId,
  normalizeWorkspace,
  publicArtifact,
  requireMatchingIdempotency,
  requireServiceSecret,
  upsertActor,
} from "./lib/domain";
import { mutation, query } from "./lib/server";
import {
  actorValidator,
  artifactKindValidator,
  serviceArgs,
} from "./lib/validators";

export const attach = mutation({
  args: {
    ...serviceArgs,
    id: v.string(),
    actor: actorValidator,
    kind: artifactKindValidator,
    label: v.string(),
    uri: v.string(),
    mimeType: v.optional(v.string()),
    metadata: v.any(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const existing = await requireMatchingIdempotency(
      ctx,
      workspace._id,
      args.idempotencyKey,
      "artifact.attached",
    );
    if (existing) {
      const artifactExternalId = (existing.payload as { artifactId?: unknown }).artifactId;
      if (typeof artifactExternalId !== "string") {
        throw new Error("Artifact idempotency record is incomplete");
      }
      const artifact = await ctx.db
        .query("artifacts")
        .withIndex("by_external_id", (q) => q.eq("externalId", artifactExternalId))
        .unique();
      if (!artifact) throw new Error("Idempotent artifact no longer exists");
      return { ...publicArtifact(artifact), itemId: args.id };
    }

    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const actor = await upsertActor(ctx, workspace._id, args.actor);
    if (!actor) throw new Error("Failed to create actor");
    const now = Date.now();
    const artifactId = await ctx.db.insert("artifacts", {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      externalId: "pending",
      actorId: actor._id,
      actorExternalId: actor.externalId,
      kind: args.kind,
      label: assertText(args.label, "Artifact label", 240),
      uri: assertText(args.uri, "Artifact URI", 4_096),
      mimeType: assertOptionalText(args.mimeType, "MIME type", 255),
      metadata: args.metadata,
      createdAt: now,
    });
    const externalId = `art_${artifactId}`;
    await ctx.db.patch(artifactId, { externalId });
    await appendEvent(ctx, {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      itemId: item._id,
      actorId: actor._id,
      actorExternalId: actor.externalId,
      type: "artifact.attached",
      payload: {
        artifactId: externalId,
        kind: args.kind,
        label: args.label.trim(),
        uri: args.uri.trim(),
      },
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });
    const artifact = await ctx.db.get("artifacts", artifactId);
    if (!artifact) throw new Error("Attached artifact disappeared");
    return { ...publicArtifact(artifact), itemId: item.externalId };
  },
});

export const list = query({
  args: { ...serviceArgs, id: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    requireServiceSecret(args.serviceSecret);
    const workspace = await findWorkspace(ctx, normalizeWorkspace(args.workspace));
    if (!workspace) throw new Error(`Item ${args.id} does not exist`);
    const item = await getItemByExternalId(ctx, workspace._id, args.id);
    const artifacts = await ctx.db
      .query("artifacts")
      .withIndex("by_item_created", (q) => q.eq("itemId", item._id))
      .collect();
    return artifacts.map((artifact) => ({
      ...publicArtifact(artifact),
      itemId: item.externalId,
    }));
  },
});
