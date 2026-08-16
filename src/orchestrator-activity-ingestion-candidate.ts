import { sha256, stableJson } from "./canonical-json.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  compileOrchestratorActivityObservation,
  ORCHESTRATOR_ACTIVITY_SOURCE_CLASSES,
  type OrchestratorActivityObservation,
} from "./orchestrator-activity-observation.js";
import type {
  OrchestratorActivityIngestionReceipt,
} from "./orchestrator-activity-ingestion.js";

export interface OrchestratorActivityIngestionCandidate {
  readonly deliveryId: string;
  readonly deliveryFingerprint: string;
  readonly acceptedAt: string;
  readonly requestFingerprint: string;
  readonly receipt: OrchestratorActivityIngestionReceipt;
  readonly observation: OrchestratorActivityObservation;
}

const requiredInputFields = [
  "deliveryId",
  "deliveryFingerprint",
  "acceptedAt",
  "observation",
] as const;
const receiptFields = [
  "schemaVersion",
  "receiptId",
  "workspace",
  "project",
  "deliveryId",
  "deliveryFingerprint",
  "requestFingerprint",
  "observationId",
  "observationFingerprint",
  "sourceClass",
  "sourceId",
  "acceptedAt",
] as const;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;
const scopeSlugPattern = /^[a-z0-9][a-z0-9_\-]{0,79}$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const receiptIdPattern = /^oair_[a-f0-9]{32}$/u;

/**
 * Admits one automatic-activity delivery and compiles the exact immutable
 * request fingerprint and receipt used by both reference and durable stores.
 * Persistence, replay, source conflict, and semantic deduplication stay store
 * responsibilities.
 */
export function compileOrchestratorActivityIngestionCandidate(
  input: unknown,
): OrchestratorActivityIngestionCandidate {
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

  const requestFingerprint = requestFingerprintFor({
    workspace: observation.workspace,
    project: observation.project,
    deliveryId,
    deliveryFingerprint,
    observationFingerprint: observation.observationFingerprint,
  });
  const receiptPayload = {
    schemaVersion: 1 as const,
    workspace: observation.workspace,
    project: observation.project,
    deliveryId,
    deliveryFingerprint,
    requestFingerprint,
    observationId: observation.observationId,
    observationFingerprint: observation.observationFingerprint,
    sourceClass: observation.sourceClass,
    sourceId: observation.sourceId,
    acceptedAt,
  };
  const receiptId = receiptIdFor(receiptPayload);
  const receipt = Object.freeze({ ...receiptPayload, receiptId });
  return Object.freeze({
    deliveryId,
    deliveryFingerprint,
    acceptedAt,
    requestFingerprint,
    receipt,
    observation,
  });
}

/** Re-admits one stored/provider receipt without requiring raw observation bytes. */
export function admitOrchestratorActivityIngestionReceipt(
  value: unknown,
): OrchestratorActivityIngestionReceipt {
  const record = exactReceiptRecord(value);
  if (record.schemaVersion !== 1) {
    throw new Error("Orchestrator activity receipt version is invalid");
  }
  const workspace = scopeSlug(record.workspace, "receipt workspace");
  const project = scopeSlug(record.project, "receipt project");
  const deliveryId = identifier(record.deliveryId, "receipt delivery ID");
  const deliveryFingerprint = fingerprint(
    record.deliveryFingerprint,
    "receipt delivery fingerprint",
  );
  const requestFingerprint = fingerprint(
    record.requestFingerprint,
    "receipt request fingerprint",
  );
  const observationId = identifier(record.observationId, "receipt observation ID");
  const observationFingerprint = fingerprint(
    record.observationFingerprint,
    "receipt observation fingerprint",
  );
  if (
    typeof record.sourceClass !== "string"
    || !ORCHESTRATOR_ACTIVITY_SOURCE_CLASSES.includes(
      record.sourceClass as (typeof ORCHESTRATOR_ACTIVITY_SOURCE_CLASSES)[number],
    )
  ) {
    throw new Error("Orchestrator activity receipt source class is invalid");
  }
  const sourceClass = record.sourceClass as OrchestratorActivityIngestionReceipt["sourceClass"];
  const sourceId = identifier(record.sourceId, "receipt source ID");
  const acceptedAt = canonicalTimestamp(record.acceptedAt, "receipt accepted time");
  const expectedRequestFingerprint = requestFingerprintFor({
    workspace,
    project,
    deliveryId,
    deliveryFingerprint,
    observationFingerprint,
  });
  if (requestFingerprint !== expectedRequestFingerprint) {
    throw new Error("Orchestrator activity receipt request fingerprint is inconsistent");
  }
  const receiptPayload = {
    schemaVersion: 1 as const,
    workspace,
    project,
    deliveryId,
    deliveryFingerprint,
    requestFingerprint,
    observationId,
    observationFingerprint,
    sourceClass,
    sourceId,
    acceptedAt,
  };
  const receiptId = typeof record.receiptId === "string" && receiptIdPattern.test(record.receiptId)
    ? record.receiptId
    : "";
  if (!receiptId || receiptId !== receiptIdFor(receiptPayload)) {
    throw new Error("Orchestrator activity receipt ID is inconsistent");
  }
  return Object.freeze({ ...receiptPayload, receiptId });
}

function requestFingerprintFor(input: {
  workspace: string;
  project: string;
  deliveryId: string;
  deliveryFingerprint: string;
  observationFingerprint: string;
}): string {
  return sha256(stableJson(input));
}

function receiptIdFor(input: Omit<OrchestratorActivityIngestionReceipt, "receiptId">): string {
  return `oair_${sha256(stableJson(input)).slice("sha256:".length, 39)}`;
}

function exactInputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Orchestrator activity ingestion input must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
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

  const record = Object.create(null) as Record<string, unknown>;
  for (const key of requiredInputFields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error("Orchestrator activity ingestion input could not be inspected");
    }
    if (!descriptor) {
      throw new Error(`Orchestrator activity ingestion is missing field ${key}`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(
        `Orchestrator activity ingestion field ${key} must be an enumerable data property`,
      );
    }
    record[key] = descriptor.value;
  }
  return record;
}

function exactReceiptRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("Orchestrator activity receipt must be an object");
  }
  let isArray: boolean;
  let prototype: object | null;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error("Orchestrator activity receipt could not be inspected");
  }
  if (isArray || (prototype !== Object.prototype && prototype !== null)) {
    throw new Error("Orchestrator activity receipt must be a plain object");
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of receiptFields) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error("Orchestrator activity receipt could not be inspected");
    }
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`Orchestrator activity receipt field ${key} is invalid`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function scopeSlug(value: unknown, label: string): string {
  if (typeof value !== "string" || !scopeSlugPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new Error(`${label} cannot contain credential material`);
  }
  return value;
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
