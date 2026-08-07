import { ensureArtifactSchema, type ArtifactKind } from "./artifacts.js";
import { expireClaims } from "./leases.js";
import {
  NotFoundError,
  StensiblyStore,
  type Item,
  type ItemKind,
  type ItemStatus,
} from "./store.js";
import {
  canonicalTimestamp,
  compareCodeUnits,
} from "./work-stack-projection-validation.js";

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

export interface ProjectBriefArtifactInput extends BriefArtifact {
  project: string;
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

export interface CompileProjectBriefInput {
  project: string;
  generatedAt: string;
  items: readonly Item[];
  recentArtifacts: readonly ProjectBriefArtifactInput[];
  limit?: number;
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

type ProjectBriefItemInput = Pick<
  Item,
  | "id"
  | "project"
  | "kind"
  | "title"
  | "summary"
  | "status"
  | "priority"
  | "nextAction"
  | "claimedBy"
  | "claimExpiresAt"
  | "updatedAt"
>;

interface DetachedCompileProjectBriefInput {
  project: string;
  generatedAt: string;
  items: ProjectBriefItemInput[];
  recentArtifacts: ProjectBriefArtifactInput[];
  limit?: number;
}

const maximumProjectBriefInputEntries = 10_000;
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
const briefArtifactKinds: readonly ArtifactKind[] = Object.freeze([
  "file",
  "url",
  "commit",
  "issue",
  "document",
  "image",
  "log",
  "dataset",
  "other",
]);
const knowledgeKinds = new Set<ItemKind>([
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
]);

export function compileProjectBrief(input: CompileProjectBriefInput): ProjectBrief {
  return compileDetachedProjectBrief(snapshotCompileProjectBriefInput(input));
}

export function getProjectBrief(
  store: StensiblyStore,
  project: string,
  limit = 10,
): ProjectBrief {
  const boundedLimit = briefLimit(limit);
  const exists = store.db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?1")
    .get(project);
  if (!exists) throw new NotFoundError(`Project ${project} does not exist`);

  expireClaims(store);
  const items = store.listItems({ project });

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
    .all(project, boundedLimit);

  return compileDetachedProjectBrief({
    project,
    generatedAt: new Date().toISOString(),
    items,
    recentArtifacts: artifactRows.map((row) => ({
      project,
      id: row.id,
      itemId: row.item_id,
      itemTitle: row.item_title,
      actorId: row.actor_id,
      kind: row.kind,
      label: row.label,
      uri: row.uri,
      createdAt: row.created_at,
    })),
    limit: boundedLimit,
  });
}

function compileDetachedProjectBrief(
  detached: DetachedCompileProjectBriefInput,
): ProjectBrief {
  const limit = briefLimit(detached.limit ?? 10);
  const generatedAt = canonicalTimestamp(
    detached.generatedAt,
    "Project brief generated time",
  );
  const items = detached.items;
  const artifacts = detached.recentArtifacts;
  const itemById = new Map<string, ProjectBriefItemInput>();
  for (const item of items) {
    if (item.project !== detached.project) {
      throw new RangeError("Project brief items must belong to the requested project");
    }
    if (itemById.has(item.id)) {
      throw new RangeError("Project brief item IDs must be unique");
    }
    itemById.set(item.id, item);
  }
  const artifactIds = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.project !== detached.project) {
      throw new RangeError("Project brief artifacts must belong to the requested project");
    }
    if (artifactIds.has(artifact.id)) {
      throw new RangeError("Project brief artifact IDs must be unique");
    }
    artifactIds.add(artifact.id);
    const item = itemById.get(artifact.itemId);
    if (!item) {
      throw new RangeError(
        "Project brief artifacts must reference a supplied project item",
      );
    }
    if (artifact.itemTitle !== item.title) {
      throw new RangeError(
        "Project brief artifact item titles must match supplied items",
      );
    }
  }

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

  const newestFirst = (left: ProjectBriefItemInput, right: ProjectBriefItemInput) =>
    compareCodeUnits(right.updatedAt, left.updatedAt) || right.priority - left.priority;
  const priorityFirst = (left: ProjectBriefItemInput, right: ProjectBriefItemInput) =>
    right.priority - left.priority || compareCodeUnits(right.updatedAt, left.updatedAt);
  const artifactNewestFirst = (
    left: ProjectBriefArtifactInput,
    right: ProjectBriefArtifactInput,
  ) => compareCodeUnits(right.createdAt, left.createdAt) || compareCodeUnits(right.id, left.id);

  return {
    project: detached.project,
    generatedAt,
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
    recentArtifacts: artifacts
      .sort(artifactNewestFirst)
      .slice(0, limit)
      .map(toBriefArtifact),
  };
}

function snapshotCompileProjectBriefInput(
  value: CompileProjectBriefInput,
): DetachedCompileProjectBriefInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Project brief compile input must be an object");
  }
  const project = stringDataProperty(
    value,
    "project",
    "Project brief compile input",
  );
  const generatedAt = stringDataProperty(
    value,
    "generatedAt",
    "Project brief compile input",
  );
  const items = snapshotDenseArray(
    dataProperty(value, "items", "Project brief compile input"),
    "Project brief items",
    snapshotProjectBriefItem,
  );
  const recentArtifacts = snapshotDenseArray(
    dataProperty(value, "recentArtifacts", "Project brief compile input"),
    "Project brief artifacts",
    snapshotProjectBriefArtifact,
  );
  const rawLimit = optionalDataProperty(
    value,
    "limit",
    "Project brief compile input",
  );
  const limit = rawLimit === undefined
    ? undefined
    : numberDataValue(rawLimit, "Project brief compile input", "limit");
  return { project, generatedAt, items, recentArtifacts, limit };
}

function snapshotProjectBriefItem(value: unknown): ProjectBriefItemInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Project brief item must be an object");
  }
  const kind = closedStringDataProperty(
    value,
    "kind",
    "Project brief item",
    kinds,
  ) as ItemKind;
  const status = closedStringDataProperty(
    value,
    "status",
    "Project brief item",
    statuses,
  ) as ItemStatus;
  const priority = numberDataProperty(value, "priority", "Project brief item");
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw new TypeError("Project brief item field priority is invalid");
  }
  return {
    id: stringDataProperty(value, "id", "Project brief item"),
    project: stringDataProperty(value, "project", "Project brief item"),
    kind,
    title: stringDataProperty(value, "title", "Project brief item"),
    summary: nullableStringDataProperty(value, "summary", "Project brief item"),
    status,
    priority,
    nextAction: nullableStringDataProperty(
      value,
      "nextAction",
      "Project brief item",
    ),
    claimedBy: nullableStringDataProperty(
      value,
      "claimedBy",
      "Project brief item",
    ),
    claimExpiresAt: nullableStringDataProperty(
      value,
      "claimExpiresAt",
      "Project brief item",
    ),
    updatedAt: stringDataProperty(value, "updatedAt", "Project brief item"),
  };
}

function snapshotProjectBriefArtifact(
  value: unknown,
): ProjectBriefArtifactInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Project brief artifact must be an object");
  }
  return {
    project: stringDataProperty(value, "project", "Project brief artifact"),
    id: stringDataProperty(value, "id", "Project brief artifact"),
    itemId: stringDataProperty(value, "itemId", "Project brief artifact"),
    itemTitle: stringDataProperty(
      value,
      "itemTitle",
      "Project brief artifact",
    ),
    actorId: stringDataProperty(value, "actorId", "Project brief artifact"),
    kind: closedStringDataProperty(
      value,
      "kind",
      "Project brief artifact",
      briefArtifactKinds,
    ) as ArtifactKind,
    label: stringDataProperty(value, "label", "Project brief artifact"),
    uri: stringDataProperty(value, "uri", "Project brief artifact"),
    createdAt: stringDataProperty(
      value,
      "createdAt",
      "Project brief artifact",
    ),
  };
}

function snapshotDenseArray<T>(
  value: unknown,
  label: string,
  snapshot: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const lengthDescriptor = ownDescriptor(value, "length", label);
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError(`${label} length is invalid`);
  }
  const length = lengthDescriptor.value as number;
  if (length > maximumProjectBriefInputEntries) {
    throw new RangeError(
      `${label} must contain at most ${maximumProjectBriefInputEntries} entries`,
    );
  }
  const result: T[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = ownDescriptor(value, String(index), label);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain dense enumerable data entries`);
    }
    result.push(snapshot(descriptor.value));
  }
  return result;
}

function stringDataProperty(value: object, key: string, label: string): string {
  const candidate = dataProperty(value, key, label);
  if (typeof candidate !== "string") {
    throw new TypeError(`${label} field ${key} must be a string`);
  }
  return candidate;
}

function nullableStringDataProperty(
  value: object,
  key: string,
  label: string,
): string | null {
  const candidate = dataProperty(value, key, label);
  if (candidate !== null && typeof candidate !== "string") {
    throw new TypeError(`${label} field ${key} must be a string or null`);
  }
  return candidate;
}

function closedStringDataProperty<T extends string>(
  value: object,
  key: string,
  label: string,
  allowed: readonly T[],
): T {
  const candidate = stringDataProperty(value, key, label);
  if (!(allowed as readonly string[]).includes(candidate)) {
    throw new TypeError(`${label} field ${key} is invalid`);
  }
  return candidate as T;
}

function numberDataProperty(value: object, key: string, label: string): number {
  return numberDataValue(dataProperty(value, key, label), label, key);
}

function numberDataValue(value: unknown, label: string, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} field ${key} must be a finite number`);
  }
  return value;
}

function dataProperty(value: object, key: string, label: string): unknown {
  const descriptor = ownDescriptor(value, key, label);
  if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${label} field ${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function optionalDataProperty(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = ownDescriptor(value, key, label);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError(`${label} field ${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function ownDescriptor(
  value: object,
  key: string,
  label: string,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new TypeError(`${label} could not be inspected`);
  }
}

function briefLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new RangeError("Brief limit must be between 1 and 100");
  }
  return value;
}

function toBriefItem(item: ProjectBriefItemInput): BriefItem {
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

function toBriefArtifact(artifact: ProjectBriefArtifactInput): BriefArtifact {
  return {
    id: artifact.id,
    itemId: artifact.itemId,
    itemTitle: artifact.itemTitle,
    actorId: artifact.actorId,
    kind: artifact.kind,
    label: artifact.label,
    uri: artifact.uri,
    createdAt: artifact.createdAt,
  };
}
