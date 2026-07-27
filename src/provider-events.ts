import { randomUUID } from "node:crypto";
import type { StensiblyStore } from "./store.js";

export const MAX_PROVIDER_EVENT_LIST = 100;

export type ProviderEventRoutingLevel = "record" | "attention" | "interrupt";
export type ProviderEventStatus = "pending" | "acknowledged";

export interface ProviderEvent {
  id: string;
  provider: "github";
  deliveryId: string;
  eventType: "pull_request_review";
  externalObjectId: string;
  repository: string;
  subjectNumber: number;
  action: string;
  revision: string;
  actor: string | null;
  routingLevel: ProviderEventRoutingLevel;
  status: ProviderEventStatus;
  summary: string;
  receivedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface IngestGitHubPullRequestReviewInput {
  deliveryId: string;
  payloadDigest: string;
  externalObjectId: string;
  repository: string;
  subjectNumber: number;
  action: string;
  revision: string;
  actor?: string | null;
  summary: string;
  receivedAt: string;
}

export interface ProviderEventListOptions {
  status?: ProviderEventStatus;
  limit?: number;
}

interface ProviderEventRow {
  id: string;
  provider: "github";
  delivery_id: string;
  payload_digest: string;
  event_type: "pull_request_review";
  external_object_id: string;
  repository: string;
  subject_number: number;
  action: string;
  revision: string;
  actor: string | null;
  routing_level: ProviderEventRoutingLevel;
  status: ProviderEventStatus;
  summary: string;
  received_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

export class ProviderEventConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEventConflictError";
  }
}

export class ProviderEventNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEventNotFoundError";
  }
}

export class SqliteProviderEventStore {
  constructor(private readonly store: StensiblyStore) {
    this.ensureSchema();
  }

  ingestGitHubPullRequestReview(
    input: IngestGitHubPullRequestReviewInput,
  ): { event: ProviderEvent; duplicate: boolean } {
    const transaction = this.store.db.transaction(() => {
      const existing = this.store.db
        .query<ProviderEventRow, [string, string]>(`
          SELECT *
          FROM provider_events
          WHERE provider = ?1 AND delivery_id = ?2
        `)
        .get("github", input.deliveryId);

      if (existing) {
        if (existing.payload_digest !== input.payloadDigest) {
          throw new ProviderEventConflictError(
            "GitHub delivery identity was reused with a different payload",
          );
        }
        return { event: mapProviderEvent(existing), duplicate: true };
      }

      const id = `provider_event_${randomUUID()}`;
      this.store.db
        .query(`
          INSERT INTO provider_events (
            id,
            provider,
            delivery_id,
            payload_digest,
            event_type,
            external_object_id,
            repository,
            subject_number,
            action,
            revision,
            actor,
            routing_level,
            status,
            summary,
            received_at
          ) VALUES (
            ?1, 'github', ?2, ?3, 'pull_request_review', ?4, ?5, ?6, ?7, ?8, ?9,
            'record', 'pending', ?10, ?11
          )
        `)
        .run(
          id,
          input.deliveryId,
          input.payloadDigest,
          input.externalObjectId,
          input.repository,
          input.subjectNumber,
          input.action,
          input.revision,
          input.actor ?? null,
          input.summary,
          input.receivedAt,
        );

      return { event: this.get(id), duplicate: false };
    });

    return transaction();
  }

  list(options: ProviderEventListOptions = {}): ProviderEvent[] {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROVIDER_EVENT_LIST) {
      throw new RangeError(
        `Provider event limit must be between 1 and ${MAX_PROVIDER_EVENT_LIST}`,
      );
    }

    const rows = this.store.db
      .query<ProviderEventRow, [ProviderEventStatus | null, number]>(`
        SELECT *
        FROM provider_events
        WHERE (?1 IS NULL OR status = ?1)
        ORDER BY
          CASE WHEN ?1 = 'pending' THEN received_at END ASC,
          CASE WHEN ?1 = 'pending' THEN id END ASC,
          CASE WHEN ?1 IS NULL OR ?1 = 'acknowledged' THEN received_at END DESC,
          CASE WHEN ?1 IS NULL OR ?1 = 'acknowledged' THEN id END DESC
        LIMIT ?2
      `)
      .all(options.status ?? null, limit);

    return rows.map(mapProviderEvent);
  }

  acknowledge(id: string, actor: string, acknowledgedAt: string): ProviderEvent {
    const transaction = this.store.db.transaction(() => {
      const existing = this.get(id);
      if (existing.status === "acknowledged") {
        if (existing.acknowledgedBy !== actor) {
          throw new ProviderEventConflictError(
            "Provider event was already acknowledged by another actor",
          );
        }
        return existing;
      }

      const result = this.store.db
        .query(`
          UPDATE provider_events
          SET status = 'acknowledged',
              acknowledged_at = ?1,
              acknowledged_by = ?2
          WHERE id = ?3 AND status = 'pending'
        `)
        .run(acknowledgedAt, actor, id);

      if (result.changes !== 1) {
        throw new ProviderEventConflictError(
          "Provider event acknowledgement changed concurrently",
        );
      }

      return this.get(id);
    });

    return transaction();
  }

  private get(id: string): ProviderEvent {
    const row = this.store.db
      .query<ProviderEventRow, [string]>(`
        SELECT *
        FROM provider_events
        WHERE id = ?1
      `)
      .get(id);
    if (!row) {
      throw new ProviderEventNotFoundError(`Provider event ${id} does not exist`);
    }
    return mapProviderEvent(row);
  }

  private ensureSchema(): void {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'github'),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type = 'pull_request_review'),
        external_object_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        subject_number INTEGER NOT NULL CHECK (subject_number > 0),
        action TEXT NOT NULL,
        revision TEXT NOT NULL,
        actor TEXT,
        routing_level TEXT NOT NULL CHECK (routing_level IN ('record', 'attention', 'interrupt')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged')),
        summary TEXT NOT NULL,
        received_at TEXT NOT NULL,
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        UNIQUE (provider, delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_events_status_received
        ON provider_events(status, received_at DESC, id DESC);
    `);
  }
}

function mapProviderEvent(row: ProviderEventRow): ProviderEvent {
  return {
    id: row.id,
    provider: row.provider,
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    externalObjectId: row.external_object_id,
    repository: row.repository,
    subjectNumber: row.subject_number,
    action: row.action,
    revision: row.revision,
    actor: row.actor,
    routingLevel: row.routing_level,
    status: row.status,
    summary: row.summary,
    receivedAt: row.received_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}
