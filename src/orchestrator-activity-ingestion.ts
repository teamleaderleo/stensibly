import { stableJson } from "./canonical-json.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  compileOrchestratorActivityIngestionCandidate,
} from "./orchestrator-activity-ingestion-candidate.js";
import type {
  OrchestratorActivityObservation,
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
  workspace: string;
  project: string;
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

const scopeSlugPattern = /^[a-z0-9][a-z0-9_\-]{0,79}$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,239}$/u;

/**
 * Reference exactly-once ingestion store for automatic orchestrator activity.
 *
 * This in-memory implementation defines replay, delivery-conflict, source-
 * identity, and semantic-deduplication behavior for durable adapters. It grants
 * no authority and does not claim restart durability.
 */
export class InMemoryOrchestratorActivityIngestionStore {
  readonly #deliveries = new Map<string, StoredDelivery>();
  readonly #observations = new Map<string, OrchestratorActivityObservation>();
  readonly #sourceObservations = new Map<string, OrchestratorActivityObservation>();

  ingest(input: unknown): OrchestratorActivityIngestionResult {
    const candidate = compileOrchestratorActivityIngestionCandidate(input);
    const { observation } = candidate;
    const deliveryKey = scopedDeliveryKey(
      observation.workspace,
      observation.project,
      candidate.deliveryId,
    );
    const existingDelivery = this.#deliveries.get(deliveryKey);
    if (existingDelivery) {
      if (existingDelivery.requestFingerprint !== candidate.requestFingerprint) {
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
      && existingSource.observationFingerprint !== observation.observationFingerprint
    ) {
      throw new Error("Orchestrator activity source identity conflict");
    }

    const existingObservation = this.#observations.get(observation.observationId);
    const canonicalObservation = existingObservation ?? existingSource ?? observation;
    if (
      canonicalObservation.observationFingerprint !== observation.observationFingerprint
    ) {
      throw new Error("Orchestrator activity observation identity conflict");
    }

    this.#deliveries.set(deliveryKey, Object.freeze({
      requestFingerprint: candidate.requestFingerprint,
      receipt: candidate.receipt,
      observation: canonicalObservation,
    }));
    this.#sourceObservations.set(sourceKey, canonicalObservation);

    const observationAppended = !existingObservation && !existingSource;
    if (observationAppended) {
      this.#observations.set(canonicalObservation.observationId, canonicalObservation);
    }

    return Object.freeze({
      receipt: candidate.receipt,
      observation: canonicalObservation,
      replayed: false,
      observationAppended,
    });
  }

  getReceipt(
    workspace: unknown,
    project: unknown,
    deliveryId: unknown,
  ): OrchestratorActivityIngestionReceipt | null {
    const admittedWorkspace = scopeSlug(workspace, "workspace");
    const admittedProject = scopeSlug(project, "project");
    const admittedDeliveryId = identifier(deliveryId, "delivery ID");
    return this.#deliveries.get(scopedDeliveryKey(
      admittedWorkspace,
      admittedProject,
      admittedDeliveryId,
    ))?.receipt ?? null;
  }

  listObservations(
    workspace: unknown,
    project: unknown,
  ): readonly OrchestratorActivityObservation[] {
    const admittedWorkspace = scopeSlug(workspace, "workspace");
    const admittedProject = scopeSlug(project, "project");
    return Object.freeze([...this.#observations.values()].filter(
      (observation) => observation.workspace === admittedWorkspace
        && observation.project === admittedProject,
    ));
  }

  get deliveryCount(): number {
    return this.#deliveries.size;
  }

  get observationCount(): number {
    return this.#observations.size;
  }
}

function scopedDeliveryKey(
  workspace: string,
  project: string,
  deliveryId: string,
): string {
  return stableJson([workspace, project, deliveryId]);
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
