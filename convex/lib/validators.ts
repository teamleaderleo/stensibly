import { v } from "convex/values";

export const actorKinds = ["human", "agent", "service"] as const;
export const itemKinds = [
  "task",
  "finding",
  "question",
  "decision",
  "tip",
  "handoff",
  "note",
] as const;
export const itemStatuses = ["ready", "active", "blocked", "done", "archived"] as const;
export const artifactKinds = [
  "file",
  "url",
  "commit",
  "issue",
  "document",
  "image",
  "log",
  "dataset",
  "other",
] as const;
export const runStatuses = ["running", "waiting", "succeeded", "failed", "cancelled"] as const;
export const dependencyKinds = [
  "blocks",
  "depends_on",
  "related_to",
  "duplicates",
  "supersedes",
] as const;

export const actorKindValidator = v.union(
  v.literal("human"),
  v.literal("agent"),
  v.literal("service"),
);

export const itemKindValidator = v.union(
  v.literal("task"),
  v.literal("finding"),
  v.literal("question"),
  v.literal("decision"),
  v.literal("tip"),
  v.literal("handoff"),
  v.literal("note"),
);

export const itemStatusValidator = v.union(
  v.literal("ready"),
  v.literal("active"),
  v.literal("blocked"),
  v.literal("done"),
  v.literal("archived"),
);

export const artifactKindValidator = v.union(
  v.literal("file"),
  v.literal("url"),
  v.literal("commit"),
  v.literal("issue"),
  v.literal("document"),
  v.literal("image"),
  v.literal("log"),
  v.literal("dataset"),
  v.literal("other"),
);

export const runStatusValidator = v.union(
  v.literal("running"),
  v.literal("waiting"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const dependencyKindValidator = v.union(
  v.literal("blocks"),
  v.literal("depends_on"),
  v.literal("related_to"),
  v.literal("duplicates"),
  v.literal("supersedes"),
);

export const reservationModeValidator = v.union(v.literal("exclusive"), v.literal("shared"));

export const actorValidator = v.object({
  id: v.string(),
  name: v.string(),
  kind: actorKindValidator,
  capabilities: v.optional(v.array(v.string())),
});

export const serviceArgs = {
  serviceSecret: v.string(),
  workspace: v.optional(v.string()),
};

export type ActorInput = {
  id: string;
  name: string;
  kind: (typeof actorKinds)[number];
  capabilities?: string[];
};

export type ItemStatus = (typeof itemStatuses)[number];
export type ItemKind = (typeof itemKinds)[number];
export type ArtifactKind = (typeof artifactKinds)[number];
export type RunStatus = (typeof runStatuses)[number];
export type DependencyKind = (typeof dependencyKinds)[number];
