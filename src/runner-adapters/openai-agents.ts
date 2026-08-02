export * from "./openai-agents-core.js";

import type { EffectiveToolSurfaceSnapshot } from "../effective-tool-surface.js";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerResumeCommandV1,
  parseRunnerStartCommandV1,
  type RunnerAdapterDescriptorV1,
  type RunnerAdapterV1,
  type RunnerCancellationCommandV1,
  type RunnerCancellationObservationV1,
  type RunnerCapabilityProbeV1,
  type RunnerCheckpointCommandV1,
  type RunnerExternalReferenceV1,
  type RunnerObservationV1,
  type RunnerResumeCommandV1,
  type RunnerStartCommandV1,
} from "../runner-adapter-v1.js";
import {
  OpenAIAgentsRunnerAdapter as OpenAIAgentsRunnerAdapterCore,
  type OpenAIAgentsArtifactRecordV1,
  type OpenAIAgentsCheckpointAppendReceiptV1,
  type OpenAIAgentsCheckpointAppendV1,
  type OpenAIAgentsCheckpointRecordV1,
  type OpenAIAgentsExternalStore,
  type OpenAIAgentsRunnerAdapterOptions,
} from "./openai-agents-core.js";
import {
  admitOpenAIAgentsClockBaseV1,
  type OpenAIAgentsClockBaseV1,
} from "./openai-agents-runtime-safety.js";

const invocationEpoch = "1970-01-01T00:00:00.000Z";
const maxCachedEntries = 256;
const maximumSnapshotDepth = 24;
const maximumSnapshotNodes = 10_000;
const maximumSnapshotArrayLength = 1_024;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialShapedTextPattern = /(?:^|[\s:./=,;'"()\[\]{}@#-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

export class OpenAIAgentsRunnerAdapter implements RunnerAdapterV1 {
  readonly #core: OpenAIAgentsRunnerAdapterCore;
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #now: () => Date;
  readonly #authorityHolders = new Map<string, string>();

  constructor(options: OpenAIAgentsRunnerAdapterOptions) {
    this.#now = oneInvocationClock(options.now ?? (() => new Date()));
    this.#core = new OpenAIAgentsRunnerAdapterCore({
      ...options,
      externalStore: chronologyFencedStore(options.externalStore),
      now: this.#now,
    });
    this.#descriptor = this.#core.describe();
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.#descriptor;
  }

  inspectCapabilities(
    input: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot> {
    return this.#core.inspectCapabilities(input);
  }

  async *start(
    value: RunnerStartCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerStartCommandV1(snapshotInput(value));
    for await (const observation of this.#core.start(command)) {
      if (observation.type === "start_accepted") {
        this.#admitCommandAuthority(command);
      }
      yield observation;
    }
  }

  async *resume(
    value: RunnerResumeCommandV1,
  ): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerResumeCommandV1(snapshotInput(value));
    for await (const observation of this.#core.resume(command)) {
      if (observation.type === "resume_accepted") {
        this.#admitCommandAuthority(command);
      }
      yield observation;
    }
  }

  requestCheckpoint(
    value: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    const input = admitCheckpointControlV1(value);
    const clock = this.#admitInvocationClock();
    assertControlAuthorityActive(input, clock.baseMilliseconds);
    this.#assertControlBinding(input);
    return this.#core.requestCheckpoint(input);
  }

  requestCancellation(
    value: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    return this.#core.requestCancellation(value);
  }

  #admitCommandAuthority(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  ): void {
    setBoundedMap(
      this.#authorityHolders,
      controlKey(command),
      command.authority.holderId,
    );
  }

  #assertControlBinding(input: RunnerCheckpointCommandV1): void {
    if (
      input.adapterId !== this.#descriptor.adapterId
      || input.adapterVersion !== this.#descriptor.adapterVersion
    ) {
      throw new RangeError(
        "OpenAI Agents control command adapter binding is invalid",
      );
    }
    if (!this.#descriptor.profiles.some((entry) => entry.id === input.profileId)) {
      throw new RangeError(
        "OpenAI Agents control command profile is unsupported",
      );
    }
    if (
      input.authority.resource !== `run:${input.runId}`
      || input.authority.generation !== input.leaseGeneration
    ) {
      throw new RangeError(
        "OpenAI Agents control command authority binding is invalid",
      );
    }
    const admittedHolder = this.#authorityHolders.get(controlKey(input));
    if (admittedHolder === undefined) {
      throw new RangeError(
        "OpenAI Agents control command authority holder is unknown to this adapter instance",
      );
    }
    if (input.authority.holderId !== admittedHolder) {
      throw new RangeError(
        "OpenAI Agents control command authority holder is stale",
      );
    }
  }

  #admitInvocationClock(): OpenAIAgentsClockBaseV1 {
    return admitOpenAIAgentsClockBaseV1(this.#now, invocationEpoch);
  }
}

function oneInvocationClock(source: () => Date): () => Date {
  let cached: Date | undefined;
  let clearScheduled = false;
  return () => {
    if (cached === undefined) {
      const value = source();
      cached = new Date(value.getTime());
      if (!clearScheduled) {
        clearScheduled = true;
        queueMicrotask(() => {
          cached = undefined;
          clearScheduled = false;
        });
      }
    }
    return new Date(cached.getTime());
  };
}

function chronologyFencedStore(
  store: OpenAIAgentsExternalStore,
): OpenAIAgentsExternalStore {
  return {
    async appendCheckpoint(
      append: OpenAIAgentsCheckpointAppendV1,
    ): Promise<OpenAIAgentsCheckpointAppendReceiptV1> {
      try {
        const receipt = snapshotInput(
          await store.appendCheckpoint.call(store, append),
        );
        requireCheckpointReceiptChronology(receipt, append);
        return receipt as OpenAIAgentsCheckpointAppendReceiptV1;
      } catch {
        throw new RangeError(
          "OpenAI Agents checkpoint append receipt is invalid",
        );
      }
    },
    loadCheckpoint(
      externalId: string,
    ): Promise<OpenAIAgentsCheckpointRecordV1 | null> {
      return store.loadCheckpoint.call(store, externalId);
    },
    saveArtifact(
      record: OpenAIAgentsArtifactRecordV1,
    ): Promise<{ externalId: string }> {
      return store.saveArtifact.call(store, record);
    },
  };
}

function requireCheckpointReceiptChronology(
  value: unknown,
  append: OpenAIAgentsCheckpointAppendV1,
): void {
  const input = strictOwnDataRecord(
    value,
    "OpenAI Agents checkpoint append receipt",
    ["externalId", "record", "replayed"],
  );
  if (typeof input.replayed !== "boolean") throw new RangeError();
  const record = input.record;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new RangeError();
  }
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError();
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, "createdAt");
  if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new RangeError();
  }
  const createdAt = canonicalTimestamp(
    descriptor.value,
    "OpenAI Agents checkpoint creation time",
  );
  if (
    input.replayed
      ? createdAt > append.proposedCreatedAt
      : createdAt !== append.proposedCreatedAt
  ) {
    throw new RangeError();
  }
}

function admitCheckpointControlV1(
  value: unknown,
): RunnerCheckpointCommandV1 {
  try {
    const input = strictOwnDataRecord(
      snapshotInput(value),
      "OpenAI Agents control command",
      [
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
    const runId = canonicalIdentifier(
      input.runId,
      "OpenAI Agents control run ID",
    );
    const leaseGeneration = integer(input.leaseGeneration, 1);
    const authorityInput = strictOwnDataRecord(
      input.authority,
      "OpenAI Agents control authority",
      ["resource", "holderId", "generation", "expiresAt"],
    );
    const resource = canonicalBoundedText(
      authorityInput.resource,
      320,
      "OpenAI Agents control authority resource",
    );
    const generation = integer(authorityInput.generation, 1);
    if (resource !== `run:${runId}` || generation !== leaseGeneration) {
      throw new RangeError();
    }
    return Object.freeze({
      version: RUNNER_ADAPTER_V1,
      commandId: canonicalIdentifier(
        input.commandId,
        "OpenAI Agents control command ID",
      ),
      adapterId: canonicalIdentifier(
        input.adapterId,
        "OpenAI Agents control adapter ID",
      ),
      adapterVersion: canonicalBoundedText(
        input.adapterVersion,
        160,
        "OpenAI Agents control adapter version",
      ),
      profileId: canonicalIdentifier(
        input.profileId,
        "OpenAI Agents control profile ID",
      ),
      runId,
      runGeneration: integer(input.runGeneration, 0),
      leaseGeneration,
      authority: Object.freeze({
        resource: resource as `run:${string}`,
        holderId: canonicalIdentifier(
          authorityInput.holderId,
          "OpenAI Agents control authority holder",
        ),
        generation,
        expiresAt: canonicalTimestamp(
          authorityInput.expiresAt,
          "OpenAI Agents control authority expiry",
        ),
      }),
      requestedAt: canonicalTimestamp(
        input.requestedAt,
        "OpenAI Agents control request time",
      ),
    });
  } catch {
    throw new RangeError("OpenAI Agents control command is invalid");
  }
}

function snapshotInput(input: unknown): unknown {
  const active = new WeakSet<object>();
  const completed = new WeakMap<object, unknown>();
  let nodes = 0;

  const copyDescriptor = (
    descriptor: PropertyDescriptor,
    depth: number,
  ): PropertyDescriptor => {
    if (!("value" in descriptor)) {
      throw new RangeError(
        "OpenAI Agents admission input must contain data properties",
      );
    }
    return {
      ...descriptor,
      value: copy(descriptor.value, depth + 1),
    };
  };

  const copy = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (depth > maximumSnapshotDepth || nodes > maximumSnapshotNodes) {
      throw new RangeError("OpenAI Agents admission input exceeds snapshot limits");
    }
    if (value === null || typeof value !== "object") return value;
    if (active.has(value)) {
      throw new RangeError("OpenAI Agents admission input must not contain cycles");
    }
    const existing = completed.get(value);
    if (existing !== undefined) return existing;

    active.add(value);
    let output: unknown;
    try {
      const prototype = Object.getPrototypeOf(value);
      const isArray = Array.isArray(value);
      const descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
      const repeatedPrototype = Object.getPrototypeOf(value);
      const repeatedIsArray = Array.isArray(value);
      const repeatedDescriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
      if (
        !Object.is(prototype, repeatedPrototype)
        || isArray !== repeatedIsArray
        || !sameDescriptorMap(descriptors, repeatedDescriptors)
      ) {
        throw new RangeError("OpenAI Agents admission input changed during snapshot");
      }
      const keys = Reflect.ownKeys(descriptors);

      if (isArray) {
        const lengthDescriptor = descriptors.length;
        if (
          !lengthDescriptor
          || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || (lengthDescriptor.value as number) < 0
          || (lengthDescriptor.value as number) > maximumSnapshotArrayLength
        ) {
          throw new RangeError("OpenAI Agents admission input has invalid array length");
        }
        const arrayOutput: unknown[] = [];
        Object.setPrototypeOf(arrayOutput, prototype);
        output = arrayOutput;
        completed.set(value, output);
        for (const key of keys) {
          if (key === "length") continue;
          Object.defineProperty(
            arrayOutput,
            key,
            copyDescriptor(descriptors[key]!, depth),
          );
        }
        Object.defineProperty(arrayOutput, "length", lengthDescriptor);
        Object.freeze(arrayOutput);
        return arrayOutput;
      }

      const recordOutput = Object.create(prototype) as Record<PropertyKey, unknown>;
      output = recordOutput;
      completed.set(value, output);
      for (const key of keys) {
        Object.defineProperty(
          recordOutput,
          key,
          copyDescriptor(descriptors[key]!, depth),
        );
      }
      Object.freeze(recordOutput);
      return recordOutput;
    } catch (error) {
      completed.delete(value);
      throw error;
    } finally {
      active.delete(value);
    }
  };

  return copy(input, 0);
}

function sameDescriptorMap(left: DescriptorMap, right: DescriptorMap): boolean {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    const leftDescriptor = left[key]!;
    const rightDescriptor = right[key]!;
    if (
      leftDescriptor.configurable !== rightDescriptor.configurable
      || leftDescriptor.enumerable !== rightDescriptor.enumerable
    ) {
      return false;
    }
    const leftIsData = "value" in leftDescriptor;
    const rightIsData = "value" in rightDescriptor;
    if (leftIsData !== rightIsData) return false;
    if (leftIsData && rightIsData) {
      if (
        leftDescriptor.writable !== rightDescriptor.writable
        || !Object.is(leftDescriptor.value, rightDescriptor.value)
      ) {
        return false;
      }
    } else if (
      leftDescriptor.get !== rightDescriptor.get
      || leftDescriptor.set !== rightDescriptor.set
    ) {
      return false;
    }
  }
  return true;
}

function strictOwnDataRecord(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RangeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new RangeError(`${label} contains symbol decoration`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort(compareText);
  const canonicalExpected = [...expectedKeys].sort(compareText);
  if (JSON.stringify(actualKeys) !== JSON.stringify(canonicalExpected)) {
    throw new RangeError(`${label} fields are invalid`);
  }
  const output: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !("value" in descriptor)
    ) {
      throw new RangeError(`${label} field ${key} must be enumerable data`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function assertControlAuthorityActive(
  input: RunnerCheckpointCommandV1,
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

function canonicalIdentifier(value: unknown, label: string): string {
  const text = canonicalBoundedText(value, 160, label);
  if (!identifierPattern.test(text)) {
    throw new RangeError(`${label} has an invalid format`);
  }
  return text;
}

function canonicalBoundedText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new RangeError(`${label} must be text`);
  }
  const output = value.trim();
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
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} is invalid`);
  }
  if (new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError();
  }
  return value as number;
}

function controlKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return `${input.runId}:${input.runGeneration}:${input.leaseGeneration}`;
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxCachedEntries) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
