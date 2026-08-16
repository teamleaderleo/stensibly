import { makeFunctionReference, type FunctionReference } from "convex/server";
import { stableJson } from "./canonical-json.js";
import { containsRealisticRetainedCredential } from "./github-retained-credential-policy.js";
import {
  admitOrchestratorActivityIngestionReceipt,
  compileOrchestratorActivityIngestionCandidate,
} from "./orchestrator-activity-ingestion-candidate.js";
import type {
  OrchestratorActivityIngestionReceipt,
  OrchestratorActivityIngestionResult,
} from "./orchestrator-activity-ingestion.js";
import {
  admitOrchestratorActivityObservation,
  orchestratorActivityObservationInput,
} from "./orchestrator-activity-observation-admission.js";
import type {
  OrchestratorActivityObservation,
} from "./orchestrator-activity-observation.js";

export interface OrchestratorActivityConvexCaller {
  query(reference: FunctionReference<"query">, args: Record<string, unknown>): Promise<unknown>;
  mutation(reference: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface ConvexOrchestratorActivityIngestionStoreOptions {
  client: OrchestratorActivityConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export interface DurableOrchestratorActivityObservationList {
  readonly observations: readonly OrchestratorActivityObservation[];
  readonly truncated: boolean;
}

const ingestRef = makeFunctionReference<"mutation">("orchestratorActivity:ingest");
const receiptRef = makeFunctionReference<"query">("orchestratorActivity:getReceipt");
const listRef = makeFunctionReference<"query">("orchestratorActivity:listObservations");
const workspacePattern = /^[a-z0-9][a-z0-9-_]{0,79}$/u;

export class ConvexOrchestratorActivityIngestionStore {
  readonly #client: OrchestratorActivityConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexOrchestratorActivityIngestionStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("Orchestrator activity Convex options are required");
    }
    if (
      !options.client
      || typeof options.client.query !== "function"
      || typeof options.client.mutation !== "function"
    ) {
      throw new TypeError("Orchestrator activity Convex client is required");
    }
    this.#client = options.client;
    this.#serviceSecret = serviceSecret(options.serviceSecret);
    this.#workspace = workspaceSlug(options.workspace ?? "default");
  }

  async ingest(input: unknown): Promise<OrchestratorActivityIngestionResult> {
    const candidate = compileOrchestratorActivityIngestionCandidate(input);
    if (candidate.observation.workspace !== this.#workspace) {
      throw new Error("Orchestrator activity ingestion workspace does not match the durable store");
    }
    const raw = responseRecord(await this.#client.mutation(ingestRef, {
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
      project: candidate.observation.project,
      ingestionJson: stableJson({
        deliveryId: candidate.deliveryId,
        deliveryFingerprint: candidate.deliveryFingerprint,
        acceptedAt: candidate.acceptedAt,
        observation: orchestratorActivityObservationInput(candidate.observation),
      }),
    }), "Orchestrator activity ingestion");
    const receipt = admitOrchestratorActivityIngestionReceipt(
      parseJson(raw.receiptJson, "Orchestrator activity receipt"),
    );
    const observation = admitOrchestratorActivityObservation(
      parseJson(raw.observationJson, "Orchestrator activity observation"),
    );
    if (
      receipt.workspace !== this.#workspace
      || receipt.project !== candidate.observation.project
      || receipt.deliveryId !== candidate.deliveryId
      || receipt.deliveryFingerprint !== candidate.deliveryFingerprint
      || receipt.requestFingerprint !== candidate.requestFingerprint
      || receipt.observationId !== observation.observationId
      || receipt.observationFingerprint !== observation.observationFingerprint
      || observation.observationFingerprint !== candidate.observation.observationFingerprint
      || stableJson(observation) !== stableJson(candidate.observation)
    ) {
      throw new Error("Orchestrator activity durable ingestion response is inconsistent");
    }
    const replayed = exactBoolean(raw.replayed, "Orchestrator activity replay state");
    const observationAppended = exactBoolean(
      raw.observationAppended,
      "Orchestrator activity append state",
    );
    if (replayed && observationAppended) {
      throw new Error("Replayed orchestrator activity cannot append an observation");
    }
    return Object.freeze({
      receipt,
      observation,
      replayed,
      observationAppended,
    });
  }

  async getReceipt(
    workspace: unknown,
    project: unknown,
    deliveryId: unknown,
  ): Promise<OrchestratorActivityIngestionReceipt | null> {
    const requestedWorkspace = workspaceSlug(workspace);
    if (requestedWorkspace !== this.#workspace) {
      throw new Error("Orchestrator activity receipt workspace does not match the durable store");
    }
    const requestedProject = projectSlug(project);
    const requestedDeliveryId = identifier(deliveryId, "delivery ID");
    const raw = await this.#client.query(receiptRef, {
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
      project: requestedProject,
      deliveryId: requestedDeliveryId,
    });
    if (raw === null) return null;
    const record = responseRecord(raw, "Orchestrator activity receipt lookup");
    const receipt = admitOrchestratorActivityIngestionReceipt(
      parseJson(record.receiptJson, "Orchestrator activity receipt"),
    );
    if (
      receipt.workspace !== this.#workspace
      || receipt.project !== requestedProject
      || receipt.deliveryId !== requestedDeliveryId
    ) {
      throw new Error("Orchestrator activity durable receipt escaped lookup scope");
    }
    return receipt;
  }

  async listObservations(
    workspace: unknown,
    project: unknown,
    limit = 256,
  ): Promise<DurableOrchestratorActivityObservationList> {
    const requestedWorkspace = workspaceSlug(workspace);
    if (requestedWorkspace !== this.#workspace) {
      throw new Error("Orchestrator activity list workspace does not match the durable store");
    }
    const requestedProject = projectSlug(project);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Orchestrator activity durable list limit is invalid");
    }
    const raw = responseRecord(await this.#client.query(listRef, {
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
      project: requestedProject,
      limit,
    }), "Orchestrator activity observation list");
    if (!Array.isArray(raw.observations) || raw.observations.length > limit) {
      throw new RangeError("Orchestrator activity durable observation list is invalid");
    }
    const observations = raw.observations.map((value, index) => {
      const row = responseRecord(value, "Orchestrator activity durable observation row");
      if (row.appendOrder !== index + 1) {
        throw new Error("Orchestrator activity durable append order is not contiguous");
      }
      const observation = admitOrchestratorActivityObservation(
        parseJson(row.observationJson, "Orchestrator activity observation"),
      );
      if (
        observation.workspace !== this.#workspace
        || observation.project !== requestedProject
      ) {
        throw new Error("Orchestrator activity durable observation escaped list scope");
      }
      return observation;
    });
    return Object.freeze({
      observations: Object.freeze(observations),
      truncated: exactBoolean(raw.truncated, "Orchestrator activity list truncation"),
    });
  }
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} response is invalid`);
  }
  return value as Record<string, unknown>;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string" || value.length < 2 || value.length > 64 * 1024) {
    throw new TypeError(`${label} JSON is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function workspaceSlug(value: unknown): string {
  if (typeof value !== "string" || !workspacePattern.test(value)) {
    throw new TypeError("Orchestrator activity workspace is invalid");
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError("Orchestrator activity workspace cannot contain credential material");
  }
  return value;
}

function projectSlug(value: unknown): string {
  if (typeof value !== "string" || !workspacePattern.test(value)) {
    throw new TypeError("Orchestrator activity project is invalid");
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError("Orchestrator activity project cannot contain credential material");
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 240
    || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(value)
  ) {
    throw new TypeError(`Orchestrator activity ${label} is invalid`);
  }
  if (containsRealisticRetainedCredential(value)) {
    throw new TypeError(`Orchestrator activity ${label} cannot contain credential material`);
  }
  return value;
}

function serviceSecret(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 64 * 1024
    || value !== value.trim()
  ) {
    throw new TypeError("Orchestrator activity service secret is required");
  }
  return value;
}
