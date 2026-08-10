import { randomUUID } from "node:crypto";
import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  createProjectRepositorySetupObservationRecord,
  prepareProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservationLedger,
  type ProjectRepositorySetupObservationRecord,
  type ProjectRepositorySetupObservationResult,
  type RecordProjectRepositorySetupObservationInput,
} from "./project-repository-setup-observation.js";

const getCurrentRef = makeFunctionReference<"query">(
  "projectRepositorySetupObservations:getCurrent",
);
const recordRef = makeFunctionReference<"mutation">(
  "projectRepositorySetupObservations:record",
);
const invalidResponse = "Hosted repository setup observation response is invalid";

export interface ConvexProjectRepositorySetupObservationLedgerOptions {
  client: ConvexCaller;
  serviceSecret: string;
  workspace?: string;
}

export class ConvexProjectRepositorySetupObservationLedger
  implements ProjectRepositorySetupObservationLedger {
  readonly #client: ConvexCaller;
  readonly #serviceSecret: string;
  readonly #workspace: string;

  constructor(options: ConvexProjectRepositorySetupObservationLedgerOptions) {
    this.#client = options.client;
    this.#serviceSecret = required(options.serviceSecret, "Convex service secret");
    this.#workspace = exactSlug(options.workspace ?? "default", "Workspace");
  }

  async getProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservationRecord | null> {
    const normalizedProject = exactSlug(project, "Project");
    const raw = await this.#client.query(getCurrentRef, this.#args({
      project: normalizedProject,
    }));
    return raw === null ? null : admitObservation(raw, normalizedProject);
  }

  async recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ): Promise<ProjectRepositorySetupObservationResult> {
    const prepared = prepareProjectRepositorySetupObservation(null, input);
    const raw = await this.#client.mutation(recordRef, this.#args({
      project: prepared.project,
      repositoryFullName: prepared.repositoryFullName,
      defaultBranch: prepared.defaultBranch,
      sourceKind: prepared.sourceKind,
      externalId: `repo_setup_${randomUUID()}`,
    }));
    const response = exactResponse(raw);
    const observation = admitObservation(response.observation, prepared.project);
    if (observation.semanticFingerprint !== prepared.semanticFingerprint) {
      throw new Error("Hosted repository setup observation response does not match request");
    }
    if (response.replayed && response.replacedObservationId !== null) {
      throw new Error("Hosted repository setup observation response does not match request");
    }
    return {
      observation,
      replayed: response.replayed,
      replacedObservationId: response.replacedObservationId,
    };
  }

  #args(input: object): Record<string, unknown> {
    return {
      serviceSecret: this.#serviceSecret,
      workspace: this.#workspace,
      ...input,
    };
  }
}

function admitObservation(
  value: unknown,
  expectedProject: string,
): ProjectRepositorySetupObservationRecord {
  const record = exactRecord(value, [
    "version",
    "id",
    "project",
    "repositoryFullName",
    "defaultBranch",
    "sourceKind",
    "semanticFingerprint",
    "observedAt",
    "authorizesProviderEffect",
    "containsSecrets",
  ]);
  const observation = createProjectRepositorySetupObservationRecord({
    id: exactText(record.id),
    project: exactText(record.project),
    repositoryFullName: exactText(record.repositoryFullName),
    defaultBranch: exactText(record.defaultBranch),
    sourceKind: exactText(record.sourceKind) as ProjectRepositorySetupObservationRecord["sourceKind"],
    semanticFingerprint: exactText(record.semanticFingerprint),
    observedAt: exactText(record.observedAt),
  });
  if (
    record.version !== 1
    || record.authorizesProviderEffect !== false
    || record.containsSecrets !== false
    || observation.project !== expectedProject
  ) {
    throw new Error(invalidResponse);
  }
  return observation;
}

function exactResponse(value: unknown): {
  observation: unknown;
  replayed: boolean;
  replacedObservationId: string | null;
} {
  const record = exactRecord(value, [
    "observation",
    "replayed",
    "replacedObservationId",
  ]);
  if (
    typeof record.replayed !== "boolean"
    || (record.replacedObservationId !== null && typeof record.replacedObservationId !== "string")
  ) {
    throw new Error(invalidResponse);
  }
  return {
    observation: record.observation,
    replayed: record.replayed,
    replacedObservationId: record.replacedObservationId as string | null,
  };
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(invalidResponse);
  }
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error(invalidResponse);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(invalidResponse);
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new Error(invalidResponse);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(invalidResponse);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactText(value: unknown): string {
  if (typeof value !== "string") throw new Error(invalidResponse);
  return value;
}

function exactSlug(value: string, label: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError(`${label} must be an exact lowercase slug up to 80 characters`);
  }
  return value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) throw new Error(`${label} is required`);
  return value;
}
