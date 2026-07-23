import type {
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { GenericId } from "convex/values";
import type { DataModel } from "./dataModel";
import type { ActorInput } from "./validators";

export type QueryContext = GenericQueryCtx<DataModel>;
export type MutationContext = GenericMutationCtx<DataModel>;
export type WorkspaceId = GenericId<"workspaces">;
export type ProjectId = GenericId<"projects">;
export type ActorId = GenericId<"actors">;
export type ItemId = GenericId<"items">;

export function requireServiceSecret(provided: string): void {
  const expected = process.env.STENSIBLY_SERVICE_SECRET;
  if (!expected) {
    throw new Error("STENSIBLY_SERVICE_SECRET is not configured");
  }
  if (provided !== expected) throw new Error("Unauthorized");
}

export function normalizeWorkspace(value: string | undefined): string {
  return assertSlug(value ?? "default", "Workspace");
}

export function assertSlug(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(normalized) || normalized.length > 80) {
    throw new Error(`${label} must be a lowercase slug up to 80 characters`);
  }
  return normalized;
}

export function assertText(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${label} must be between 1 and ${max} characters`);
  }
  return normalized;
}

export function assertOptionalText(
  value: string | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  return assertText(value, label, max);
}

export function assertPriority(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Priority must be an integer between 0 and 100");
  }
  return value;
}

export function assertLeaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 30 || value > 86_400) {
    throw new Error("Lease must be between 30 and 86400 seconds");
  }
  return value;
}

export async function findWorkspace(ctx: QueryContext, slug: string) {
  return await ctx.db
    .query("workspaces")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

export async function ensureWorkspace(ctx: MutationContext, slug: string) {
  const existing = await findWorkspace(ctx, slug);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("workspaces", {
    externalId: `ws_${slug}`,
    slug,
    name: slug,
    createdAt: now,
    updatedAt: now,
  });
  return await ctx.db.get("workspaces", id);
}

export async function findProject(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  slug: string,
) {
  return await ctx.db
    .query("projects")
    .withIndex("by_workspace_slug", (q) =>
      q.eq("workspaceId", workspaceId).eq("slug", slug),
    )
    .unique();
}

export async function ensureProject(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  workspaceSlug: string,
  slug: string,
) {
  const existing = await findProject(ctx, workspaceId, slug);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("projects", {
    workspaceId,
    externalId: `project_${workspaceSlug}_${slug}`,
    slug,
    name: slug,
    createdAt: now,
    updatedAt: now,
  });
  return await ctx.db.get("projects", id);
}

export async function upsertActor(
  ctx: MutationContext,
  workspaceId: WorkspaceId,
  actor: ActorInput,
) {
  const externalId = assertText(actor.id, "Actor id", 120);
  const name = assertText(actor.name, "Actor name", 160);
  const existing = await ctx.db
    .query("actors")
    .withIndex("by_workspace_external", (q) =>
      q.eq("workspaceId", workspaceId).eq("externalId", externalId),
    )
    .unique();
  const patch = {
    name,
    kind: actor.kind,
    capabilities: actor.capabilities,
    updatedAt: Date.now(),
  };
  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return { ...existing, ...patch };
  }
  const id = await ctx.db.insert("actors", {
    workspaceId,
    externalId,
    ...patch,
  });
  return await ctx.db.get("actors", id);
}

export async function getItemByExternalId(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  externalId: string,
) {
  const item = await ctx.db
    .query("items")
    .withIndex("by_workspace_external", (q) =>
      q.eq("workspaceId", workspaceId).eq("externalId", externalId),
    )
    .unique();
  if (!item) throw new Error(`Item ${externalId} does not exist`);
  return item;
}

export async function findIdempotentEvent(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  key: string | undefined,
) {
  if (!key) return null;
  return await ctx.db
    .query("events")
    .withIndex("by_workspace_idempotency", (q) =>
      q.eq("workspaceId", workspaceId).eq("idempotencyKey", key),
    )
    .unique();
}

export async function requireMatchingIdempotency(
  ctx: QueryContext,
  workspaceId: WorkspaceId,
  key: string | undefined,
  expectedType: string,
) {
  const existing = await findIdempotentEvent(ctx, workspaceId, key);
  if (!existing) return null;
  if (existing.type !== expectedType) {
    throw new Error("Idempotency key already belongs to another operation");
  }
  return existing;
}

export async function appendEvent(
  ctx: MutationContext,
  input: {
    workspaceId: WorkspaceId;
    projectId: ProjectId;
    itemId: ItemId;
    actorId?: ActorId;
    actorExternalId?: string;
    type: string;
    payload: unknown;
    idempotencyKey?: string;
    createdAt?: number;
  },
) {
  const createdAt = input.createdAt ?? Date.now();
  const id = await ctx.db.insert("events", {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    itemId: input.itemId,
    externalId: "pending",
    actorId: input.actorId,
    actorExternalId: input.actorExternalId,
    type: input.type,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
    createdAt,
  });
  const externalId = `evt_${id}`;
  await ctx.db.patch(id, { externalId });
  return {
    id: externalId,
    itemId: String(input.itemId),
    actorId: input.actorExternalId ?? null,
    type: input.type,
    payload: input.payload,
    createdAt: new Date(createdAt).toISOString(),
  };
}

export async function projectSlugForItem(ctx: QueryContext, item: any): Promise<string> {
  const project = await ctx.db.get("projects", item.projectId);
  if (!project) throw new Error("Item project does not exist");
  return project.slug;
}

export async function publicItem(ctx: QueryContext, item: any) {
  return {
    id: item.externalId,
    project: await projectSlugForItem(ctx, item),
    kind: item.kind,
    title: item.title,
    summary: item.summary ?? null,
    status: item.status,
    priority: item.priority,
    nextAction: item.nextAction ?? null,
    claimedBy: item.claimedByExternalId ?? null,
    claimExpiresAt:
      item.claimExpiresAt === undefined
        ? null
        : new Date(item.claimExpiresAt).toISOString(),
    version: item.version,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

export function publicEvent(event: any) {
  return {
    id: event.externalId,
    itemId: String(event.itemId),
    actorId: event.actorExternalId ?? null,
    type: event.type,
    payload: event.payload,
    createdAt: new Date(event.createdAt).toISOString(),
  };
}

export function publicArtifact(artifact: any) {
  return {
    id: artifact.externalId,
    itemId: String(artifact.itemId),
    actorId: artifact.actorExternalId,
    kind: artifact.kind,
    label: artifact.label,
    uri: artifact.uri,
    mimeType: artifact.mimeType ?? null,
    metadata: artifact.metadata,
    createdAt: new Date(artifact.createdAt).toISOString(),
  };
}

export function publicRun(run: any) {
  return {
    id: run.externalId,
    itemId: String(run.itemId),
    actorId: run.actorExternalId,
    harness: run.harness,
    model: run.model ?? null,
    externalRunId: run.externalRunId ?? null,
    repository: run.repository ?? null,
    branch: run.branch ?? null,
    worktree: run.worktree ?? null,
    status: run.status,
    childAgentCount: run.childAgentCount ?? null,
    toolCallCount: run.toolCallCount ?? null,
    startedAt: new Date(run.startedAt).toISOString(),
    lastHeartbeatAt: new Date(run.lastHeartbeatAt).toISOString(),
    endedAt: run.endedAt === undefined ? null : new Date(run.endedAt).toISOString(),
    outcome: run.outcome ?? null,
  };
}
