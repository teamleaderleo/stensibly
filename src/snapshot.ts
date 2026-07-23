import { z } from "zod";
import { artifactKinds, ensureArtifactSchema } from "./artifacts.js";
import { ensureAuthSchema, tokenScopes } from "./auth.js";
import { actorKinds, itemKinds, itemStatuses } from "./schemas.js";
import { StensiblyStore } from "./store.js";

const isoDate = z.string().datetime({ offset: true });

export const snapshotSchema = z.object({
  version: z.literal(1),
  exportedAt: isoDate,
  projects: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    createdAt: isoDate,
  })),
  actors: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(actorKinds),
    updatedAt: isoDate,
  })),
  items: z.array(z.object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    kind: z.enum(itemKinds),
    title: z.string().min(1),
    summary: z.string().nullable(),
    status: z.enum(itemStatuses),
    priority: z.number().int().min(0).max(100),
    nextAction: z.string().nullable(),
    claimedBy: z.string().nullable(),
    claimExpiresAt: isoDate.nullable(),
    version: z.number().int().min(1),
    createdAt: isoDate,
    updatedAt: isoDate,
  })),
  events: z.array(z.object({
    id: z.string().min(1),
    itemId: z.string().min(1),
    actorId: z.string().nullable(),
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().nullable(),
    createdAt: isoDate,
  })),
  artifacts: z.array(z.object({
    id: z.string().min(1),
    itemId: z.string().min(1),
    actorId: z.string().min(1),
    kind: z.enum(artifactKinds),
    label: z.string().min(1),
    uri: z.string().min(1),
    mimeType: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: isoDate,
  })),
  tokens: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
    scopes: z.array(z.enum(tokenScopes)).min(1),
    projects: z.array(z.string()).nullable(),
    createdAt: isoDate,
    revokedAt: isoDate.nullable(),
  })),
});

export type StensiblySnapshot = z.infer<typeof snapshotSchema>;

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
}

interface ActorRow {
  id: string;
  name: string;
  kind: (typeof actorKinds)[number];
  updated_at: string;
}

interface ItemRow {
  id: string;
  project_id: string;
  kind: (typeof itemKinds)[number];
  title: string;
  summary: string | null;
  status: (typeof itemStatuses)[number];
  priority: number;
  next_action: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  item_id: string;
  actor_id: string | null;
  type: string;
  payload_json: string;
  idempotency_key: string | null;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  item_id: string;
  actor_id: string;
  kind: (typeof artifactKinds)[number];
  label: string;
  uri: string;
  mime_type: string | null;
  metadata_json: string;
  created_at: string;
}

interface TokenRow {
  id: string;
  name: string;
  secret_hash: string;
  scopes_json: string;
  projects_json: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function exportSqliteSnapshot(store: StensiblyStore): StensiblySnapshot {
  ensureArtifactSchema(store);
  ensureAuthSchema(store);

  const snapshot: StensiblySnapshot = {
    version: 1,
    exportedAt: new Date().toISOString(),
    projects: store.db
      .query<ProjectRow, []>("SELECT * FROM projects ORDER BY id ASC")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
      })),
    actors: store.db
      .query<ActorRow, []>("SELECT * FROM actors ORDER BY id ASC")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        updatedAt: row.updated_at,
      })),
    items: store.db
      .query<ItemRow, []>("SELECT * FROM items ORDER BY created_at ASC, id ASC")
      .all()
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        status: row.status,
        priority: row.priority,
        nextAction: row.next_action,
        claimedBy: row.claimed_by,
        claimExpiresAt: row.claim_expires_at,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    events: store.db
      .query<EventRow, []>("SELECT * FROM events ORDER BY created_at ASC, id ASC")
      .all()
      .map((row) => ({
        id: row.id,
        itemId: row.item_id,
        actorId: row.actor_id,
        type: row.type,
        payload: parseObject(row.payload_json, `event ${row.id} payload`),
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
      })),
    artifacts: store.db
      .query<ArtifactRow, []>("SELECT * FROM artifacts ORDER BY created_at ASC, id ASC")
      .all()
      .map((row) => ({
        id: row.id,
        itemId: row.item_id,
        actorId: row.actor_id,
        kind: row.kind,
        label: row.label,
        uri: row.uri,
        mimeType: row.mime_type,
        metadata: parseObject(row.metadata_json, `artifact ${row.id} metadata`),
        createdAt: row.created_at,
      })),
    tokens: store.db
      .query<TokenRow, []>("SELECT * FROM api_tokens ORDER BY created_at ASC, id ASC")
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        secretHash: row.secret_hash,
        scopes: parseScopes(row.scopes_json, row.id),
        projects: row.projects_json === null
          ? null
          : parseStringArray(row.projects_json, `token ${row.id} projects`),
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
      })),
  };

  return snapshotSchema.parse(snapshot);
}

export function parseSnapshot(value: unknown): StensiblySnapshot {
  return snapshotSchema.parse(value);
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseStringArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be a JSON string array`);
  }
  return parsed;
}

function parseScopes(value: string, tokenId: string): Array<(typeof tokenScopes)[number]> {
  const parsed = parseStringArray(value, `token ${tokenId} scopes`);
  const scopes = parsed.filter(
    (scope): scope is (typeof tokenScopes)[number] =>
      tokenScopes.includes(scope as (typeof tokenScopes)[number]),
  );
  if (scopes.length !== parsed.length || scopes.length === 0) {
    throw new Error(`token ${tokenId} contains invalid scopes`);
  }
  return scopes;
}
