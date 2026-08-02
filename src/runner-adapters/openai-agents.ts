import {
  OpenAIAgentsRunnerAdapter as BaseOpenAIAgentsRunnerAdapter,
  type OpenAIAgentsArtifactRecordV1,
  type OpenAIAgentsCheckpointAppendReceiptV1,
  type OpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsCheckpointRecordV1,
  type OpenAIAgentsExternalStore,
  type OpenAIAgentsRunnerAdapterOptions,
} from "./openai-agents-base.js";
import {
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerCheckpointCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../runner-adapter-v1.js";

export {
  OPENAI_AGENTS_PACKAGE_VERSION,
  OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION,
  finalizeOpenAIAgentsCheckpointAppendV1,
  openAIAgentsCheckpointAppendReplayFingerprintV1,
} from "./openai-agents-base.js";
export type {
  OpenAIAgentsArtifactRecordV1,
  OpenAIAgentsCapabilityInspector,
  OpenAIAgentsCheckpointAppendReceiptV1,
  OpenAIAgentsCheckpointAppendV1,
  OpenAIAgentsCheckpointRecordV1,
  OpenAIAgentsCompletion,
  OpenAIAgentsCompletionInput,
  OpenAIAgentsExternalStore,
  OpenAIAgentsResumePreparationInput,
  OpenAIAgentsRunnerAdapterOptions,
  OpenAIAgentsRuntime,
  OpenAIAgentsRuntimeFactory,
  OpenAIAgentsRuntimeFactoryInput,
} from "./openai-agents-base.js";

const exactTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const maximumSnapshotDepth = 32;
const maximumSnapshotNodes = 20_000;
const maximumSnapshotArrayLength = 4_096;
const maximumSnapshotObjectFields = 512;
const maximumControlEntries = 256;

type ControlCommand = RunnerCheckpointCommandV1 | RunnerCancellationCommandV1;

interface ControlIdentity {
  input: ControlCommand;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  holderId: string;
  authorityResource: string;
  authorityGeneration: number;
}

class ReplayChronologyStore implements OpenAIAgentsExternalStore {
  readonly #inner: OpenAIAgentsExternalStore;

  constructor(inner: OpenAIAgentsExternalStore) {
    this.#inner = inner;
  }

  async appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
    const receipt = snapshotJsonData(
      await this.#inner.appendCheckpoint(input),
      "OpenAI Agents checkpoint append receipt",
    ) as OpenAIAgentsCheckpointAppendReceiptV1;
    const createdAt = receipt.record?.createdAt;
    if (
      receipt.replayed === true
      && typeof createdAt === "string"
      && exactTimestampPattern.test(createdAt)
      && createdAt > input.proposedCreatedAt
    ) {
      throw new RangeError(
        "OpenAI Agents replayed checkpoint cannot be created after the current proposal",
      );
    }
    return receipt;
  }

  async loadCheckpoint(
    externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
    return this.#inner.loadCheckpoint(externalId);
  }

  async saveArtifact(
    record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }> {
    return this.#inner.saveArtifact(record);
  }
}

export class OpenAIAgentsRunnerAdapter extends BaseOpenAIAgentsRunnerAdapter {
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #authorityHolders = new Map<string, string>();
  readonly #latestCheckpoints = new Map<string, RunnerExternalReferenceV1>();

  constructor(options: OpenAIAgentsRunnerAdapterOptions) {
    super({
      ...options,
      externalStore: new ReplayChronologyStore(options.externalStore),
    });
    this.#descriptor = super.describe();
  }

  override async *start(
    value: RunnerStartCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerStartCommandV1(value);
    for await (const observation of super.start(command)) {
      if (observation.type === "start_accepted") {
        this.#admitAuthority(command);
      }
      this.#captureCheckpoint(command, observation);
      yield observation;
    }
  }

  override async *resume(
    value: RunnerResumeCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerResumeCommandV1(value);
    for await (const observation of super.resume(command)) {
      if (observation.type === "resume_accepted") {
        this.#admitAuthority(command);
      }
      this.#captureCheckpoint(command, observation);
      yield observation;
    }
  }

  override async requestCheckpoint(
    value: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    const identity = admitControlIdentity(value);
    this.#assertControlBinding(identity);
    const checkpoint = this.#latestCheckpoints.get(controlKey(identity));
    if (!checkpoint) {
      throw new RangeError(
        "OpenAI Agents latest checkpoint reference is unknown to this adapter instance",
      );
    }

    // Preserve the base command parser, clock, and expiry checks. The returned
    // base-cache value is deliberately ignored because that legacy cache is not
    // profile-bound; the wrapper returns the exact profile-bound observation.
    await super.requestCheckpoint(identity.input as RunnerCheckpointCommandV1);
    return checkpoint;
  }

  override async requestCancellation(
    value: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    const identity = admitControlIdentity(value);
    this.#assertControlBinding(identity);
    return super.requestCancellation(
      identity.input as RunnerCancellationCommandV1,
    );
  }

  #admitAuthority(command: RunnerStartCommandV1 | RunnerResumeCommandV1): void {
    setBoundedStringMap(
      this.#authorityHolders,
      controlKey(command),
      command.authority.holderId,
    );
  }

  #captureCheckpoint(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    observation: RunnerObservationV1,
  ): void {
    if (observation.type !== "checkpoint_published") return;
    setBoundedStringMap(
      this.#latestCheckpoints,
      controlKey(command),
      observation.reference,
    );
  }

  #assertControlBinding(identity: ControlIdentity): void {
    if (
      identity.adapterId !== this.#descriptor.adapterId
      || identity.adapterVersion !== this.#descriptor.adapterVersion
    ) {
      throw new RangeError(
        "OpenAI Agents control command adapter binding is invalid",
      );
    }
    if (!this.#descriptor.profiles.some((entry) => entry.id === identity.profileId)) {
      throw new RangeError(
        "OpenAI Agents control command profile is unsupported",
      );
    }
    if (
      identity.authorityResource !== `run:${identity.runId}`
      || identity.authorityGeneration !== identity.leaseGeneration
    ) {
      throw new RangeError(
        "OpenAI Agents control command authority binding is invalid",
      );
    }
    const admittedHolder = this.#authorityHolders.get(controlKey(identity));
    if (admittedHolder === undefined) {
      throw new RangeError(
        "OpenAI Agents control command authority holder is unknown to this adapter instance",
      );
    }
    if (identity.holderId !== admittedHolder) {
      throw new RangeError(
        "OpenAI Agents control command authority holder is stale",
      );
    }
  }
}

function admitControlIdentity(value: unknown): ControlIdentity {
  const input = snapshotJsonData(
    value,
    "OpenAI Agents control command",
  ) as Record<string, unknown>;
  const authority = input.authority as Record<string, unknown> | undefined;
  if (
    !authority
    || typeof input.adapterId !== "string"
    || typeof input.adapterVersion !== "string"
    || typeof input.profileId !== "string"
    || typeof input.runId !== "string"
    || !Number.isSafeInteger(input.runGeneration)
    || !Number.isSafeInteger(input.leaseGeneration)
    || typeof authority.holderId !== "string"
    || typeof authority.resource !== "string"
    || !Number.isSafeInteger(authority.generation)
  ) {
    throw new RangeError("OpenAI Agents control command is invalid");
  }
  return {
    input: input as unknown as ControlCommand,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    profileId: input.profileId,
    runId: input.runId,
    runGeneration: input.runGeneration as number,
    leaseGeneration: input.leaseGeneration as number,
    holderId: authority.holderId,
    authorityResource: authority.resource,
    authorityGeneration: authority.generation as number,
  };
}

function controlKey(input: {
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return JSON.stringify([
    input.adapterId,
    input.adapterVersion,
    input.profileId,
    input.runId,
    input.runGeneration,
    input.leaseGeneration,
  ]);
}

function setBoundedStringMap<T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximumControlEntries) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== "string") break;
    map.delete(oldest);
  }
}

function snapshotJsonData(
  value: unknown,
  label: string,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): unknown {
  budget.nodes += 1;
  if (depth > maximumSnapshotDepth || budget.nodes > maximumSnapshotNodes) {
    throw new RangeError(`${label} exceeds the bounded data limit`);
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new RangeError(`${label} contains a non-ordinary array`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor
      || !("value" in lengthDescriptor)
      || lengthDescriptor.enumerable
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > maximumSnapshotArrayLength
    ) {
      throw new RangeError(`${label} contains an invalid array length`);
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(descriptors);
    const expected = new Set<PropertyKey>([
      "length",
      ...Array.from({ length }, (_, index) => String(index)),
    ]);
    if (
      keys.length !== expected.size
      || keys.some((key) => !expected.has(key))
    ) {
      throw new RangeError(`${label} contains a sparse or decorated array`);
    }
    const output = Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !("value" in descriptor)
        || descriptor.enumerable !== true
        || descriptor.get !== undefined
        || descriptor.set !== undefined
      ) {
        throw new RangeError(`${label} contains a non-data array entry`);
      }
      return snapshotJsonData(descriptor.value, label, depth + 1, budget);
    });
    Object.freeze(output);
    return output;
  }
  if (!value || typeof value !== "object") {
    throw new RangeError(`${label} contains a non-data value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} contains a non-plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length > maximumSnapshotObjectFields
    || keys.some((key) => typeof key !== "string")
  ) {
    throw new RangeError(`${label} contains invalid object fields`);
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw new RangeError(`${label} must contain only enumerable data properties`);
    }
    output[key] = snapshotJsonData(
      descriptor.value,
      label,
      depth + 1,
      budget,
    );
  }
  Object.freeze(output);
  return output;
}
