import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ActorInput, CreateItemInput } from "./schemas.ts";

export type ItemStatus = "ready" | "active" | "blocked" | "done" | "archived";
export type ItemKind =
  | "task"
  | "finding"
  | "question"
  | "decision"
  | "tip"
  | "handoff"
  | "note";

export interface Item {
  id: string;
  project: string;
  kind: ItemKind;
  title: string;
  summary: string | null;
  status: ItemStatus;
  priority: number;
  nextAction: string | null;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ItemEvent {
  id: string;
  itemId: string;
  actorId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ItemRow {
  id: string;
  project_id: string;
  kind: ItemKind;
  title: string;
  summary: string | null;
  status: ItemStatus;
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
  created_at: string;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class StensiblyStore {
  readonly db: Database;

  constructor(path = "stensibly.sqlite") {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS actors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'service')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('task', 'finding', 'question', 'decision', 'tip', 'handoff', 'note')),
        title TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL CHECK (status IN ('ready', 'active', 'blocked', 'done', 'archived')),
        priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
        next_action TEXT,
        claimed_by TEXT REFERENCES actors(id),
        claim_expires_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES actors(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_items_project_status
        ON items(project_id, status, priority DESC, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_items_claim_expiry
        ON items(claim_expires_at)
        WHERE claimed_by IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_events_item_created
        ON events(item_id, created_at ASC);
    `);
  }

  listItems(filters: { project?: string; status?: ItemStatus } = {}): Item[] {
    const rows = this.db
      .query<ItemRow, [string | null, string | null]>(`
        SELECT *
        FROM items
        WHERE (?1 IS NULL OR project_id = ?1)
          AND (?2 IS NULL OR status = ?2)
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'ready' THEN 1
            WHEN 'blocked' THEN 2
            WHEN 'done' THEN 3
            ELSE 4
          END,
          priority DESC,
          created_at DESC
      `)
      .all(filters.project ?? null, filters.status ?? null);

    return rows.map(mapItem);
  }

  getItem(id: string): Item {
    const row = this.db.query<ItemRow, [string]>("SELECT * FROM items WHERE id = ?1").get(id);
    if (!row) throw new NotFoundError(`Item ${id} does not exist`);
    return mapItem(row);
  }

  createItem(input: CreateItemInput, idempotencyKey?: string): Item {
    const transaction = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.findIdempotentEvent(idempotencyKey);
        if (existing) return this.getItem(existing.item_id);
      }

      const now = new Date().toISOString();
      const id = `item_${randomUUID()}`;

      this.db
        .query(`
          INSERT INTO projects (id, name, created_at)
          VALUES (?1, ?1, ?2)
          ON CONFLICT(id) DO NOTHING
        `)
        .run(input.project, now);

      if (input.actor) this.upsertActor(input.actor, now);

      this.db
        .query(`
          INSERT INTO items (
            id, project_id, kind, title, summary, status, priority,
            next_action, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, 'ready', ?6, ?7, ?8, ?8)
        `)
        .run(
          id,
          input.project,
          input.kind,
          input.title,
          input.summary ?? null,
          input.priority,
          input.nextAction ?? null,
          now,
        );

      this.appendEvent({
        itemId: id,
        actorId: input.actor?.id ?? null,
        type: "item.created",
        payload: {
          kind: input.kind,
          title: input.title,
          project: input.project,
        },
        idempotencyKey,
        now,
      });

      return this.getItem(id);
    });

    return transaction();
  }

  claimItem(
    id: string,
    actor: ActorInput,
    leaseSeconds: number,
    idempotencyKey?: string,
  ): Item {
    const transaction = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.findIdempotentEvent(idempotencyKey);
        if (existing) return this.getItem(existing.item_id);
      }

      this.getItem(id);
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
      this.upsertActor(actor, nowIso);

      const result = this.db
        .query(`
          UPDATE items
          SET status = 'active',
              claimed_by = ?1,
              claim_expires_at = ?2,
              version = version + 1,
              updated_at = ?3
          WHERE id = ?4
            AND status IN ('ready', 'active')
            AND (
              claimed_by IS NULL
              OR claim_expires_at IS NULL
              OR claim_expires_at <= ?3
              OR claimed_by = ?1
            )
        `)
        .run(actor.id, expiresAt, nowIso, id);

      if (result.changes !== 1) {
        throw new ConflictError("Item is unavailable or held by another actor");
      }

      this.appendEvent({
        itemId: id,
        actorId: actor.id,
        type: "claim.created",
        payload: { leaseSeconds, expiresAt },
        idempotencyKey,
        now: nowIso,
      });

      return this.getItem(id);
    });

    return transaction();
  }

  releaseItem(id: string, actor: ActorInput, idempotencyKey?: string): Item {
    const transaction = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.findIdempotentEvent(idempotencyKey);
        if (existing) return this.getItem(existing.item_id);
      }

      this.getItem(id);
      const now = new Date().toISOString();
      this.upsertActor(actor, now);

      const result = this.db
        .query(`
          UPDATE items
          SET status = 'ready',
              claimed_by = NULL,
              claim_expires_at = NULL,
              version = version + 1,
              updated_at = ?1
          WHERE id = ?2 AND claimed_by = ?3
        `)
        .run(now, id, actor.id);

      if (result.changes !== 1) {
        throw new ConflictError("Only the current claimant can release this item");
      }

      this.appendEvent({
        itemId: id,
        actorId: actor.id,
        type: "claim.released",
        payload: {},
        idempotencyKey,
        now,
      });

      return this.getItem(id);
    });

    return transaction();
  }

  completeItem(
    id: string,
    actor: ActorInput,
    summary?: string,
    idempotencyKey?: string,
  ): Item {
    const transaction = this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.findIdempotentEvent(idempotencyKey);
        if (existing) return this.getItem(existing.item_id);
      }

      this.getItem(id);
      const now = new Date().toISOString();
      this.upsertActor(actor, now);

      const result = this.db
        .query(`
          UPDATE items
          SET status = 'done',
              summary = COALESCE(?1, summary),
              claimed_by = NULL,
              claim_expires_at = NULL,
              version = version + 1,
              updated_at = ?2
          WHERE id = ?3
            AND status NOT IN ('done', 'archived')
            AND (claimed_by IS NULL OR claimed_by = ?4)
        `)
        .run(summary ?? null, now, id, actor.id);

      if (result.changes !== 1) {
        throw new ConflictError("Item is complete, archived, or held by another actor");
      }

      this.appendEvent({
        itemId: id,
        actorId: actor.id,
        type: "item.completed",
        payload: summary ? { summary } : {},
        idempotencyKey,
        now,
      });

      return this.getItem(id);
    });

    return transaction();
  }

  recordEvent(input: {
    itemId: string;
    actor?: ActorInput;
    type: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
  }): ItemEvent {
    const transaction = this.db.transaction(() => {
      if (input.idempotencyKey) {
        const existing = this.findIdempotentEvent(input.idempotencyKey);
        if (existing) return mapEvent(existing);
      }

      this.getItem(input.itemId);
      const now = new Date().toISOString();
      if (input.actor) this.upsertActor(input.actor, now);

      return this.appendEvent({
        itemId: input.itemId,
        actorId: input.actor?.id ?? null,
        type: input.type,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        now,
      });
    });

    return transaction();
  }

  listEvents(itemId: string): ItemEvent[] {
    this.getItem(itemId);
    const rows = this.db
      .query<EventRow, [string]>(`
        SELECT * FROM events
        WHERE item_id = ?1
        ORDER BY created_at ASC
      `)
      .all(itemId);
    return rows.map(mapEvent);
  }

  private upsertActor(actor: ActorInput, now: string): void {
    this.db
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

  private findIdempotentEvent(key: string): EventRow | null {
    return (
      this.db
        .query<EventRow, [string]>("SELECT * FROM events WHERE idempotency_key = ?1")
        .get(key) ?? null
    );
  }

  private appendEvent(input: {
    itemId: string;
    actorId: string | null;
    type: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    now: string;
  }): ItemEvent {
    const id = `evt_${randomUUID()}`;
    this.db
      .query(`
        INSERT INTO events (
          id, item_id, actor_id, type, payload_json, idempotency_key, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `)
      .run(
        id,
        input.itemId,
        input.actorId,
        input.type,
        JSON.stringify(input.payload),
        input.idempotencyKey ?? null,
        input.now,
      );

    return {
      id,
      itemId: input.itemId,
      actorId: input.actorId,
      type: input.type,
      payload: input.payload,
      createdAt: input.now,
    };
  }
}

function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    project: row.project_id,
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
  };
}

function mapEvent(row: EventRow): ItemEvent {
  return {
    id: row.id,
    itemId: row.item_id,
    actorId: row.actor_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
