import { randomUUID } from "node:crypto";
import type { ActorInput } from "./schemas.ts";
import { ConflictError, StensiblyStore } from "./store.ts";

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

export type ArtifactKind = (typeof artifactKinds)[number];

export interface Artifact {
  id: string;
  itemId: string;
  actorId: string;
  kind: ArtifactKind;
  label: string;
  uri: string;
  mimeType: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ArtifactRow {
  id: string;
  item_id: string;
  actor_id: string;
  kind: ArtifactKind;
  label: string;
  uri: string;
  mime_type: string | null;
  metadata_json: string;
  created_at: string;
}

interface EventRow {
  type: string;
  payload_json: string;
}

export function attachArtifact(
  store: StensiblyStore,
  input: {
    itemId: string;
    actor: ActorInput;
    kind: ArtifactKind;
    label: string;
    uri: string;
    mimeType?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Artifact {
  ensureArtifactSchema(store);

  const transaction = store.db.transaction(() => {
    if (input.idempotencyKey) {
      const existingEvent = store.db
        .query<EventRow, [string]>(
          "SELECT type, payload_json FROM events WHERE idempotency_key = ?1",
        )
        .get(input.idempotencyKey);
      if (existingEvent) {
        if (existingEvent.type !== "artifact.attached") {
          throw new ConflictError("Idempotency key already belongs to another operation");
        }
        const payload = JSON.parse(existingEvent.payload_json) as { artifactId?: unknown };
        if (typeof payload.artifactId !== "string") {
          throw new ConflictError("Artifact idempotency record is incomplete");
        }
        return getArtifact(store, payload.artifactId);
      }
    }

    store.getItem(input.itemId);
    const now = new Date().toISOString();
    const id = `art_${randomUUID()}`;
    upsertActor(store, input.actor, now);

    store.db
      .query(`
        INSERT INTO artifacts (
          id, item_id, actor_id, kind, label, uri, mime_type, metadata_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `)
      .run(
        id,
        input.itemId,
        input.actor.id,
        input.kind,
        input.label,
        input.uri,
        input.mimeType ?? null,
        JSON.stringify(input.metadata ?? {}),
        now,
      );

    store.db
      .query(`
        INSERT INTO events (
          id, item_id, actor_id, type, payload_json, idempotency_key, created_at
        ) VALUES (?1, ?2, ?3, 'artifact.attached', ?4, ?5, ?6)
      `)
      .run(
        `evt_${randomUUID()}`,
        input.itemId,
        input.actor.id,
        JSON.stringify({
          artifactId: id,
          kind: input.kind,
          label: input.label,
          uri: input.uri,
        }),
        input.idempotencyKey ?? null,
        now,
      );

    return getArtifact(store, id);
  });

  return transaction();
}

export function listArtifacts(store: StensiblyStore, itemId: string): Artifact[] {
  ensureArtifactSchema(store);
  store.getItem(itemId);
  return store.db
    .query<ArtifactRow, [string]>(`
      SELECT *
      FROM artifacts
      WHERE item_id = ?1
      ORDER BY created_at ASC, id ASC
    `)
    .all(itemId)
    .map(mapArtifact);
}

export function getArtifact(store: StensiblyStore, id: string): Artifact {
  ensureArtifactSchema(store);
  const row = store.db
    .query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE id = ?1")
    .get(id);
  if (!row) throw new ConflictError(`Artifact ${id} does not exist`);
  return mapArtifact(row);
}

export function ensureArtifactSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL REFERENCES actors(id),
      kind TEXT NOT NULL CHECK (
        kind IN ('file', 'url', 'commit', 'issue', 'document', 'image', 'log', 'dataset', 'other')
      ),
      label TEXT NOT NULL,
      uri TEXT NOT NULL,
      mime_type TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_item_created
      ON artifacts(item_id, created_at ASC);
  `);
}

function upsertActor(store: StensiblyStore, actor: ActorInput, now: string): void {
  store.db
    .query(`
      INSERT INTO actors (id, name, kind, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        updated_at = excluded.updated_at
    `)
    .run(actor.id, actor.name, actor.kind, now);
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    kind: row.kind,
    label: row.label,
    uri: row.uri,
    mimeType: row.mime_type,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
