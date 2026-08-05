import { sha256, stableJson } from "./canonical-json.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  compileOrchestratorActivityObservation,
  type OrchestratorActivityObservation,
} from "./orchestrator-activity-observation.js";

export interface OrchestratorActivityIngestionInput {
  deliveryId: string;
  deliveryFingerprint: string;
  acceptedAt: string;
  observation: unknown;
}

export interface OrchestratorActivityIngestionReceipt {
  schemaVersion: 1;
  receiptId: string;
  deliveryId: string;
  deliveryFingerprint: string;
  requestFingerprint: string;
  observationId: string;
  observationFingerprint: string;
  sourceClass: OrchestratorActivityObservation["sourceClass"];
  sourceId: string;
  acceptedAt: string;
}

export interface OrchestratorActivityIngestionResult {
  receipt: OrchestratorActivityIngestionReceipt;
  observation: OrchestratorActivityObservation;
  replayed: boolean;
  observationAppended: boolean;
}

interface StoredDelivery {
  requestFingerprint: string;
  receipt: OrchestratorActivityIngestionReceipt;
  observation: OrchestratorActivityObservation;
}

const inputFields = new Set<string>([
  "deliveryId",
  "deliveryFingerprint",
  "acceptedAt",
  "observation",
]);
const requiredInputFields = [
  "deliveryId",
  "deliveryFingerprint",
  "acceptedAt",
  "observation",
] as const;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;

/**
 * Reference exactly-once ingestion store for automatic orchestrator activity.
 *
 * This in-memory implementation defines replay, delivery-conflict, source-
 * identity, and semantic-deduplication behavior for later durable adapters. It
 * grants no authority and does not claim restart durability.
 */
export class InMemoryOrchestratorActivityIngestionStore {
  readonly #deliveries = new Map<string, StoredDelivery>();
  readonly #observations = new Map<string, OrchestratorActivityObservation>();
  readonly #sourceObservations = new Map<string, OrchestratorActivityObservation>();

  ingest(input: unknown): OrchestratorActivityIngestionResult {
    const record = exactInputRecord(input);
    const deliveryId = identifier(record.deliveryId, "delivery ID");
    const deliveryFingerprint = fingerprint(
      record.deliveryFingerprint,
      "delivery fingerprint",
    );
    const acceptedAt = canonicalTimestamp(record.acceptedAt, "accepted time");
    const observation = compileOrchestratorActivityObservation(record.observation);
    if (acceptedAt < observation.observedAt) {
      throw new Error("Accepted time cannot precede observed time");
    }

    const requestFingerprint = sha256(stableJson({
      deliveryId,
      deliveryFingerprint,
      observationFingerprint: observation.observationFingerprint,
    }));
    const existingDelivery = this.#deliveries.get(deliveryId);
    if (existingDelivery) {
      if (existingDelivery.requestFingerprint !== requestFingerprint) {
        throw new Error("Orchestrator activity delivery identity conflict");
      }
      return Object.freeze({
        receipt: existingDelivery.receipt,
        observation: existingDelivery.observation,
        replayed: true,
        observationAppended: false,
      });
    }

    const sourceKey = stableJson([
      observation.workspace,
      observation.project,
      observation.sourceClass,
      observation.sourceId,
    ]);
    const existingSource = this.#sourceObservations.get(sourceKey);
    if (
      existingSource
      && existingSource.observationFingerprint
        !== observation.observationFingerprint
    ) {
      throw new Error("Orchestrator activity source identity conflict");
    }

    const existingObservation = this.#observations.get(
      observation.observationId,
    );
    const canonicalObservation = existingObservation ?? existingSource
      ?? observation;
    if (
      canonicalObservation.observationFingerprint
        !== observation.observationFingerprint
    ) {
      throw new Error("Orchestrator activity observation identity conflict");
    }

    const receiptPayload = {
      schemaVersion: 1 as const,
      deliveryId,
      deliveryFingerprint,
      requestFingerprint,
      observationId: canonicalObservation.observationId,
      observationFingerprint: canonicalObservation.observationFingerprint,
      sourceClass: canonicalObservation.sourceClass,
      sourceId: canonicalObservation.sourceId,
      acceptedAt,
    };
    const receiptId = `oair_${sha256(stableJson(receiptPayload)).slice(
      "sha256:".length,
      39,
    )}`;
    const receipt = Object.freeze({
      ...receiptPayload,
      receiptId,
    });
    this.#deliveries.set(deliveryId, Object.freeze({
      requestFingerprint,
      receipt,
      observation: canonicalObservation,
    }));
    this.#sourceObservations.set(sourceKey, canonicalObservation);

    const observationAppended = !existingObservation && !existingSource;
    if (observationAppended) {
      this.#observations.set(
        canonicalObservation.observationId,
        canonicalObservation,
      );
    }

    return Object.freeze({
      receipt,
      observation: canonicalObservation,
      replayed: false,
      observationAppended,
    });
  }

  getReceipt(
    deliveryId: unknown,
  ): OrchestratorActivityIngestionReceipt | null {
    const admitted = identifier(deliveryId, "delivery ID");
    return this.#deliveries.get(admitted)?.receipt ?? null;
  }

  listObservations(): readonly OrchestratorActivityObservation[] {
    return Object.freeze([...this.#observations.values()]);
  }

  get deliveryCount(): number {
    return this.#deliveries.size;
  }

  get observationCount(): number {
    return this.#observations.size;
  }
}

function exactInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Orchestrator activity ingestion input must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("Orchestrator activity ingestion input could not be inspected");
  }
  if (isArray) {
    throw new Error("Orchestrator activity ingestion input must be an object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      "Orchestrator activity ingestion input must use a plain or null prototype",
    );
  }
  if (Object.getOwnPropertySymbols(descriptors).length > 0) {
    throw new Error("Orchestrator activity ingestion input contains a symbol field");
  }

  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!inputFields.has(key)) {
      throw new Error("Orchestrator activity ingestion input has an unknown field");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(
        `Orchestrator activity ingestion field ${key} must be an enumerable data property`,
      );
    }
    record[key] = descriptor.value;
  }
  for (const key of requiredInputFields) {
    if (!Object.hasOwn(record, key)) {
      throw new Error(`Orchestrator activity ingestion is missing field ${key}`);
    }
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new Error(`${label} cannot contain credential material`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be an exact SHA-256 fingerprint`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  if (canonical !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return canonical;
}
