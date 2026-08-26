import { stableJson, sha256 } from "./canonical-json.js";
import {
  applicationLaneWakeToDispatchTriggerV1,
  parseDispatchTriggerV1,
  type DispatchTriggerV1,
} from "./dispatch-trigger.js";
import {
  dispatchExactWorkAtClaimGeneration,
  type ExactGenerationDispatchInput,
} from "./exact-generation-dispatch.js";
import {
  ensureApplicationLaneWakeStoreSchema,
  getApplicationLaneWakeIntent,
} from "./application-lane-wake-store.js";
import {
  ensureApplicationLaneBindingSchema,
  getSqliteApplicationLaneBinding,
} from "./application-lane-binding-sqlite-store.js";
import { ensureDispatchSchema } from "./dispatcher.js";
import { ensureRunExecutionSchema } from "./run-execution-store.js";
import { ensureRunSchema } from "./runs.js";
import type { StensiblyStore } from "./store.js";

export const DISPATCH_TRIGGER_CONSUMPTION_RECEIPT_V1 = 1 as const;

export interface DispatchTriggerConsumptionReceiptV1 {
  readonly version: 1;
  readonly kind: "dispatch_trigger_consumption";
  readonly triggerFingerprint: string;
  readonly triggerIdempotencyKey: string;
  readonly project: string;
  readonly itemId: string;
  readonly expectedClaimGeneration: number;
  readonly claimedGeneration: number;
  readonly sourceRef: string;
  readonly sourceFingerprint: string;
  readonly runId: string;
  readonly consumedAt: string;
  readonly grantsAuthority: false;
  readonly authorizesFurtherDispatch: false;
  readonly fingerprint: string;
}

export type ApplicationLaneDispatchTriggerConsumptionOutcome =
  | {
      readonly status: "consumed";
      readonly replay: boolean;
      readonly receipt: DispatchTriggerConsumptionReceiptV1;
    }
  | {
      readonly status: "stale_source";
      readonly triggerFingerprint: string;
    }
  | {
      readonly status: "stale_generation";
      readonly triggerFingerprint: string;
      readonly expectedClaimGeneration: number;
      readonly currentClaimGeneration: number;
    }
  | {
      readonly status: "unavailable";
      readonly triggerFingerprint: string;
    };

export interface ConsumeApplicationLaneDispatchTriggerInput {
  readonly trigger: unknown;
  readonly dispatch: Omit<
    ExactGenerationDispatchInput,
    "itemId" | "expectedClaimGeneration" | "project"
  >;
}

interface ConsumptionRow {
  trigger_idempotency_key: string;
  trigger_fingerprint: string;
  project_id: string;
  item_id: string;
  expected_claim_generation: number;
  claimed_generation: number;
  source_ref: string;
  source_fingerprint: string;
  run_id: string;
  receipt_json: string;
  receipt_fingerprint: string;
  consumed_at: string;
}

export class DispatchTriggerConsumptionConflictError extends Error {
  readonly code = "dispatch_trigger_consumption_conflict";

  constructor(message = "Dispatch trigger consumption conflict") {
    super(message);
    this.name = "DispatchTriggerConsumptionConflictError";
  }
}

export class DispatchTriggerConsumptionStorageError extends Error {
  readonly code = "dispatch_trigger_consumption_storage_failed";

  constructor(message = "Dispatch trigger consumption storage failed") {
    super(message);
    this.name = "DispatchTriggerConsumptionStorageError";
  }
}

export function ensureDispatchTriggerConsumptionSchema(store: StensiblyStore): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS dispatch_trigger_consumptions (
      trigger_idempotency_key TEXT PRIMARY KEY,
      trigger_fingerprint TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      expected_claim_generation INTEGER NOT NULL CHECK (expected_claim_generation >= 0),
      claimed_generation INTEGER NOT NULL CHECK (claimed_generation >= 1),
      source_ref TEXT NOT NULL UNIQUE,
      source_fingerprint TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE REFERENCES work_runs(id) ON DELETE CASCADE,
      receipt_json TEXT NOT NULL,
      receipt_fingerprint TEXT NOT NULL,
      consumed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_dispatch_trigger_consumption_item_generation
      ON dispatch_trigger_consumptions(project_id, item_id, expected_claim_generation, consumed_at);
  `);
}

/**
 * Consume one durable same-item application wake through the provider-neutral
 * dispatch trigger and the existing exact-item dispatcher.
 *
 * The trigger grants no authority. This function re-reads the Stensibly-owned
 * wake source, requires the current application binding to remain exact, then
 * delegates the claim/run mutation to the existing generation-fenced exact
 * dispatcher. The receipt is inserted in the same outer SQLite transaction, so
 * a receipt failure rolls the dispatch back.
 */
export function consumeApplicationLaneDispatchTrigger(
  store: StensiblyStore,
  inputValue: unknown,
  now = new Date(),
): ApplicationLaneDispatchTriggerConsumptionOutcome {
  const input = admitConsumptionInput(inputValue);
  const trigger = parseDispatchTriggerV1(input.trigger);
  if (trigger.triggerClass !== "wake_intent") {
    throw new DispatchTriggerConsumptionConflictError(
      "Application lane trigger consumption requires a wake-intent trigger",
    );
  }
  const consumedAt = exactDate(now, "Dispatch trigger consumption time");

  // Initialize all schema owners before acquiring the outer write transaction.
  // The exact-generation dispatcher then nests as savepoints only.
  ensureApplicationLaneWakeStoreSchema(store);
  ensureApplicationLaneBindingSchema(store);
  ensureRunSchema(store);
  ensureDispatchSchema(store);
  ensureRunExecutionSchema(store);
  ensureDispatchTriggerConsumptionSchema(store);

  const transaction = store.db.transaction((): ApplicationLaneDispatchTriggerConsumptionOutcome => {
    const replay = getConsumptionRow(store, trigger.idempotencyKey);
    if (replay) {
      const receipt = mapConsumptionRow(replay);
      if (
        receipt.triggerFingerprint !== trigger.fingerprint
        || receipt.sourceRef !== trigger.sourceRef
        || receipt.sourceFingerprint !== trigger.sourceFingerprint
        || receipt.project !== trigger.project
        || receipt.itemId !== trigger.itemId
        || receipt.expectedClaimGeneration !== trigger.expectedClaimGeneration
      ) {
        throw new DispatchTriggerConsumptionConflictError();
      }
      return freeze({ status: "consumed" as const, replay: true, receipt });
    }

    const wake = getApplicationLaneWakeIntent(store, trigger.sourceRef);
    if (!wake) {
      return freeze({
        status: "stale_source" as const,
        triggerFingerprint: trigger.fingerprint,
      });
    }
    const sourceTrigger = applicationLaneWakeToDispatchTriggerV1(wake);
    if (stableJson(sourceTrigger) !== stableJson(trigger)) {
      throw new DispatchTriggerConsumptionConflictError(
        "Dispatch trigger does not match its durable wake source",
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
      return freeze({
        status: "stale_source" as const,
        triggerFingerprint: trigger.fingerprint,
      });
    }

    const dispatchOutcome = dispatchExactWorkAtClaimGeneration(store, {
      ...input.dispatch,
      project: trigger.project,
      itemId: trigger.itemId,
      expectedClaimGeneration: trigger.expectedClaimGeneration,
    }, new Date(consumedAt));
    if (dispatchOutcome.status === "stale_generation") {
      return freeze({
        status: "stale_generation" as const,
        triggerFingerprint: trigger.fingerprint,
        expectedClaimGeneration: trigger.expectedClaimGeneration,
        currentClaimGeneration: dispatchOutcome.currentClaimGeneration,
      });
    }
    if (dispatchOutcome.status === "unavailable") {
      return freeze({
        status: "unavailable" as const,
        triggerFingerprint: trigger.fingerprint,
      });
    }

    const receipt = buildReceipt(
      trigger,
      dispatchOutcome.result.item.claimGeneration,
      dispatchOutcome.result.run.id,
      consumedAt,
    );
    store.db.query(`
      INSERT INTO dispatch_trigger_consumptions (
        trigger_idempotency_key,
        trigger_fingerprint,
        project_id,
        item_id,
        expected_claim_generation,
        claimed_generation,
        source_ref,
        source_fingerprint,
        run_id,
        receipt_json,
        receipt_fingerprint,
        consumed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    `).run(
      trigger.idempotencyKey,
      trigger.fingerprint,
      trigger.project,
      trigger.itemId,
      trigger.expectedClaimGeneration,
      receipt.claimedGeneration,
      trigger.sourceRef,
      trigger.sourceFingerprint,
      receipt.runId,
      stableJson(receipt),
      receipt.fingerprint,
      consumedAt,
    );
    const stored = getConsumptionRow(store, trigger.idempotencyKey);
    if (!stored) throw new DispatchTriggerConsumptionStorageError();
    return freeze({
      status: "consumed" as const,
      replay: false,
      receipt: mapConsumptionRow(stored),
    });
  });

  return transaction.immediate();
}

export function getDispatchTriggerConsumptionReceipt(
  store: StensiblyStore,
  triggerIdempotencyKey: string,
): DispatchTriggerConsumptionReceiptV1 | null {
  ensureDispatchTriggerConsumptionSchema(store);
  const key = exactTriggerKey(triggerIdempotencyKey);
  const row = getConsumptionRow(store, key);
  return row ? mapConsumptionRow(row) : null;
}

function buildReceipt(
  trigger: DispatchTriggerV1,
  claimedGeneration: number,
  runId: string,
  consumedAt: string,
): DispatchTriggerConsumptionReceiptV1 {
  if (claimedGeneration !== trigger.expectedClaimGeneration + 1) {
    throw new DispatchTriggerConsumptionStorageError();
  }
  const core = {
    version: 1 as const,
    kind: "dispatch_trigger_consumption" as const,
    triggerFingerprint: trigger.fingerprint,
    triggerIdempotencyKey: trigger.idempotencyKey,
    project: trigger.project,
    itemId: trigger.itemId,
    expectedClaimGeneration: trigger.expectedClaimGeneration,
    claimedGeneration,
    sourceRef: trigger.sourceRef,
    sourceFingerprint: trigger.sourceFingerprint,
    runId: exactIdentifier(runId, "Dispatch trigger consumption run ID"),
    consumedAt,
    grantsAuthority: false as const,
    authorizesFurtherDispatch: false as const,
  };
  return freeze({ ...core, fingerprint: sha256(stableJson(core)) });
}

function getConsumptionRow(
  store: StensiblyStore,
  key: string,
): ConsumptionRow | null {
  return store.db
    .query<ConsumptionRow, [string]>(`
      SELECT * FROM dispatch_trigger_consumptions
      WHERE trigger_idempotency_key = ?1
      LIMIT 1
    `)
    .get(key);
}

function mapConsumptionRow(row: ConsumptionRow): DispatchTriggerConsumptionReceiptV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt_json);
  } catch {
    throw new DispatchTriggerConsumptionStorageError();
  }
  const receipt = parseReceipt(parsed);
  const valid = stableJson(receipt) === row.receipt_json
    && row.trigger_idempotency_key === receipt.triggerIdempotencyKey
    && row.trigger_fingerprint === receipt.triggerFingerprint
    && row.project_id === receipt.project
    && row.item_id === receipt.itemId
    && row.expected_claim_generation === receipt.expectedClaimGeneration
    && row.claimed_generation === receipt.claimedGeneration
    && row.source_ref === receipt.sourceRef
    && row.source_fingerprint === receipt.sourceFingerprint
    && row.run_id === receipt.runId
    && row.receipt_fingerprint === receipt.fingerprint
    && row.consumed_at === receipt.consumedAt;
  if (!valid) throw new DispatchTriggerConsumptionStorageError();
  return receipt;
}

function parseReceipt(value: unknown): DispatchTriggerConsumptionReceiptV1 {
  const input = strictRecord(value, "Dispatch trigger consumption receipt", [
    "version",
    "kind",
    "triggerFingerprint",
    "triggerIdempotencyKey",
    "project",
    "itemId",
    "expectedClaimGeneration",
    "claimedGeneration",
    "sourceRef",
    "sourceFingerprint",
    "runId",
    "consumedAt",
    "grantsAuthority",
    "authorizesFurtherDispatch",
    "fingerprint",
  ]);
  if (input.version !== 1 || input.kind !== "dispatch_trigger_consumption") {
    throw new DispatchTriggerConsumptionStorageError();
  }
  if (input.grantsAuthority !== false || input.authorizesFurtherDispatch !== false) {
    throw new DispatchTriggerConsumptionStorageError();
  }
  const expectedClaimGeneration = nonNegativeGeneration(input.expectedClaimGeneration);
  const claimedGeneration = positiveGeneration(input.claimedGeneration);
  const core = {
    version: 1 as const,
    kind: "dispatch_trigger_consumption" as const,
    triggerFingerprint: exactFingerprint(input.triggerFingerprint),
    triggerIdempotencyKey: exactTriggerKey(input.triggerIdempotencyKey),
    project: exactProject(input.project),
    itemId: exactIdentifier(input.itemId, "Dispatch trigger consumption item ID"),
    expectedClaimGeneration,
    claimedGeneration,
    sourceRef: exactWakeSourceRef(input.sourceRef),
    sourceFingerprint: exactFingerprint(input.sourceFingerprint),
    runId: exactIdentifier(input.runId, "Dispatch trigger consumption run ID"),
    consumedAt: exactTimestamp(input.consumedAt),
    grantsAuthority: false as const,
    authorizesFurtherDispatch: false as const,
  };
  if (claimedGeneration !== expectedClaimGeneration + 1) {
    throw new DispatchTriggerConsumptionStorageError();
  }
  const fingerprint = sha256(stableJson(core));
  if (input.fingerprint !== fingerprint) throw new DispatchTriggerConsumptionStorageError();
  return freeze({ ...core, fingerprint });
}

function admitConsumptionInput(value: unknown): ConsumeApplicationLaneDispatchTriggerInput {
  const input = strictRecord(value, "Application lane trigger consumption input", ["trigger", "dispatch"]);
  const dispatch = strictRecord(input.dispatch, "Application lane trigger dispatch input", [
    "actor",
    "runnerType",
    "runnerProfile",
    "runnerProfileVersion",
    "leaseSeconds",
    "continuationRef",
    "executionEnvelope",
  ], true);
  const detachedDispatch = Object.freeze(dispatch)
    as unknown as ConsumeApplicationLaneDispatchTriggerInput["dispatch"];
  return Object.freeze({
    trigger: input.trigger,
    dispatch: detachedDispatch,
  });
}

function strictRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
  allowMissing = false,
): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new TypeError(`${label} must be an object`);
  let isArray: boolean;
  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: PropertyDescriptorMap;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${label} inspection failed`);
  }
  if (isArray) throw new TypeError(`${label} must be an object`);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  if (symbols.length > 0) throw new TypeError(`${label} contains symbol decoration`);
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain enumerable data properties`);
    }
    if (!keys.includes(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
    output[key] = descriptor.value;
  }
  if (!allowMissing) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) {
        throw new TypeError(`${label} is missing required field ${key}`);
      }
    }
  }
  return output;
}

function exactTriggerKey(value: unknown): string {
  if (typeof value !== "string" || !/^dispatch-trigger:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Dispatch trigger consumption key is invalid");
  }
  return value;
}

function exactWakeSourceRef(value: unknown): string {
  if (typeof value !== "string" || !/^application-lane-wake:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Dispatch trigger consumption wake source is invalid");
  }
  return value;
}

function exactFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Dispatch trigger consumption fingerprint is invalid");
  }
  return value;
}

function exactProject(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(value) || value.length > 80) {
    throw new TypeError("Dispatch trigger consumption project is invalid");
  }
  return value;
}

function exactIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 240
    || value.trim() !== value
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function nonNegativeGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError("Dispatch trigger consumption expected generation is invalid");
  }
  return value;
}

function positiveGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Dispatch trigger consumption claimed generation is invalid");
  }
  return value;
}

function exactTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 80) throw new TypeError("Dispatch trigger consumption time is invalid");
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    throw new TypeError("Dispatch trigger consumption time is invalid");
  }
  return value;
}

function exactDate(value: Date, label: string): string {
  if (!(value instanceof Date)) throw new TypeError(`${label} is invalid`);
  const millis = Date.prototype.getTime.call(value);
  if (!Number.isFinite(millis)) throw new TypeError(`${label} is invalid`);
  return new Date(millis).toISOString();
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  return Object.freeze(value);
}