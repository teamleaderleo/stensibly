import type { Doc } from "../_generated/dataModel";
import type { QueryContext } from "./domain";

export const MAX_ITEM_DEPENDENCIES = 500;

export interface PublicDependency {
  id: string;
  direction: "outgoing" | "incoming";
  kind: Doc<"dependencies">["kind"];
  itemId: string;
  title: string;
  status: Doc<"items">["status"];
  createdAt: string;
}

export async function readVisibleDependencies(
  ctx: QueryContext,
  item: Doc<"items">,
): Promise<PublicDependency[]> {
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query("dependencies")
      .withIndex("by_from_kind", (q) => q.eq("fromItemId", item._id))
      .take(MAX_ITEM_DEPENDENCIES + 1),
    ctx.db
      .query("dependencies")
      .withIndex("by_to_kind", (q) => q.eq("toItemId", item._id))
      .take(MAX_ITEM_DEPENDENCIES + 1),
  ]);
  if (outgoing.length + incoming.length > MAX_ITEM_DEPENDENCIES) {
    throw new Error(
      `Item ${item.externalId} has too many dependencies to read safely`,
    );
  }

  const output: PublicDependency[] = [];
  for (const dependency of outgoing) {
    const target = await ctx.db.get("items", dependency.toItemId);
    if (!target || target.projectId !== item.projectId) continue;
    output.push(publicDependency(dependency, target, "outgoing"));
  }
  for (const dependency of incoming) {
    const source = await ctx.db.get("items", dependency.fromItemId);
    if (!source || source.projectId !== item.projectId) continue;
    output.push(publicDependency(dependency, source, "incoming"));
  }
  return output;
}

export async function filterVisibleDependencyEvents(
  ctx: QueryContext,
  item: Doc<"items">,
  events: Doc<"events">[],
  dependencies: PublicDependency[],
): Promise<Doc<"events">[]> {
  const visibleDependencyIds = new Set(
    dependencies.map((dependency) => dependency.id),
  );
  const legacyTargetVisibility = new Map<string, boolean>();
  const output: Doc<"events">[] = [];

  for (const event of events) {
    if (event.type !== "dependency.added") {
      output.push(event);
      continue;
    }

    const payload = record(event.payload);
    const dependencyId = text(payload?.dependencyId);
    if (dependencyId) {
      if (visibleDependencyIds.has(dependencyId)) output.push(event);
      continue;
    }

    const targetExternalId = text(payload?.toItemId);
    if (!targetExternalId) continue;
    let visible = legacyTargetVisibility.get(targetExternalId);
    if (visible === undefined) {
      const target = await ctx.db
        .query("items")
        .withIndex("by_workspace_external", (q) =>
          q
            .eq("workspaceId", item.workspaceId)
            .eq("externalId", targetExternalId),
        )
        .unique();
      visible = target?.projectId === item.projectId;
      legacyTargetVisibility.set(targetExternalId, visible);
    }
    if (visible) output.push(event);
  }

  return output;
}

function publicDependency(
  dependency: Doc<"dependencies">,
  other: Doc<"items">,
  direction: PublicDependency["direction"],
): PublicDependency {
  return {
    id: String(dependency._id),
    direction,
    kind: dependency.kind,
    itemId: other.externalId,
    title: other.title,
    status: other.status,
    createdAt: new Date(dependency.createdAt).toISOString(),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
