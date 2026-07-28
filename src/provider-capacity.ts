import { randomUUID } from "node:crypto";
import type { StensiblyStore } from "./store.js";

export const DEFAULT_AVAILABLE_CAPACITY_FRESHNESS_MS = 5 * 60 * 1_000;
export const DEFAULT_MAX_PROVIDER_CAPACITY_OBSERVATIONS = 10_000;
const MAX_REFILL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_PRUNE_PER_INGEST = 1_000;
const controlPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const deliveryPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const digestPattern = /^[0-9a-f]{64}$/i;

export type ProviderCapacityState = "available" | "unavailable" | "unknown";
export type ProviderCapacityObservedState = "available" | "unavailable";
export type ProviderCapacitySubjectBasis = "pull_request_author_proxy";
export type ProviderCapacityUnknownReason =
  | "not_observed"
  | "observation_stale"
  | "refill_window_elapsed";

export interface ParsedCodeRabbitCapacity {
  state: ProviderCapacityObservedState;
  remaining: number | null;
  limit: number | null;
  refillAt: string | null;
}

export interface CodeRabbitCapacityObservation {
  id: string;
  provider: "coderabbit";
  deliveryId: string;
  sourceCommentId: string;
  repository: string;
  pullRequestNumber: number;
  subjectLogin: string;
  subjectBasis: ProviderCapacitySubjectBasis;
  state: ProviderCapacityObservedState;
  remaining: number | null;
  limit: number | null;
  refillAt: string | null;
  observedAt: string;
  receivedAt: string;
}

export interface CodeRabbitCapacitySnapshot {
  provider: "coderabbit";
  repository: string;
  subjectLogin: string;
  subjectBasis: ProviderCapacitySubjectBasis;
  state: ProviderCapacityState;
  reason:
    | ProviderCapacityUnknownReason
    | "quota_exhausted"
    | "provider_reported_unavailable"
    | null;
  remaining: number | null;
  limit: number | null;
  observedAt: string | null;
  receivedAt: string | null;
  staleAt: string | null;
  refillAt: string | null;
  nextAvailableAt: string | null;
  source: {
    pullRequestNumber: number;
    commentId: string;
  } | null;
}

export interface IngestCodeRabbitCapacityInput {
  deliveryId: string;
  payloadDigest: string;
  sourceCommentId: string;
  repository: string;
  pullRequestNumber: number;
  subjectLogin: string;
  state: ProviderCapacityObservedState;
  remaining: number | null;
  limit: number | null;
  refillAt: string | null;
  observedAt: string;
  receivedAt: string;
}

export interface ProviderCapacityStoreOptions {
  maxStoredObservations?: number;
  availableFreshnessMs?: number;
}

interface ProviderCapacityObservationRow {
  id: string;
  provider: "coderabbit";
  delivery_id: string;
  payload_digest: string;
  source_comment_id: string;
  repository: string;
  pull_request_number: number;
  subject_login: string;
  subject_basis: ProviderCapacitySubjectBasis;
  provider_state: ProviderCapacityObservedState;
  remaining: number | null;
  quota_limit: number | null;
  refill_at: string | null;
  observed_at: string;
  received_at: string;
}

interface ProviderCapacityDeliveryRow {
  provider: "coderabbit";
  delivery_id: string;
  payload_digest: string;
  observation_id: string;
}

export class ProviderCapacityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCapacityConflictError";
  }
}

export class ProviderCapacityStorageError extends Error {
  constructor(message = "Provider capacity observation storage is at capacity") {
    super(message);
    this.name = "ProviderCapacityStorageError";
  }
}

export class SqliteProviderCapacityStore {
  private readonly maxStoredObservations: number;
  private readonly availableFreshnessMs: number;

  constructor(
    private readonly store: StensiblyStore,
    options: ProviderCapacityStoreOptions = {},
  ) {
    this.maxStoredObservations = boundedInteger(
      options.maxStoredObservations ?? DEFAULT_MAX_PROVIDER_CAPACITY_OBSERVATIONS,
      "Provider capacity observation limit",
      1,
      100_000,
    );
    this.availableFreshnessMs = boundedInteger(
      options.availableFreshnessMs ?? DEFAULT_AVAILABLE_CAPACITY_FRESHNESS_MS,
      "Available provider capacity freshness",
      1_000,
      60 * 60 * 1_000,
    );
    this.ensureSchema();
  }

  ingestCodeRabbit(
    input: IngestCodeRabbitCapacityInput,
  ): { observation: CodeRabbitCapacityObservation; duplicate: boolean } {
    validateIngestInput(input);
    const transaction = this.store.db.transaction(() => {
      const existingDelivery = this.findByDeliveryId(input.deliveryId);
      if (existingDelivery) {
        if (existingDelivery.payload_digest !== input.payloadDigest.toLowerCase()) {
          throw new ProviderCapacityConflictError(
            "GitHub delivery identity was reused with different provider capacity content",
          );
        }
        return {
          observation: mapObservation(existingDelivery),
          duplicate: true,
        };
      }

      const existingPayload = this.findByPayloadDigest(input.payloadDigest);
      if (existingPayload) {
        this.reserveDeliveryIdentity(
          input.deliveryId,
          input.payloadDigest,
          existingPayload.id,
        );
        return {
          observation: mapObservation(existingPayload),
          duplicate: true,
        };
      }

      this.makeCapacity();
      const id = `provider_capacity_${randomUUID()}`;
      this.store.db.query(`
        INSERT INTO provider_capacity_observations (
          id,
          provider,
          delivery_id,
          payload_digest,
          source_comment_id,
          repository,
          pull_request_number,
          subject_login,
          subject_basis,
          provider_state,
          remaining,
          quota_limit,
          refill_at,
          observed_at,
          received_at
        ) VALUES (
          ?1, 'coderabbit', ?2, ?3, ?4, ?5, ?6, ?7,
          'pull_request_author_proxy', ?8, ?9, ?10, ?11, ?12, ?13
        )
      `).run(
        id,
        input.deliveryId,
        input.payloadDigest.toLowerCase(),
        input.sourceCommentId,
        input.repository,
        input.pullRequestNumber,
        input.subjectLogin,
        input.state,
        input.remaining,
        input.limit,
        input.refillAt,
        input.observedAt,
        input.receivedAt,
      );
      this.reserveDeliveryIdentity(input.deliveryId, input.payloadDigest, id);
      return { observation: this.get(id), duplicate: false };
    });

    return transaction();
  }

  snapshot(
    repository: string,
    subjectLogin: string,
    now = Date.now(),
  ): CodeRabbitCapacitySnapshot {
    validateRepository(repository);
    validateLogin(subjectLogin);
    if (!Number.isFinite(now)) throw new RangeError("Capacity snapshot time must be finite");

    const observation = this.latest(repository, subjectLogin);
    if (!observation) {
      return emptySnapshot(repository, subjectLogin);
    }

    const observedAtMs = Date.parse(observation.observedAt);
    const refillAtMs = observation.refillAt === null
      ? null
      : Date.parse(observation.refillAt);
    const availableStaleAtMs = Math.min(
      observedAtMs + this.availableFreshnessMs,
      refillAtMs ?? Number.POSITIVE_INFINITY,
    );
    const staleAtMs = observation.state === "available"
      ? availableStaleAtMs
      : refillAtMs!;
    const staleAt = new Date(staleAtMs).toISOString();
    const common = {
      provider: "coderabbit" as const,
      repository,
      subjectLogin,
      subjectBasis: observation.subjectBasis,
      remaining: observation.remaining,
      limit: observation.limit,
      observedAt: observation.observedAt,
      receivedAt: observation.receivedAt,
      staleAt,
      refillAt: observation.refillAt,
      source: {
        pullRequestNumber: observation.pullRequestNumber,
        commentId: observation.sourceCommentId,
      },
    };

    if (refillAtMs !== null && now >= refillAtMs) {
      return {
        ...common,
        state: "unknown",
        reason: "refill_window_elapsed",
        nextAvailableAt: null,
      };
    }
    if (observation.state === "unavailable") {
      return {
        ...common,
        state: "unavailable",
        reason: observation.remaining === 0
          ? "quota_exhausted"
          : "provider_reported_unavailable",
        nextAvailableAt: observation.refillAt,
      };
    }
    if (now >= availableStaleAtMs) {
      return {
        ...common,
        state: "unknown",
        reason: "observation_stale",
        nextAvailableAt: null,
      };
    }
    return {
      ...common,
      state: "available",
      reason: null,
      nextAvailableAt: null,
    };
  }

  private latest(repository: string, subjectLogin: string): CodeRabbitCapacityObservation | null {
    const row = this.store.db.query<ProviderCapacityObservationRow, [string, string]>(`
      SELECT *
      FROM provider_capacity_observations
      WHERE provider = 'coderabbit'
        AND repository = ?1
        AND subject_login = ?2
      ORDER BY observed_at DESC, received_at DESC, id DESC
      LIMIT 1
    `).get(repository, subjectLogin);
    return row ? mapObservation(row) : null;
  }

  private get(id: string): CodeRabbitCapacityObservation {
    const row = this.store.db.query<ProviderCapacityObservationRow, [string]>(`
      SELECT *
      FROM provider_capacity_observations
      WHERE id = ?1
    `).get(id);
    if (!row) throw new Error("Provider capacity observation disappeared after insertion");
    return mapObservation(row);
  }

  private findByDeliveryId(deliveryId: string): ProviderCapacityObservationRow | null {
    return this.store.db.query<ProviderCapacityObservationRow, [string, string]>(`
      SELECT observations.*
      FROM provider_capacity_deliveries AS deliveries
      INNER JOIN provider_capacity_observations AS observations
        ON observations.id = deliveries.observation_id
      WHERE deliveries.provider = ?1 AND deliveries.delivery_id = ?2
    `).get("coderabbit", deliveryId) ?? null;
  }

  private findByPayloadDigest(payloadDigest: string): ProviderCapacityObservationRow | null {
    return this.store.db.query<ProviderCapacityObservationRow, [string, string]>(`
      SELECT *
      FROM provider_capacity_observations
      WHERE provider = ?1 AND payload_digest = ?2
    `).get("coderabbit", payloadDigest.toLowerCase()) ?? null;
  }

  private reserveDeliveryIdentity(
    deliveryId: string,
    payloadDigest: string,
    observationId: string,
  ): void {
    try {
      this.store.db.query(`
        INSERT INTO provider_capacity_deliveries (
          provider,
          delivery_id,
          payload_digest,
          observation_id
        ) VALUES ('coderabbit', ?1, ?2, ?3)
      `).run(deliveryId, payloadDigest.toLowerCase(), observationId);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = this.store.db
        .query<ProviderCapacityDeliveryRow, [string, string]>(`
          SELECT provider, delivery_id, payload_digest, observation_id
          FROM provider_capacity_deliveries
          WHERE provider = ?1 AND delivery_id = ?2
        `)
        .get("coderabbit", deliveryId);
      if (
        !existing
        || existing.payload_digest !== payloadDigest.toLowerCase()
        || existing.observation_id !== observationId
      ) {
        throw new ProviderCapacityConflictError(
          "GitHub delivery identity was reused with different provider capacity content",
        );
      }
    }
  }

  private makeCapacity(): void {
    const count = this.store.db.query<{ total: number }, []>(`
      SELECT COUNT(*) AS total FROM provider_capacity_observations
    `).get()?.total ?? 0;
    if (count < this.maxStoredObservations) return;

    const needed = Math.min(
      count - this.maxStoredObservations + 1,
      MAX_PRUNE_PER_INGEST,
    );
    this.store.db.query(`
      DELETE FROM provider_capacity_observations
      WHERE id IN (
        SELECT id
        FROM provider_capacity_observations
        ORDER BY observed_at ASC, received_at ASC, id ASC
        LIMIT ?1
      )
    `).run(needed);

    const remaining = this.store.db.query<{ total: number }, []>(`
      SELECT COUNT(*) AS total FROM provider_capacity_observations
    `).get()?.total ?? 0;
    if (remaining >= this.maxStoredObservations) {
      throw new ProviderCapacityStorageError();
    }
  }

  private ensureSchema(): void {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_capacity_observations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider = 'coderabbit'),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL UNIQUE,
        source_comment_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        subject_login TEXT NOT NULL,
        subject_basis TEXT NOT NULL CHECK (subject_basis = 'pull_request_author_proxy'),
        provider_state TEXT NOT NULL CHECK (provider_state IN ('available', 'unavailable')),
        remaining INTEGER,
        quota_limit INTEGER,
        refill_at TEXT,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_capacity_deliveries (
        provider TEXT NOT NULL CHECK (provider = 'coderabbit'),
        delivery_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        observation_id TEXT NOT NULL
          REFERENCES provider_capacity_observations(id) ON DELETE CASCADE,
        PRIMARY KEY (provider, delivery_id)
      );

      CREATE INDEX IF NOT EXISTS idx_provider_capacity_latest
        ON provider_capacity_observations(
          provider,
          repository,
          subject_login,
          observed_at DESC,
          received_at DESC
        );
    `);
  }
}

export function parseCodeRabbitCapacityComment(
  body: string,
  observedAt: string,
): ParsedCodeRabbitCapacity | null {
  if (body.length < 1 || body.length > 100_000) return null;
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) return null;

  const quotaMatch = /\b(\d{1,4})\s*\/\s*(\d{1,4})\s+reviews?\s+remaining\b/iu.exec(body);
  const refillMatch = /\brefills?\s+in\s+([^\n.]{1,100})/iu.exec(body);
  if (quotaMatch?.[1] && quotaMatch[2] && refillMatch?.[1]) {
    const remaining = Number(quotaMatch[1]);
    const limit = Number(quotaMatch[2]);
    if (!Number.isInteger(remaining) || !Number.isInteger(limit)) return null;
    if (limit < 1 || limit > 1_000 || remaining < 0 || remaining > limit) return null;

    const refillDurationMs = parseDuration(refillMatch[1]);
    if (refillDurationMs === null) return null;
    return {
      state: remaining === 0 ? "unavailable" : "available",
      remaining,
      limit,
      refillAt: new Date(observedAtMs + refillDurationMs).toISOString(),
    };
  }

  if (/\breviews are available now\b/iu.test(body)) {
    return {
      state: "available",
      remaining: null,
      limit: null,
      refillAt: null,
    };
  }

  const unavailableDuration = firstCapturedDuration(body, [
    /\bmore reviews will be available in\s+([^\n.]{1,100})/iu,
    /\bplease wait\s+([^\n.]{1,100})\s+before requesting another review\b/iu,
  ]);
  if (unavailableDuration !== null) {
    return {
      state: "unavailable",
      remaining: null,
      limit: null,
      refillAt: new Date(observedAtMs + unavailableDuration).toISOString(),
    };
  }

  return null;
}

function firstCapturedDuration(body: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const value = pattern.exec(body)?.[1];
    if (!value) continue;
    const parsed = parseDuration(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseDuration(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  const tokenPattern = /(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)/gu;
  let total = 0;
  let tokenCount = 0;
  for (const match of normalized.matchAll(tokenPattern)) {
    const amountText = match[1];
    const unit = match[2];
    if (!amountText || !unit) return null;
    const amount = Number(amountText);
    if (!Number.isInteger(amount) || amount < 0 || amount > 10_000) return null;
    tokenCount += 1;
    if (unit.startsWith("hour") || unit.startsWith("hr")) {
      total += amount * 60 * 60 * 1_000;
    } else if (unit.startsWith("minute") || unit.startsWith("min")) {
      total += amount * 60 * 1_000;
    } else {
      total += amount * 1_000;
    }
  }
  if (tokenCount < 1 || total < 1_000 || total > MAX_REFILL_WINDOW_MS) return null;

  const remainder = normalized
    .replace(tokenPattern, "")
    .replace(/\band\b/gu, "")
    .replace(/[\s,&+]/gu, "");
  if (remainder.length > 0) return null;
  return total;
}

function validateIngestInput(input: IngestCodeRabbitCapacityInput): void {
  if (!deliveryPattern.test(input.deliveryId)) {
    throw new RangeError("Provider capacity delivery identity is invalid");
  }
  if (!digestPattern.test(input.payloadDigest)) {
    throw new RangeError("Provider capacity payload digest must be SHA-256");
  }
  if (!/^\d{1,30}$/u.test(input.sourceCommentId)) {
    throw new RangeError("Provider capacity source comment identity is invalid");
  }
  validateRepository(input.repository);
  validateLogin(input.subjectLogin);
  boundedInteger(input.pullRequestNumber, "Pull request number", 1, Number.MAX_SAFE_INTEGER);
  if (input.state !== "available" && input.state !== "unavailable") {
    throw new RangeError("Provider capacity state is invalid");
  }
  if ((input.remaining === null) !== (input.limit === null)) {
    throw new RangeError("Provider capacity remaining and limit must be supplied together");
  }
  if (input.remaining !== null && input.limit !== null) {
    boundedInteger(input.limit, "CodeRabbit review limit", 1, 1_000);
    boundedInteger(input.remaining, "CodeRabbit reviews remaining", 0, input.limit);
    if (input.state === "available" && input.remaining === 0) {
      throw new RangeError("Available provider capacity must not report zero remaining");
    }
    if (input.state === "unavailable" && input.remaining !== 0) {
      throw new RangeError("Unavailable provider capacity must report zero remaining when counted");
    }
  }

  const observedAt = parseTimestamp(input.observedAt, "Provider capacity observation time");
  const receivedAt = parseTimestamp(input.receivedAt, "Provider capacity receipt time");
  if (input.refillAt !== null) {
    const refillAt = parseTimestamp(input.refillAt, "Provider capacity refill time");
    if (refillAt <= observedAt || refillAt - observedAt > MAX_REFILL_WINDOW_MS) {
      throw new RangeError("Provider capacity refill time is outside the bounded window");
    }
  } else if (input.state === "unavailable") {
    throw new RangeError("Unavailable provider capacity requires a refill time");
  }
  if (observedAt > receivedAt + 5 * 60 * 1_000) {
    throw new RangeError("Provider capacity observation time is too far in the future");
  }
}

function validateRepository(repository: string): void {
  if (
    repository.length < 3
    || repository.length > 200
    || controlPattern.test(repository)
    || !repositoryPattern.test(repository)
  ) {
    throw new RangeError("Provider capacity repository is invalid");
  }
}

function validateLogin(login: string): void {
  if (
    login.length < 1
    || login.length > 120
    || controlPattern.test(login)
    || !loginPattern.test(login)
  ) {
    throw new RangeError("Provider capacity subject login is invalid");
  }
}

function parseTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} must be a valid timestamp`);
  return parsed;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function mapObservation(row: ProviderCapacityObservationRow): CodeRabbitCapacityObservation {
  return {
    id: row.id,
    provider: row.provider,
    deliveryId: row.delivery_id,
    sourceCommentId: row.source_comment_id,
    repository: row.repository,
    pullRequestNumber: row.pull_request_number,
    subjectLogin: row.subject_login,
    subjectBasis: row.subject_basis,
    state: row.provider_state,
    remaining: row.remaining,
    limit: row.quota_limit,
    refillAt: row.refill_at,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
  };
}

function emptySnapshot(repository: string, subjectLogin: string): CodeRabbitCapacitySnapshot {
  return {
    provider: "coderabbit",
    repository,
    subjectLogin,
    subjectBasis: "pull_request_author_proxy",
    state: "unknown",
    reason: "not_observed",
    remaining: null,
    limit: null,
    observedAt: null,
    receivedAt: null,
    staleAt: null,
    refillAt: null,
    nextAvailableAt: null,
    source: null,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
}
