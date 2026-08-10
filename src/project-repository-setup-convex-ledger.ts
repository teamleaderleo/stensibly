import { makeFunctionReference } from "convex/server";
import type { ConvexCaller } from "./convex-ledger.js";
import {
  admitProjectRepositorySetupObservation,
  type ProjectRepositorySetupObservation,
} from "./project-repository-setup-observation.js";
import {
  prepareProjectRepositorySetupObservationReplacement,
  type ProjectRepositorySetupObservationLedger,
  type RecordProjectRepositorySetupObservationInput,
} from "./project-repository-setup-ledger.js";

const getCurrentRef = makeFunctionReference<"query">(
  "projectRepositorySetupObservations:getCurrent",
);
const listHistoryRef = makeFunctionReference<"query">(
  "projectRepositorySetupObservations:listHistory",
);
const recordRef = makeFunctionReference<"mutation">(
  "projectRepositorySetupObservations:record",
);

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
    this.#workspace = exactWorkspace(options.workspace ?? "default");
  }

  async getCurrentProjectRepositorySetupObservation(
    project: string,
  ): Promise<ProjectRepositorySetupObservation | null> {
    const raw = await this.#client.query(getCurrentRef, this.#args({
      project: exactProject(project),
    }));
    return raw === null ? null : admitProjectRepositorySetupObservation(raw);
  }

  async listProjectRepositorySetupObservationHistory(
    project: string,
    limit = 20,
  ): Promise<ProjectRepositorySetupObservation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Repository setup observation history limit is invalid");
    }
    const raw = await this.#client.query(listHistoryRef, this.#args({
      project: exactProject(project),
      limit,
    }));
    if (!Array.isArray(raw) || raw.length > limit) {
      throw new RangeError("Hosted repository setup observation history is invalid");
    }
    return raw.map(admitProjectRepositorySetupObservation);
  }

  async recordProjectRepositorySetupObservation(
    input: RecordProjectRepositorySetupObservationInput,
  ) {
    const current = await this.getCurrentProjectRepositorySetupObservation(input.project);
    const prepared = prepareProjectRepositorySetupObservationReplacement(current, input);
    if (prepared.replay) {
      return {
        observation: prepared.replay,
        replayed: true,
        replacedFingerprint: prepared.replacedFingerprint,
      };
    }

    const raw = await this.#client.mutation(recordRef, this.#args({
      project: prepared.observation.project,
      repositoryFullName: prepared.observation.repositoryFullName,
      defaultBranch: prepared.observation.defaultBranch,
      sourceKind: prepared.observation.sourceKind,
      observedAt: prepared.observation.observedAt,
      expectedCurrentFingerprint: prepared.replacedFingerprint,
    }));
    const response = exactResponse(raw);
    const observation = admitProjectRepositorySetupObservation(response.observation);
    if (
      response.replayed !== false
      || response.replacedFingerprint !== prepared.replacedFingerprint
      || observation.fingerprint !== prepared.observation.fingerprint
      || observation.project !== prepared.observation.project
    ) {
      throw new Error("Hosted repository setup observation response does not match request");
    }
    return {
      observation,
      replayed: false,
      replacedFingerprint: prepared.replacedFingerprint,
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

function exactResponse(value: unknown): {
  observation: unknown;
  replayed: boolean;
  replacedFingerprint: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hosted repository setup observation response is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ["observation", "replayed", "replacedFingerprint"];
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
  ) {
    throw new Error("Hosted repository setup observation response is invalid");
  }
  const read = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error("Hosted repository setup observation response is invalid");
    }
    return descriptor.value;
  };
  const replayed = read("replayed");
  const replacedFingerprint = read("replacedFingerprint");
  if (
    typeof replayed !== "boolean"
    || (
      replacedFingerprint !== null
      && (
        typeof replacedFingerprint !== "string"
        || !/^sha256:[a-f0-9]{64}$/u.test(replacedFingerprint)
      )
    )
  ) {
    throw new Error("Hosted repository setup observation response is invalid");
  }
  return {
    observation: read("observation"),
    replayed,
    replacedFingerprint: replacedFingerprint as string | null,
  };
}

function exactWorkspace(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("Workspace must be an exact lowercase slug up to 80 characters");
  }
  return value;
}

function exactProject(value: string): string {
  if (value !== value.trim() || !/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(value)) {
    throw new RangeError("Project must be an exact lowercase slug up to 80 characters");
  }
  return value;
}

function required(value: string, label: string): string {
  if (value.length < 1 || value !== value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}
