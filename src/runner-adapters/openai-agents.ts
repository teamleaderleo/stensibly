import {
  OpenAIAgentsRunnerAdapter as BaseOpenAIAgentsRunnerAdapter,
  type OpenAIAgentsArtifactRecordV1,
  type OpenAIAgentsCheckpointAppendReceiptV1,
  type OpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsCheckpointRecordV1,
  type OpenAIAgentsCompletion,
  type OpenAIAgentsCompletionInput,
  type OpenAIAgentsExternalStore,
  type OpenAIAgentsResumePreparationInput,
  type OpenAIAgentsRunnerAdapterOptions,
  type OpenAIAgentsRuntime,
  type OpenAIAgentsRuntimeFactory,
  type OpenAIAgentsRuntimeFactoryInput,
} from "./openai-agents-base.js";
import {
  RUNNER_ADAPTER_V1,
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
import {
  admitOpenAIAgentsClockBaseV1,
  openAIAgentsObservationTimeV1,
} from "./openai-agents-runtime-safety.js";

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

const invocationEpoch = "1970-01-01T00:00:00.000Z";
const exactTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const unsafeTextPattern =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialShapedTextPattern =
  /(?:^|[\s:./=,;'"()\[\]{}@#-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;
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

class ProfileBoundRuntimeFactory implements OpenAIAgentsRuntimeFactory {
  readonly #inner: OpenAIAgentsRuntimeFactory;
  readonly #onResumePrepared: (command: RunnerResumeCommandV1) => void;

  constructor(
    inner: OpenAIAgentsRuntimeFactory,
    onResumePrepared: (command: RunnerResumeCommandV1) => void,
  ) {
    this.#inner = inner;
    this.#onResumePrepared = onResumePrepared;
  }

  create(
    input: OpenAIAgentsRuntimeFactoryInput,
  ): Promise<OpenAIAgentsRuntime> | OpenAIAgentsRuntime {
    return this.#inner.create(input);
  }

  prepareResumeState(
    input: OpenAIAgentsResumePreparationInput,
  ): Promise<void> | void {
    this.#onResumePrepared(input.command);
    return this.#inner.prepareResumeState(input);
  }

  summarizeCompletion(
    input: OpenAIAgentsCompletionInput,
  ): Promise<OpenAIAgentsCompletion> | OpenAIAgentsCompletion {
    return this.#inner.summarizeCompletion(input);
  }
}

export class OpenAIAgentsRunnerAdapter extends BaseOpenAIAgentsRunnerAdapter {
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #now: () => Date;
  readonly #authorityHolders = new Map<string, string>();
  readonly #latestCheckpoints = new Map<string, RunnerExternalReferenceV1>();

  constructor(options: OpenAIAgentsRunnerAdapterOptions) {
    let onResumePrepared = (_command: RunnerResumeCommandV1): void => {};
    const runtimeFactory = new ProfileBoundRuntimeFactory(
      options.runtimeFactory,
      (command) => onResumePrepared(command),
    );
    super({
      ...options,
      runtimeFactory,
      externalStore: new ReplayChronologyStore(options.externalStore),
    });
    this.#descriptor = super.describe();
    this.#now = options.now ?? (() => new Date());
    onResumePrepared = (command) => this.#admitResumedCheckpoint(command);
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
    const identity = admitControlIdentity(value, false);
    const clock = admitOpenAIAgentsClockBaseV1(this.#now, invocationEpoch);
    assertControlAuthorityActive(identity.input, clock.baseMilliseconds);
    this.#assertControlBinding(identity);
    const checkpoint = this.#latestCheckpoints.get(controlKey(identity));
    if (!checkpoint) {
      throw new RangeError(
        "OpenAI Agents latest checkpoint reference is unknown to this adapter instance",
      );
    }
    return checkpoint;
  }

  override async requestCancellation(
    value: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    const identity = admitControlIdentity(value, true);
    const command = identity.input as RunnerCancellationCommandV1;
    const clock = admitOpenAIAgentsClockBaseV1(this.#now, invocationEpoch);
    assertControlAuthorityActive(command, clock.baseMilliseconds);
    this.#assertControlBinding(identity);
    return Object.freeze({
      version: RUNNER_ADAPTER_V1,
      commandId: command.commandId,
      adapterId: this.#descriptor.adapterId,
      adapterVersion: this.#descriptor.adapterVersion,
      profileId: command.profileId,
      runId: command.runId,
      runGeneration: command.runGeneration,
      leaseGeneration: command.leaseGeneration,
      observedAt: openAIAgentsObservationTimeV1(clock, 1),
      requestAccepted: this.#descriptor.cancellationMode !== "unsupported",
      deliveryKnown: false,
      remoteSettlementKnown: false,
      reference: null,
    });
  }

  #admitAuthority(command: RunnerStartCommandV1 | RunnerResumeCommandV1): void {
    setBoundedStringMap(
      this.#authorityHolders,
      controlKey(command),
      command.authority.holderId,
    );
  }

  #admitResumedCheckpoint(command: RunnerResumeCommandV1): void {
    if (command.checkpointRef === null) return;
    setBoundedStringMap(
      this.#latestCheckpoints,
      controlKey(command),
      command.checkpointRef,
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

function admitControlIdentity(
  value: unknown,
  cancellation: false,
): ControlIdentity & { input: RunnerCheckpointCommandV1 };
function admitControlIdentity(
  value: unknown,
  cancellation: true,
): ControlIdentity & { input: RunnerCancellationCommandV1 };
function admitControlIdentity(
  value: unknown,
  cancellation: boolean,
): ControlIdentity {
  try {
    const input = snapshotJsonData(
      value,
      "OpenAI Agents control command",
    ) as Record<string, unknown>;
    requireExactKeys(
      input,
      cancellation
        ? [
          "version",
          "commandId",
          "adapterId",
          "adapterVersion",
          "profileId",
          "runId",
          "runGeneration",
          "leaseGeneration",
          "authority",
          "requestedAt",
          "reason",
        ]
        : [
          "version",
          "commandId",
          "adapterId",
          "adapterVersion",
          "profileId",
          "runId",
          "runGeneration",
          "leaseGeneration",
          "authority",
          "requestedAt",
        ],
    );
    if (input.version !== RUNNER_ADAPTER_V1) throw new RangeError();
    const runId = canonicalIdentifier(input.runId, "control run ID");
    const runGeneration = canonicalInteger(input.runGeneration, 0);
    const leaseGeneration = canonicalInteger(input.leaseGeneration, 1);
    const authorityInput = input.authority as Record<string, unknown>;
    requireExactKeys(authorityInput, [
      "resource",
      "holderId",
      "generation",
      "expiresAt",
    ]);
    const authority = Object.freeze({
      resource: exactBoundedText(
        authorityInput.resource,
        320,
        "control authority resource",
      ) as `run:${string}`,
      holderId: canonicalIdentifier(
        authorityInput.holderId,
        "control authority holder",
      ),
      generation: canonicalInteger(authorityInput.generation, 1),
      expiresAt: canonicalTimestamp(
        authorityInput.expiresAt,
        "control authority expiry",
      ),
    });
    if (
      authority.resource !== `run:${runId}`
      || authority.generation !== leaseGeneration
    ) {
      throw new RangeError();
    }
    const base = {
      version: RUNNER_ADAPTER_V1,
      commandId: canonicalIdentifier(input.commandId, "control command ID"),
      adapterId: canonicalIdentifier(input.adapterId, "control adapter ID"),
      adapterVersion: exactBoundedText(
        input.adapterVersion,
        160,
        "control adapter version",
      ),
      profileId: canonicalIdentifier(input.profileId, "control profile ID"),
      runId,
      runGeneration,
      leaseGeneration,
      authority,
      requestedAt: canonicalTimestamp(input.requestedAt, "control request time"),
    };
    const command = cancellation
      ? Object.freeze({
        ...base,
        reason: canonicalBoundedText(
          input.reason,
          2_000,
          "cancellation reason",
        ),
      }) as RunnerCancellationCommandV1
      : Object.freeze(base) as RunnerCheckpointCommandV1;
    return {
      input: command,
      adapterId: command.adapterId,
      adapterVersion: command.adapterVersion,
      profileId: command.profileId,
      runId: command.runId,
      runGeneration: command.runGeneration,
      leaseGeneration: command.leaseGeneration,
      holderId: command.authority.holderId,
      authorityResource: command.authority.resource,
      authorityGeneration: command.authority.generation,
    };
  } catch {
    throw new RangeError("OpenAI Agents control command is invalid");
  }
}

function assertControlAuthorityActive(
  input: ControlCommand,
  currentTime: number,
): void {
  const requestedAt = Date.parse(input.requestedAt);
  const expiresAt = Date.parse(input.authority.expiresAt);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt)) {
    throw new RangeError("OpenAI Agents control command time is invalid");
  }
  if (currentTime < requestedAt) {
    throw new RangeError(
      "OpenAI Agents control command cannot execute before its request time",
    );
  }
  if (currentTime >= expiresAt) {
    throw new RangeError(
      "OpenAI Agents control command authority expired before execution",
    );
  }
}

function requireExactKeys(
  input: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RangeError();
  }
  const keys = Object.keys(input);
  if (
    keys.length !== fields.length
    || fields.some((field) => !Object.prototype.hasOwnProperty.call(input, field))
  ) {
    throw new RangeError();
  }
}

function canonicalInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError();
  }
  return value as number;
}

function canonicalIdentifier(value: unknown, label: string): string {
  const output = exactBoundedText(value, 160, label);
  if (!identifierPattern.test(output)) {
    throw new RangeError(`${label} has an invalid format`);
  }
  return output;
}

function exactBoundedText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new RangeError(`${label} must be exact text`);
  }
  return validateBoundedText(value, maximum, label);
}

function canonicalBoundedText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new RangeError(`${label} must be text`);
  }
  return validateBoundedText(value.trim(), maximum, label);
}

function validateBoundedText(
  output: string,
  maximum: number,
  label: string,
): string {
  if (
    output.length === 0
    || output.length > maximum
    || unsafeTextPattern.test(output)
    || credentialShapedTextPattern.test(output)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return output;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !exactTimestampPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
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
