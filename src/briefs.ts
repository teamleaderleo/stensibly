import { ensureArtifactSchema, type ArtifactKind } from "./artifacts.ts";
import { expireClaims } from "./leases.ts";
import {
  NotFoundError,
  StensiblyStore,
  type Item,
  type ItemKind,
  type ItemStatus,
} from "./store.ts";

export interface BriefItem {
  id: string;
  kind: ItemKind;
  title: string;
  status: ItemStatus;
  priority: number;
  summary: string | null;
  nextAction: string | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  updatedAt: string;
}

export interface BriefArtifact {
  id: string;
  itemId: string;
  itemTitle: string;
  actorId: string;
  kind: ArtifactKind;
  label: string;
  uri: string;
  createdAt: string;
}

export interface ProjectBrief {
  project: string;
  generatedAt: string;
  counts: {
    total: number;
    byStatus: Record<ItemStatus, number>;
    byKind: Record<ItemKind, number>;
  };
  ready: BriefItem[];
  active: BriefItem[];
  blocked: BriefItem[];
  knowledge: BriefItem[];
  recentlyCompleted: BriefItem[];
  recentArtifacts: BriefArtifact[];
}

interface ArtifactBriefRow {
  id: string;
  item_id: string;
  item_title: string;
  actor_id: string;
  kind: ArtifactKind;
  label: string;
  uri: string;
  created_at: string;
}

const statuses: ItemStatus[] = ["ready", "active", "blocked", "done", "archived"];
const kinds: ItemKind[] = [
  "task",
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
];
const knowledgeKinds = new Set<ItemKind>([
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
]);

export function getProjectBrief(
  store: StensiblyStore,
  project: string,
  limit = 10,
): ProjectBrief {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("Brief limit must be between 1 and 100");
  }

  const exists = store.db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?1")
    .get(project);
  if (!exists) throw new NotFoundError(`Project ${project} does not exist`);

  expireClaims(store);
  const items = store.listItems({ project });
  const byStatus = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    ItemStatus,
    number
  >;
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<
    ItemKind,
    number
  >;

  for (const item of items) {
    byStatus[item.status] += 1;
    byKind[item.kind] += 1;
  }

  const newestFirst = (left: Item, right: Item) =>
    right.updatedAt.localeCompare(left.updatedAt) || right.priority - left.priority;
  const priorityFirst = (left: Item, right: Item) =>
    right.priority - left.priority || right.updatedAt.localeCompare(left.updatedAt);

  ensureArtifactSchema(store);
  const artifactRows = store.db
    .query<ArtifactBriefRow, [string, number]>(`
      SELECT
        artifacts.id,
        artifacts.item_id,
        items.title AS item_title,
        artifacts.actor_id,
        artifacts.kind,
        artifacts.label,
        artifacts.uri,
        artifacts.created_at
      FROM artifacts
      JOIN items ON items.id = artifacts.item_id
      WHERE items.project_id = ?1
      ORDER BY artifacts.created_at DESC, artifacts.id DESC
      LIMIT ?2
    `)
    .all(project, limit);

  return {
    project,
    generatedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      byStatus,
      byKind,
    },
    ready: items
      .filter((item) => item.status === "ready")
      .sort(priorityFirst)
      .slice(0, limit)
      .map(toBriefItem),
    active: items
      .filter((item) => item.status === "active")
      .sort(newestFirst)
      .slice(0, limit)
      .map(toBriefItem),
    blocked: items
      .filter((item) => item.status === "blocked")
      .sort(priorityFirst)
      .slice(0, limit)
      .map(toBriefItem),
    knowledge: items
      .filter((item) => knowledgeKinds.has(item.kind) && item.status !== "archived")
      .sort(newestFirst)
      .slice(0, limit)
      .map(toBriefItem),
    recentlyCompleted: items
      .filter((item) => item.status === "done")
      .sort(newestFirst)
      .slice(0, limit)
      .map(toBriefItem),
    recentArtifacts: artifactRows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      itemTitle: row.item_title,
      actorId: row.actor_id,
      kind: row.kind,
      label: row.label,
      uri: row.uri,
      createdAt: row.created_at,
    })),
  };
}

function toBriefItem(item: Item): BriefItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    priority: item.priority,
    summary: item.summary,
    nextAction: item.nextAction,
    claimedBy: item.claimedBy,
    claimExpiresAt: item.claimExpiresAt,
    updatedAt: item.updatedAt,
  };
}
