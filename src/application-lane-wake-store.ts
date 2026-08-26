import { stableJson } from "./canonical-json.js";
import {
  parseApplicationLaneWakeIntentV1,
  type ApplicationLaneWakeIntentV1,
} from "./application-lane-wake-intent.js";
import { getSqliteApplicationLaneBinding } from "./application-lane-binding-sqlite-store.js";
import {
  NotFoundError,
  type StensiblyStore,
} from "./store.js";

interface ApplicationLaneWakeRow {
  source_ref: string;
  project_id: string;
  item_id: string;
  claim_generation: number;
  binding_id: string;
  binding_generation: number;
  lane_ref: string;
  lane_generation: number;
  source_event_id: string;
  wake_fingerprint: string;
  wake_json: string;
  recorded_at: string;
}

export class ApplicationLaneWakeConflictError extends Error {
  readonly code = "application_lane_wake_conflict";

  constructor(message = "Application lane wake conflict") {
    super(message);
    this.name = "ApplicationLaneWakeConflictError";
  }
}

export class ApplicationLaneWakeStorageError extends Error {
  readonly code = "application_lane_wake_storage_failed";

  constructor(message = "Application lane wake storage failed") {
    super(message);
    this.name = "ApplicationLaneWakeStorageError";
  }
}

export function ensureApplicationLaneWakeStoreSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS application_lane_wake_intents (
      source_ref TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      claim_generation INTEGER NOT NULL CHECK (claim_generation >= 0),
      binding_id TEXT NOT NULL,
      binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
      lane_ref TEXT NOT NULL,
      lane_generation INTEGER NOT NULL CHECK (lane_generation >= 1),
      source_event_id TEXT NOT NULL,
      wake_fingerprint TEXT NOT NULL,
      wake_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_application_lane_wake_item_generation
      ON application_lane_wake_intents(project_id, item_id, claim_generation, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_application_lane_wake_binding_generation
      ON application_lane_wake_intents(project_id, binding_id, binding_generation, recorded_at);
  `);
}

/**
 * Persist one same-item application wake after re-admitting its exact bytes and
 * proving that its work generation and application relation are current at the
 * first durable admission. Exact replay returns the original admitted wake even
 * after later work/binding movement.
 */
export function recordApplicationLaneWakeIntent(
  store: StensiblyStore,
  value: unknown,
  recordedAt = new Date(),
): ApplicationLaneWakeIntentV1 {
  ensureApplicationLaneWakeStoreSchema(store);
  const wake = parseApplicationLaneWakeIntentV1(value);
  const sourceRef = exactSourceRef(wake.idempotencyKey);
  const wakeJson = stableJson(wake);
  const recordedAtIso = exactDate(recordedAt, "Application lane wake recorded time");
  if (Date.parse(recordedAtIso) < Date.parse(wake.observedAt)) {
    throw new RangeError("Application lane wake cannot be recorded before its observation");
  }

  return store.db.transaction(() => {
    const replay = getWakeRow(store, sourceRef);
    if (replay) {
      const stored = mapWakeRow(replay);
      if (replay.wake_json !== wakeJson || stored.fingerprint !== wake.fingerprint) {
        throw new ApplicationLaneWakeConflictError(
          "Application lane wake source reference already belongs to different evidence",
        );
      }
      return stored;
    }

    let item;
    try {
      item = store.getItem(wake.itemId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new ApplicationLaneWakeConflictError("Application lane wake item is unavailable");
      }
      throw error;
    }
    if (
      item.project !== wake.project
      || item.claimGeneration !== wake.claimGeneration
    ) {
      throw new ApplicationLaneWakeConflictError(
        "Application lane wake no longer matches the current work generation",
      );
    }

    const binding = getSqliteApplicationLaneBinding(store, wake.project, wake.bindingId);
    if (
      !binding
      || binding.retiredAt !== null
      || binding.itemId !== wake.itemId
      || binding.generation !== wake.bindingGeneration
      || binding.laneRef !== wake.laneRef
      || binding.laneGeneration !== wake.laneGeneration
      || !binding.capabilities.includes("events")
    ) {
      throw new ApplicationLaneWakeConflictError(
        "Application lane wake no longer matches the current application binding",
      );
    }

    store.db.query(`
      INSERT INTO application_lane_wake_intents (
        source_ref,
        project_id,
        item_id,
        claim_generation,
        binding_id,
        binding_generation,
        lane_ref,
        lane_generation,
        source_event_id,
        wake_fingerprint,
        wake_json,
        recorded_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    `).run(
      sourceRef,
      wake.project,
      wake.itemId,
      wake.claimGeneration,
      wake.bindingId,
      wake.bindingGeneration,
      wake.laneRef,
      wake.laneGeneration,
      wake.sourceEventId,
      wake.fingerprint,
      wakeJson,
      recordedAtIso,
    );

    const stored = getWakeRow(store, sourceRef);
    if (!stored) throw new ApplicationLaneWakeStorageError();
    return mapWakeRow(stored);
  })();
}

export function getApplicationLaneWakeIntent(
  store: StensiblyStore,
  sourceRefInput: string,
): ApplicationLaneWakeIntentV1 | null {
  ensureApplicationLaneWakeStoreSchema(store);
  const sourceRef = exactSourceRef(sourceRefInput);
  const row = getWakeRow(store, sourceRef);
  return row ? mapWakeRow(row) : null;
}

function getWakeRow(
  store: StensiblyStore,
  sourceRef: string,
): ApplicationLaneWakeRow | null {
  return store.db
    .query<ApplicationLaneWakeRow, [string]>(`
      SELECT *
      FROM application_lane_wake_intents
      WHERE source_ref = ?1
      LIMIT 1
    `)
    .get(sourceRef);
}

function mapWakeRow(row: ApplicationLaneWakeRow): ApplicationLaneWakeIntentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.wake_json);
  } catch {
    throw new ApplicationLaneWakeStorageError();
  }
  let wake: ApplicationLaneWakeIntentV1;
  try {
    wake = parseApplicationLaneWakeIntentV1(parsed);
  } catch {
    throw new ApplicationLaneWakeStorageError();
  }
  const valid = stableJson(wake) === row.wake_json
    && row.source_ref === wake.idempotencyKey
    && row.project_id === wake.project
    && row.item_id === wake.itemId
    && row.claim_generation === wake.claimGeneration
    && row.binding_id === wake.bindingId
    && row.binding_generation === wake.bindingGeneration
    && row.lane_ref === wake.laneRef
    && row.lane_generation === wake.laneGeneration
    && row.source_event_id === wake.sourceEventId
    && row.wake_fingerprint === wake.fingerprint
    && typeof row.recorded_at === "string"
    && new Date(row.recorded_at).toISOString() === row.recorded_at
    && Date.parse(row.recorded_at) >= Date.parse(wake.observedAt);
  if (!valid) throw new ApplicationLaneWakeStorageError();
  return wake;
}

function exactSourceRef(value: string): string {
  if (
    typeof value !== "string"
    || !/^application-lane-wake:[a-f0-9]{64}$/u.test(value)
  ) {
    throw new TypeError("Application lane wake source reference is invalid");
  }
  return value;
}

function exactDate(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.toISOString();
}
