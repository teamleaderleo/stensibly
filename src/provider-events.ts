import { randomUUID } from "node:crypto";
import type { StensiblyStore } from "./store.js";

export const MAX_PROVIDER_EVENT_LIST = 100;
export const DEFAULT_MAX_PROVIDER_EVENTS = 10_000;
export const DEFAULT_ACKNOWLEDGED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_PRUNE_PER_INGEST = 1_000;

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

export interface ProviderEventStoreOptions {
  maxStoredEvents?: number;
  acknowledgedRetentionMs?: number;
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

interface ProviderEventDeliveryRow {
  provider: "github";
  delivery_id: string;
  payload_digest: string;
  event_id: string;
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

export class ProviderEventCapacityError extends Error {
  constructor(message = "Provider event storage capacity is exhausted") {
    super(message);
    this.name = "ProviderEventCapacityError";
  }
}

export class SqliteProviderEventStore {
  private readonly maxStoredEvents: number;
  private readonly acknowledgedRetentionMs: number;

  constructor(
    private readonly store: StensiblyStore,
    options: ProviderEventStoreOptions = {},
  ) {
    this.maxStoredEvents = boundedInteger(
      options.maxStoredEvents ?? DEFAULT_MAX_PROVIDER_EVENTS,
      "Provider event capacity",
      1,
      100_000,
    );
    this.acknowledgedRetentionMs = boundedInteger(
      options.acknowledgedRetentionMs ?? DEFAULT_ACKNOWLEDGED_RETENTION_MS,
      "Acknowledged provider event retention",
      0,
      365 * 24 * 60 * 60 * 1_000,
    );
    this.ensureSchema();
  }

  ingestGitHubPullRequestReview(
    input: IngestGitHubPullRequestReviewInput,
  ): { event: ProviderEvent; duplicate: boolean } {
    const transaction = this.store.db.transaction(() => {
      const existingDelivery = this.findByDeliveryId(input.deliveryId);
      if (existingDelivery) {
        if (existingDelivery.payload_digest !== input.payloadDigest) {
          throw new ProviderEventConflictError(
            "GitHub delivery identity was reused with a different payload",
          );
        }
        return { event: mapProviderEvent(existingDelivery), duplicate: true };
      }

      const existingPayload = this.findByPayloadDigest(input.payloadDigest);
      if (existingPayload) {
        this.makeCapacity(input.receivedAt, existingPayload.id);
        this.reserveDeliveryIdentity(
          input.deliveryId,
          input.payloadDigest,
          existingPayload.id,
        );
        return { event: mapProviderEvent(existingPayload), duplicate: true };
      }

      this.makeCapacity(input.receivedAt);
      const id = `provider_event_${randomUUID()}`;
      try {
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
        this.reserveDeliveryIdentity(input.deliveryId, input.payloadDigest, id);
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const replayedDelivery = this.findByDeliveryId(input.deliveryId);
        if (replayedDelivery) {
          if (replayedDelivery.payload_digest !== input.payloadDigest) {
            throw new ProviderEventConflictError(
              "GitHub delivery identity was reused with a different payload",
            );
          }
          return { event: mapProviderEvent(replayedDelivery), duplicate: true };
        }
        const replayedPayload = this.findByPayloadDigest(input.payloadDigest);
        if (replayedPayload) {
          this.reserveDeliveryIdentity(
            input.deliveryId,
            input.payloadDigest,
            replayedPayload.id,
          );
          return { event: mapProviderEvent(replayedPayload), duplicate: true };
        }
        throw error;
      }

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

    let rows: ProviderEventRow[];
    if (options.status === "pending") {
      rows = this.store.db
        .query<ProviderEventRow, [number]>(`
          SELECT *
          FROM provider_events
          WHERE status = 'pending'
          ORDER BY received_at ASC, id ASC
          LIMIT ?1
        `)
        .all(limit);
    } else if (options.status === "acknowledged") {
      rows = this.store.db
        .query<ProviderEventRow, [number]>(`
          SELECT *
          FROM provider_events
          WHERE status = 'acknowledged'
          ORDER BY received_at DESC, id DESC
          LIMIT ?1
        `)
        .all(limit);
    } else {
      rows = this.store.db
        .query<ProviderEventRow, [number]>(`
          SELECT *
          FROM provider_events
          ORDER BY received_at DESC, id DESC
          LIMIT ?1
        `)
        .all(limit);
    }

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

  private findByDeliveryId(deliveryId: string): ProviderEventRow | null {
    return this.store.db
      .query<ProviderEventRow, [string, string]>(`
        SELECT events.*
        FROM provider_event_deliveries AS deliveries
        INNER JOIN provider_events AS events ON events.id = deliveries.event_id
        WHERE deliveries.provider = ?1 AND deliveries.delivery_id = ?2
      `)
      .get("github", deliveryId) ?? null;
  }

  private findDeliveryIdentity(deliveryId: string): ProviderEventDeliveryRow | null {
    return this.store.db
      .query<ProviderEventDeliveryRow, [string, string]>(`
        SELECT provider, delivery_id, payload_digest, event_id
        FROM provider_event_deliveries
        WHERE provider = ?1 AND delivery_id = ?2
      `)
      .get("github", deliveryId) ?? null;
  }

  private findByPayloadDigest(payloadDigest: string): ProviderEventRow | null {
    return this.store.db
      .query<ProviderEventRow, [string, string]>(`
        SELECT *
        FROM provider_events
        WHERE provider = ?1 AND payload_digest = ?2
      `)
      .get("github", payloadDigest) ?? null;
  }

  private reserveDeliveryIdentity(
    deliveryId: string,
    payloadDigest: string,
    eventId: string,
  ): void {
    try {
      this.store.db
        .query(`
          INSERT INTO provider_event_deliveries (
            provider,
            delivery_id,
            payload_digest,
            event_id
          ) VALUES ('github', ?1, ?2, ?3)
        `)
        .run(deliveryId, payloadDigest, eventId);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = this.findDeliveryIdentity(deliveryId);
      if (
        !existing
        || existing.payload_digest !== payloadDigest
        || existing.event_id !== eventId
      ) {
        throw new ProviderEventConflictError(
          "GitHub delivery identity was reused with a different payload",
        );
      }
    }
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

  private makeCapacity(receivedAt: string, protectedEventId: string | null = null): void {
    const receivedAtMs = Date.parse(receivedAt);
    if (!Number.isFinite(receivedAtMs)) {
      throw new RangeError("Provider event receipt time must be a valid timestamp");
    }
    const cutoff = new Date(receivedAtMs - this.acknowledgedRetentionMs).toISOString();
    this.store.db
      .query(`
        DELETE FROM provider_events
        WHERE id IN (
          SELECT id
          FROM provider_events
          WHERE status = 'acknowledged'
            AND acknowledged_at IS NOT NULL
            AND acknowledged_at < ?1
            AND (?3 IS NULL OR id <> ?3)
          ORDER BY acknowledged_at ASC, id ASC
          LIMIT ?2
        )
      `)
      .run(cutoff, MAX_PRUNE_PER_INGEST, protectedEventId);

    let count = this.countDeliveryRows();
    if (count < this.maxStoredEvents) return;

    const needed = Math.min(
      count - this.maxStoredEvents + 1,
      MAX_PRUNE_PER_INGEST,
    );
    this.store.db
      .query(`
        DELETE FROM provider_events
        WHERE id IN (
          SELECT id
          FROM provider_events
          WHERE status = 'acknowledged'
            AND (?2 IS NULL OR id <> ?2)
          ORDER BY acknowledged_at ASC, received_at ASC, id ASC
          LIMIT ?1
        )
      `)
      .run(needed, protectedEventId);

    count = this.countDeliveryRows();
    if (count >= this.maxStoredEvents) {
      throw new ProviderEventCapacityError();
    }
  }

  private countDeliveryRows(): number {
    const row = this.store.db
      .query<{ total: number }, []>(`
        SELECT COUNT(*) AS total
        FROM provider_event_deliveries
      `)
      .get();
    return row?.total ?? 0;
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

      CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_events_provider_payload
        ON provider_events(provider, payload_digest);

      CREATE INDEX IF NOT EXISTS idx_provider_events_status_received
        ON provider_events(status, received_at, id);

      CREATE INDEX IF NOT EXISTS idx_provider_events_received
        ON provider_events(received_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_provider_events_acknowledged
        ON provider_events(status, acknowledged_at, received_at, id);

      CREATE TABLE IF NOT EXISTS provider_event_deliveries (
        provider TEXT NOT NULL CHECK (provider = 'github'),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (provider, delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_event_deliveries_event
        ON provider_event_deliveries(event_id);

      INSERT OR IGNORE INTO provider_event_deliveries (
        provider,
        delivery_id,
        payload_digest,
        event_id
      )
      SELECT provider, delivery_id, payload_digest, id
      FROM provider_events;

      CREATE TRIGGER IF NOT EXISTS trg_provider_events_delete_deliveries
      AFTER DELETE ON provider_events
      BEGIN
        DELETE FROM provider_event_deliveries WHERE event_id = OLD.id;
      END;
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

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("UNIQUE constraint failed:");
}
