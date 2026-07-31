import {
  Agent,
  RunState,
  Runner,
  type RunToolApprovalItem,
} from "@openai/agents-core";
import type { RunAuthorityFence } from "../authority-fence.js";
import { sha256, stableJson } from "../canonical-json.js";
import type {
  EffectiveToolSurfaceClass,
  EffectiveToolSurfaceSnapshot,
  ToolSurfaceCapabilityRequirementInput,
  ToolSurfaceClassInput,
} from "../effective-tool-surface.js";
import {
  parseExecutionActual,
  type ExecutionActual,
} from "../execution-envelope.js";
import {
  bindRunnerCapabilityInspectionToCommandV1,
  buildRunnerCapabilityInspectionV1,
  requireRunnerCapabilityInspectionForCommandV1,
  type RunnerCapabilityCommandBindingV1,
  type RunnerCapabilityInspectionV1,
} from "../runner-capability-binding.js";
import { assertRunnerCommandAuthorityActiveV1 } from "../runner-command-authority.js";
import {
  RUNNER_ADAPTER_V1,
  parseRunnerAdapterDescriptorV1,
  parseRunnerCapabilityProbeV1,
  parseRunnerExternalReferenceV1,
  parseRunnerObservationV1,
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
  admitOpenAIAgentsClockBaseV1,
  buildOpenAIAgentsRuntimeManifestV1,
  openAIAgentsObservationTimeV1,
  requireOpenAIAgentsRuntimeManifestV1,
  type OpenAIAgentsClockBaseV1,
  type OpenAIAgentsRuntimeManifestV1,
} from "./openai-agents-runtime-safety.js";

export const OPENAI_AGENTS_PACKAGE_VERSION = "0.14.1" as const;
export const OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION = "1.14" as const;

const invocationEpoch = "1970-01-01T00:00:00.000Z";
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const outcomePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/u;
const credentialShapedTextPattern = /(?:^|[\s:./=,;'"()\[\]{}@#-])(?:Bearer\s+|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]|stn\.tok_|xox[baprs]-|env:\/\/|secret:\/\/|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.)/iu;
const maxStartInputCharacters = 100_000;
const maxSerializedStateCharacters = 1_000_000;
const maxArtifactContentCharacters = 4_000;
const maxCachedEntries = 256;
const maxInspectionAgeMilliseconds = 60 * 60 * 1_000;

export interface OpenAIAgentsRuntime {
  agent: Agent<any, any>;
  runner: Runner;
  startInput: string;
}

export interface OpenAIAgentsRuntimeFactory {
  create(
    input: OpenAIAgentsRuntimeFactoryInput,
  ): Promise<OpenAIAgentsRuntime> | OpenAIAgentsRuntime;
  prepareResumeState(
    input: OpenAIAgentsResumePreparationInput,
  ): Promise<void> | void;
  summarizeCompletion(
    input: OpenAIAgentsCompletionInput,
  ): Promise<OpenAIAgentsCompletion> | OpenAIAgentsCompletion;
}

export interface OpenAIAgentsRuntimeFactoryInput {
  phase: "start" | "resume";
  command: RunnerStartCommandV1 | RunnerResumeCommandV1;
}

export interface OpenAIAgentsResumePreparationInput {
  command: RunnerResumeCommandV1;
  state: RunState<any, Agent<any, any>>;
  interruptions: readonly RunToolApprovalItem[];
}

export interface OpenAIAgentsCompletionInput {
  command: RunnerStartCommandV1 | RunnerResumeCommandV1;
  finalOutput: unknown;
  generatedItemTypes: readonly string[];
}

export interface OpenAIAgentsCompletion {
  outcome: string;
  executionActual: ExecutionActual;
}

export interface OpenAIAgentsCapabilityInspector {
  inspect(
    probe: RunnerCapabilityProbeV1,
  ):
    | Promise<Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>>
    | Partial<Record<EffectiveToolSurfaceClass, ToolSurfaceClassInput>>;
}

export interface OpenAIAgentsCheckpointRecordV1 {
  version: 1;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  sdkPackageVersion: typeof OPENAI_AGENTS_PACKAGE_VERSION;
  sdkSchemaVersion: typeof OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  checkpointGeneration: number;
  serializedState: string;
  stateDigest: string;
  runtimeManifest: OpenAIAgentsRuntimeManifestV1;
  runtimeManifestFingerprint: string;
  checkpointDigest: string;
  createdAt: string;
}

export interface OpenAIAgentsCheckpointAppendV1 {
  version: 1;
  publicationKey: string;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  sdkPackageVersion: typeof OPENAI_AGENTS_PACKAGE_VERSION;
  sdkSchemaVersion: typeof OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  serializedState: string;
  stateDigest: string;
  runtimeManifest: OpenAIAgentsRuntimeManifestV1;
  runtimeManifestFingerprint: string;
  proposedCreatedAt: string;
}

export interface OpenAIAgentsCheckpointAppendReceiptV1 {
  externalId: string;
  record: OpenAIAgentsCheckpointRecordV1;
  replayed: boolean;
}

export interface OpenAIAgentsArtifactRecordV1 {
  version: 1;
  adapterId: string;
  adapterVersion: string;
  profileId: string;
  profileVersion: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  mediaType: "application/json";
  content: string;
  contentDigest: string;
  createdAt: string;
}

export interface OpenAIAgentsExternalStore {
  appendCheckpoint(
    input: OpenAIAgentsCheckpointAppendV1,
  ): Promise<OpenAIAgentsCheckpointAppendReceiptV1>;
  loadCheckpoint(
    externalId: string,
  ): Promise<OpenAIAgentsCheckpointRecordV1 | null>;
  saveArtifact(
    record: OpenAIAgentsArtifactRecordV1,
  ): Promise<{ externalId: string }>;
}

export interface OpenAIAgentsRunnerAdapterOptions {
  descriptor: RunnerAdapterDescriptorV1;
  capabilityInspector: OpenAIAgentsCapabilityInspector;
  runtimeFactory: OpenAIAgentsRuntimeFactory;
  externalStore: OpenAIAgentsExternalStore;
  now?: () => Date;
}

interface OpenAIAgentsRunResultLike {
  state: RunState<any, Agent<any, any>>;
  interruptions?: readonly RunToolApprovalItem[];
  finalOutput?: unknown;
  newItems: readonly { rawItem?: { type?: unknown } }[];
}

export function finalizeOpenAIAgentsCheckpointAppendV1(
  input: OpenAIAgentsCheckpointAppendV1,
  checkpointGeneration: number,
  createdAt = input.proposedCreatedAt,
): OpenAIAgentsCheckpointRecordV1 {
  if (!Number.isSafeInteger(checkpointGeneration) || checkpointGeneration < 1) {
    throw new RangeError("OpenAI Agents checkpoint generation is invalid");
  }
  const admittedCreatedAt = canonicalTimestamp(
    createdAt,
    "OpenAI Agents checkpoint creation time",
  );
  const recordWithoutDigest = {
    version: 1 as const,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    sdkPackageVersion: input.sdkPackageVersion,
    sdkSchemaVersion: input.sdkSchemaVersion,
    runId: input.runId,
    runGeneration: input.runGeneration,
    leaseGeneration: input.leaseGeneration,
    checkpointGeneration,
    serializedState: input.serializedState,
    stateDigest: input.stateDigest,
    runtimeManifest: input.runtimeManifest,
    runtimeManifestFingerprint: input.runtimeManifestFingerprint,
    createdAt: admittedCreatedAt,
  };
  return {
    ...recordWithoutDigest,
    checkpointDigest: checkpointEnvelopeDigest(recordWithoutDigest),
  };
}

export function openAIAgentsCheckpointAppendReplayFingerprintV1(
  input: OpenAIAgentsCheckpointAppendV1,
): string {
  return sha256(stableJson({
    version: input.version,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    sdkPackageVersion: input.sdkPackageVersion,
    sdkSchemaVersion: input.sdkSchemaVersion,
    runId: input.runId,
    runGeneration: input.runGeneration,
    leaseGeneration: input.leaseGeneration,
    serializedState: input.serializedState,
    stateDigest: input.stateDigest,
    runtimeManifest: input.runtimeManifest,
    runtimeManifestFingerprint: input.runtimeManifestFingerprint,
  }));
}

export class OpenAIAgentsRunnerAdapter implements RunnerAdapterV1 {
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #capabilityInspector: OpenAIAgentsCapabilityInspector;
  readonly #runtimeFactory: OpenAIAgentsRuntimeFactory;
  readonly #externalStore: OpenAIAgentsExternalStore;
  readonly #now: () => Date;
  readonly #inspections = new Map<string, RunnerCapabilityInspectionV1>();
  readonly #latestCheckpoints = new Map<string, RunnerExternalReferenceV1>();
  readonly #authorityHolders = new Map<string, string>();

  constructor(options: OpenAIAgentsRunnerAdapterOptions) {
    this.#descriptor = parseRunnerAdapterDescriptorV1(options.descriptor);
    if (this.#descriptor.checkpointMode !== "external_reference") {
      throw new RangeError(
        "OpenAI Agents adapter requires external-reference checkpoints",
      );
    }
    if (!this.#descriptor.supports.resume) {
      throw new RangeError("OpenAI Agents adapter requires resume support");
    }
    if (!this.#descriptor.supports.capabilityInspection) {
      throw new RangeError(
        "OpenAI Agents adapter requires capability inspection",
      );
    }
    this.#capabilityInspector = options.capabilityInspector;
    this.#runtimeFactory = options.runtimeFactory;
    this.#externalStore = options.externalStore;
    this.#now = options.now ?? (() => new Date());
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.#descriptor;
  }

  async inspectCapabilities(
    value: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot> {
    const probe = parseRunnerCapabilityProbeV1(value);
    const classes = await this.#capabilityInspector.inspect(probe);
    const inspection = buildRunnerCapabilityInspectionV1(
      this.#descriptor,
      probe,
      classes,
    );
    setBoundedMap(
      this.#inspections,
      inspectionKey(probe, probe.transition),
      inspection,
    );
    return inspection.snapshot;
  }

  async *start(value: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerStartCommandV1(value);
    this.#assertCommandBinding(command);
    const clock = this.#admitInvocationClock();
    assertRunnerCommandAuthorityActiveV1(
      command,
      new Date(clock.baseMilliseconds),
    );
    const snapshot = this.#requiredSnapshot(
      command,
      "new",
      clock.baseMilliseconds,
    );
    requireExecutableCapabilities(snapshot);
    this.#admitCommandAuthority(command);

    yield this.#observation(command, clock, "start_accepted", 2);
    yield this.#observation(command, clock, "execution_started", 3);
    yield this.#observation(
      command,
      clock,
      "tool_surface_observed",
      4,
      { snapshot },
    );

    let failureOrdinal = 5;
    try {
      const runtime = await this.#runtimeFactory.create({
        phase: "start",
        command,
      });
      const manifest = attestOpenAIAgentsFirstSliceRuntime(runtime);
      yield this.#observation(command, clock, "work_step", 5, {
        phase: "sdk_run",
        summary: "Started the bounded OpenAI Agents regular-agent run.",
      });
      failureOrdinal = 6;

      const result: OpenAIAgentsRunResultLike = await runtime.runner.run(
        runtime.agent,
        runtime.startInput,
        { stream: false },
      );
      const interruptions =
        result.interruptions ?? result.state.getInterruptions();
      if (interruptions.length > 0) {
        const checkpoint = await this.#publishCheckpoint(
          command,
          result.state,
          manifest,
          clock,
          6,
        );
        yield this.#observation(
          command,
          clock,
          "checkpoint_published",
          6,
          { reference: checkpoint },
          [checkpoint],
        );
        yield this.#observation(
          command,
          clock,
          "interrupted",
          7,
          {
            code: "openai_agents_approval_required",
            message:
              "The OpenAI Agents run paused with a resumable approval request.",
            checkpointRef: checkpoint,
            recoveryAction: "resume",
            remoteSettlementKnown: false,
          },
          [checkpoint],
        );
        return;
      }

      const observations = await this.#buildCompletionObservations(
        command,
        result,
        clock,
        6,
        null,
      );
      for (const observation of observations) yield observation;
    } catch {
      yield this.#failure(command, clock, failureOrdinal, "retry");
    }
  }

  async *resume(value: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerResumeCommandV1(value);
    this.#assertCommandBinding(command);
    const clock = this.#admitInvocationClock();
    assertRunnerCommandAuthorityActiveV1(
      command,
      new Date(clock.baseMilliseconds),
    );
    const snapshot = this.#requiredSnapshot(
      command,
      "resume",
      clock.baseMilliseconds,
    );
    requireExecutableCapabilities(snapshot);
    this.#admitCommandAuthority(command);

    yield this.#observation(command, clock, "resume_accepted", 2);
    yield this.#observation(command, clock, "execution_started", 3);
    yield this.#observation(
      command,
      clock,
      "tool_surface_observed",
      4,
      { snapshot },
    );

    try {
      const checkpointRef = requiredCheckpointReference(
        command,
        this.#descriptor,
      );
      const record = await this.#loadCheckpointEnvelope(command, checkpointRef);
      this.#requireCheckpointIntegrity(record, checkpointRef);
      const runtime = await this.#runtimeFactory.create({
        phase: "resume",
        command,
      });
      const currentManifest = attestOpenAIAgentsFirstSliceRuntime(runtime);
      const admittedManifest = requireOpenAIAgentsRuntimeManifestV1(
        record.runtimeManifest,
        currentManifest,
      );
      if (
        record.runtimeManifestFingerprint !== admittedManifest.fingerprint
      ) {
        throw new RangeError("OpenAI Agents runtime graph identity is stale");
      }

      const state = await RunState.fromString(
        runtime.agent,
        record.serializedState,
      );
      const interruptions = state.getInterruptions();
      if (interruptions.length === 0) {
        throw new RangeError(
          "OpenAI Agents checkpoint contains no resumable interruption",
        );
      }
      this.#admitLoadedCheckpoint(command, checkpointRef);
      await this.#runtimeFactory.prepareResumeState({
        command,
        state,
        interruptions,
      });

      const result: OpenAIAgentsRunResultLike = await runtime.runner.run(
        runtime.agent,
        state,
        { stream: false },
      );
      const remaining =
        result.interruptions ?? result.state.getInterruptions();
      if (remaining.length > 0) {
        const checkpoint = await this.#publishCheckpoint(
          command,
          result.state,
          currentManifest,
          clock,
          5,
        );
        yield this.#observation(
          command,
          clock,
          "checkpoint_published",
          5,
          { reference: checkpoint },
          [checkpoint],
        );
        yield this.#observation(
          command,
          clock,
          "interrupted",
          6,
          {
            code: "openai_agents_approval_required",
            message:
              "The resumed OpenAI Agents run requested another approval.",
            checkpointRef: checkpoint,
            recoveryAction: "resume",
            remoteSettlementKnown: false,
          },
          [checkpoint],
        );
        return;
      }

      const observations = await this.#buildCompletionObservations(
        command,
        result,
        clock,
        5,
        checkpointRef,
      );
      for (const observation of observations) yield observation;
    } catch {
      yield this.#failure(command, clock, 5, "reconcile");
    }
  }

  async requestCheckpoint(
    value: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    const input = admitControlCommandV1(value, false);
    const clock = this.#admitInvocationClock();
    assertControlAuthorityActive(input, clock.baseMilliseconds);
    const checkpoint = this.#latestCheckpoints.get(controlKey(input));
    if (!checkpoint) {
      throw new RangeError(
        "OpenAI Agents latest checkpoint reference is unknown to this adapter instance",
      );
    }
    this.#assertControlBinding(input);
    return checkpoint;
  }

  async requestCancellation(
    value: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    const input = admitControlCommandV1(value, true);
    const clock = this.#admitInvocationClock();
    assertControlAuthorityActive(input, clock.baseMilliseconds);
    this.#assertControlBinding(input);
    return admitCancellationObservationV1({
      version: RUNNER_ADAPTER_V1,
      commandId: input.commandId,
      adapterId: this.#descriptor.adapterId,
      adapterVersion: this.#descriptor.adapterVersion,
      profileId: input.profileId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      observedAt: openAIAgentsObservationTimeV1(clock, 1),
      requestAccepted: this.#descriptor.cancellationMode !== "unsupported",
      deliveryKnown: false,
      remoteSettlementKnown: false,
      reference: null,
    });
  }

  async #buildCompletionObservations(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    result: OpenAIAgentsRunResultLike,
    clock: OpenAIAgentsClockBaseV1,
    firstOrdinal: number,
    checkpointRef: RunnerExternalReferenceV1 | null,
  ): Promise<readonly RunnerObservationV1[]> {
    const generatedItemTypes = result.newItems.map((item) =>
      typeof item.rawItem?.type === "string"
        ? item.rawItem.type
        : "unknown"
    );
    const completion = admitOpenAIAgentsCompletionV1(
      await this.#runtimeFactory.summarizeCompletion({
        command,
        finalOutput: result.finalOutput,
        generatedItemTypes,
      }),
    );
    const artifact = await this.#publishArtifact(
      command,
      completion,
      clock,
      firstOrdinal + 1,
    );
    const usage = result.state.usage;

    return [
      this.#observation(
        command,
        clock,
        "heartbeat",
        firstOrdinal,
        {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            toolCalls: generatedItemTypes.filter(
              (type) => type === "function_call",
            ).length,
            childAgents: generatedItemTypes.filter(
              (type) => type === "handoff_output_item",
            ).length,
          },
          checkpointRef,
        },
        checkpointRef ? [checkpointRef] : [],
      ),
      this.#observation(
        command,
        clock,
        "artifact_published",
        firstOrdinal + 1,
        { reference: artifact },
        [artifact],
      ),
      this.#observation(
        command,
        clock,
        "completion_proposed",
        firstOrdinal + 2,
        {
          outcome: completion.outcome,
          executionActual: completion.executionActual,
        },
        [artifact],
      ),
    ];
  }

  async #publishCheckpoint(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    state: RunState<any, Agent<any, any>>,
    runtimeManifest: OpenAIAgentsRuntimeManifestV1,
    clock: OpenAIAgentsClockBaseV1,
    ordinal: number,
  ): Promise<RunnerExternalReferenceV1> {
    const serializedState = state.toString();
    if (serializedState.length > maxSerializedStateCharacters) {
      throw new RangeError("OpenAI Agents serialized state is too large");
    }
    const schemaVersion = serializedSchemaVersion(serializedState);
    if (schemaVersion !== OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION) {
      throw new RangeError(
        `OpenAI Agents serialized state uses unsupported schema ${schemaVersion}`,
      );
    }
    const proposedCreatedAt = openAIAgentsObservationTimeV1(clock, ordinal);
    const stateDigest = sha256(serializedState);
    const append: OpenAIAgentsCheckpointAppendV1 = {
      version: 1,
      publicationKey: checkpointPublicationKey(
        this.#descriptor,
        command,
        ordinal,
      ),
      adapterId: this.#descriptor.adapterId,
      adapterVersion: this.#descriptor.adapterVersion,
      profileId: command.profileId,
      profileVersion: command.profileVersion,
      sdkPackageVersion: OPENAI_AGENTS_PACKAGE_VERSION,
      sdkSchemaVersion: OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION,
      runId: command.runId,
      runGeneration: command.runGeneration,
      leaseGeneration: command.leaseGeneration,
      serializedState,
      stateDigest,
      runtimeManifest,
      runtimeManifestFingerprint: runtimeManifest.fingerprint,
      proposedCreatedAt,
    };
    const receipt = await this.#externalStore.appendCheckpoint(append);
    const admitted = admitCheckpointAppendReceiptV1(receipt, append);
    const reference = parseRunnerExternalReferenceV1({
      version: RUNNER_ADAPTER_V1,
      kind: "checkpoint",
      adapterId: this.#descriptor.adapterId,
      externalId: admitted.externalId,
      digest: admitted.record.checkpointDigest,
      uri: null,
      generation: admitted.record.checkpointGeneration,
      createdAt: admitted.record.createdAt,
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    });
    setBoundedMap(this.#latestCheckpoints, controlKey(command), reference);
    return reference;
  }

  async #publishArtifact(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    completion: OpenAIAgentsCompletion,
    clock: OpenAIAgentsClockBaseV1,
    ordinal: number,
  ): Promise<RunnerExternalReferenceV1> {
    const createdAt = openAIAgentsObservationTimeV1(clock, ordinal);
    const content = stableJson({
      version: 1,
      outcome: completion.outcome,
      executionActual: completion.executionActual,
    });
    if (
      content.length === 0
      || content.length > maxArtifactContentCharacters
      || unsafeTextPattern.test(content)
      || credentialShapedTextPattern.test(content)
    ) {
      throw new RangeError("OpenAI Agents canonical artifact is invalid");
    }
    const contentDigest = sha256(content);
    const saved = admitArtifactSaveReceiptV1(
      await this.#externalStore.saveArtifact({
        version: 1,
        adapterId: this.#descriptor.adapterId,
        adapterVersion: this.#descriptor.adapterVersion,
        profileId: command.profileId,
        profileVersion: command.profileVersion,
        runId: command.runId,
        runGeneration: command.runGeneration,
        leaseGeneration: command.leaseGeneration,
        mediaType: "application/json",
        content,
        contentDigest,
        createdAt,
      }),
    );
    return parseRunnerExternalReferenceV1({
      version: RUNNER_ADAPTER_V1,
      kind: "artifact",
      adapterId: this.#descriptor.adapterId,
      externalId: saved.externalId,
      digest: contentDigest,
      uri: null,
      generation: command.runGeneration,
      createdAt,
      accessClass: "project",
      containsPrivateContent: false,
      containsCredentials: false,
    });
  }

  async #loadCheckpointEnvelope(
    command: RunnerResumeCommandV1,
    reference: RunnerExternalReferenceV1,
  ): Promise<OpenAIAgentsCheckpointRecordV1> {
    let loaded: unknown;
    try {
      loaded = await this.#externalStore.loadCheckpoint(reference.externalId!);
    } catch {
      throw new RangeError("OpenAI Agents checkpoint lookup failed");
    }
    if (loaded === null) {
      throw new RangeError(
        "OpenAI Agents checkpoint is missing from the external store",
      );
    }
    const record = admitOpenAIAgentsCheckpointRecordV1(loaded);
    if (
      record.adapterId !== this.#descriptor.adapterId
      || record.adapterVersion !== this.#descriptor.adapterVersion
      || record.profileId !== command.profileId
      || record.profileVersion !== command.profileVersion
    ) {
      throw new RangeError(
        "OpenAI Agents checkpoint adapter or profile binding is stale",
      );
    }
    if (
      record.runId !== command.runId
      || record.runGeneration !== command.runGeneration
      || record.leaseGeneration !== command.leaseGeneration
    ) {
      throw new RangeError(
        "OpenAI Agents checkpoint run or lease binding is stale",
      );
    }
    if (
      record.sdkPackageVersion !== OPENAI_AGENTS_PACKAGE_VERSION
      || record.sdkSchemaVersion !== OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION
    ) {
      throw new RangeError(
        "OpenAI Agents checkpoint SDK version is unsupported",
      );
    }
    if (
      reference.generation !== record.checkpointGeneration
      || reference.createdAt !== record.createdAt
    ) {
      throw new RangeError(
        "OpenAI Agents checkpoint identity or digest is invalid",
      );
    }
    return record;
  }

  #requireCheckpointIntegrity(
    record: OpenAIAgentsCheckpointRecordV1,
    reference: RunnerExternalReferenceV1,
  ): void {
    if (
      !digestPattern.test(record.stateDigest)
      || !digestPattern.test(record.runtimeManifestFingerprint)
      || !digestPattern.test(record.checkpointDigest)
      || reference.digest !== record.checkpointDigest
      || sha256(record.serializedState) !== record.stateDigest
      || checkpointEnvelopeDigest(record) !== record.checkpointDigest
    ) {
      throw new RangeError(
        "OpenAI Agents checkpoint identity or digest is invalid",
      );
    }
    if (
      serializedSchemaVersion(record.serializedState)
        !== record.sdkSchemaVersion
    ) {
      throw new RangeError(
        "OpenAI Agents checkpoint schema metadata is inconsistent",
      );
    }
  }

  #admitLoadedCheckpoint(
    command: RunnerResumeCommandV1,
    reference: RunnerExternalReferenceV1,
  ): void {
    setBoundedMap(this.#latestCheckpoints, controlKey(command), reference);
  }

  #requiredSnapshot(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    transition: "new" | "resume",
    currentTime: number,
  ): EffectiveToolSurfaceSnapshot {
    const key = inspectionKey(command, transition);
    const inspection = this.#inspections.get(key);
    if (!inspection) {
      throw new RangeError(
        `OpenAI Agents ${transition} requires a capability inspection bound to the exact command requirements`,
      );
    }
    const observedAt = Date.parse(inspection.observedAt);
    if (
      !Number.isFinite(observedAt)
      || observedAt > currentTime
      || currentTime - observedAt > maxInspectionAgeMilliseconds
    ) {
      this.#inspections.delete(key);
      throw new RangeError(
        "OpenAI Agents capability inspection is stale for execution",
      );
    }
    const binding = bindRunnerCapabilityInspectionToCommandV1(
      inspection,
      command,
    );
    const snapshot = requireInspectionSnapshot(binding, command);
    this.#inspections.delete(key);
    return snapshot;
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

  #assertCommandBinding(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  ): void {
    if (
      command.adapterId !== this.#descriptor.adapterId
      || command.adapterVersion !== this.#descriptor.adapterVersion
    ) {
      throw new RangeError("OpenAI Agents command adapter binding is invalid");
    }
    const profile = this.#descriptor.profiles.find(
      (entry) =>
        entry.id === command.profileId
        && entry.version === command.profileVersion,
    );
    if (!profile) {
      throw new RangeError("OpenAI Agents command profile is unsupported");
    }
  }

  #assertControlBinding(
    input: RunnerCheckpointCommandV1 | RunnerCancellationCommandV1,
  ): void {
    if (
      input.adapterId !== this.#descriptor.adapterId
      || input.adapterVersion !== this.#descriptor.adapterVersion
    ) {
      throw new RangeError(
        "OpenAI Agents control command adapter binding is invalid",
      );
    }
    const profile = this.#descriptor.profiles.find(
      (entry) => entry.id === input.profileId,
    );
    if (!profile) {
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

  #observation(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    clock: OpenAIAgentsClockBaseV1,
    type: RunnerObservationV1["type"],
    ordinal: number,
    fields: Record<string, unknown> = {},
    references: readonly RunnerExternalReferenceV1[] = [],
  ): RunnerObservationV1 {
    return parseRunnerObservationV1({
      version: RUNNER_ADAPTER_V1,
      type,
      observationId: `${command.commandId}:${type}:${ordinal}`,
      commandId: command.commandId,
      correlationId: command.correlationId,
      adapterId: this.#descriptor.adapterId,
      adapterVersion: this.#descriptor.adapterVersion,
      profileId: command.profileId,
      profileVersion: command.profileVersion,
      runId: command.runId,
      runGeneration: command.runGeneration,
      leaseGeneration: command.leaseGeneration,
      observedAt: openAIAgentsObservationTimeV1(clock, ordinal),
      references,
      observationAuthority: "adapter_report",
      durableTransitionApplied: false,
      ...fields,
    });
  }

  #failure(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    clock: OpenAIAgentsClockBaseV1,
    ordinal: number,
    recoveryAction: "retry" | "reconcile",
  ): RunnerObservationV1 {
    return this.#observation(
      command,
      clock,
      "failure_observed",
      ordinal,
      {
        code: "openai_agents_run_failed",
        message:
          "OpenAI Agents execution failed without a verified remote settlement; inspect adapter-owned diagnostics.",
        recoveryAction,
        remoteSettlementKnown: false,
      },
    );
  }
}

function attestOpenAIAgentsFirstSliceRuntime(
  value: unknown,
): OpenAIAgentsRuntimeManifestV1 {
  const runtime = strictOwnDataRecord(
    value,
    "OpenAI Agents runtime",
    ["agent", "runner", "startInput"],
  );
  const agent = runtime.agent;
  const runner = runtime.runner;
  if (
    !(agent instanceof Agent)
    || Object.getPrototypeOf(agent) !== Agent.prototype
    || !(runner instanceof Runner)
    || Object.getPrototypeOf(runner) !== Runner.prototype
    || typeof runtime.startInput !== "string"
    || runtime.startInput.length === 0
    || runtime.startInput.trim().length === 0
    || runtime.startInput.length > maxStartInputCharacters
  ) {
    throw invalidRuntimeConfiguration();
  }
  if (Object.prototype.hasOwnProperty.call(runner, "run")) {
    throw invalidRuntimeConfiguration();
  }

  assertEmptyLifecycleEmitter(agent);
  assertEmptyLifecycleEmitter(runner);
  assertFirstSliceRunnerConfiguration(runner, agent);

  const manifest = buildOpenAIAgentsRuntimeManifestV1(agent);
  const root = manifest.agents.find(
    (entry) => entry.name === manifest.rootAgentName,
  );
  if (
    manifest.agents.length !== 1
    || !root
    || root.modelKind !== "object"
    || root.handoffAgentNames.length !== 0
  ) {
    throw invalidRuntimeConfiguration();
  }
  return manifest;
}

// This own-field attestation is pinned to @openai/agents-core@0.14.1.
// Keep the exact package pin and these keys synchronized for every SDK bump.
function assertFirstSliceRunnerConfiguration(
  runner: Runner,
  agent: Agent<any, any>,
): void {
  const config = strictOwnDataRecord(
    ownDataProperty(runner, "config", "OpenAI Agents Runner config"),
    "OpenAI Agents Runner config",
    [
      "modelProvider",
      "model",
      "modelSettings",
      "handoffInputFilter",
      "inputGuardrails",
      "outputGuardrails",
      "tracingDisabled",
      "traceIncludeSensitiveData",
      "workflowName",
      "traceId",
      "groupId",
      "traceMetadata",
      "tracing",
      "sandbox",
      "toolExecution",
      "toolNotFoundBehavior",
      "sessionInputCallback",
      "callModelInputFilter",
      "toolErrorFormatter",
      "reasoningItemIdPolicy",
    ],
  );
  if (
    typeof agent.model !== "object"
    || agent.model === null
    || config.model !== agent.model
    || typeof config.modelProvider !== "object"
    || config.modelProvider === null
    || config.modelSettings !== undefined
    || config.handoffInputFilter !== undefined
    || config.inputGuardrails !== undefined
    || config.outputGuardrails !== undefined
    || config.tracingDisabled !== true
    || config.traceIncludeSensitiveData !== false
    || config.workflowName !== "Agent workflow"
    || config.traceId !== undefined
    || config.groupId !== undefined
    || config.traceMetadata !== undefined
    || config.tracing !== undefined
    || config.sandbox !== undefined
    || config.toolExecution !== undefined
    || config.toolNotFoundBehavior !== "raise_error"
    || config.sessionInputCallback !== undefined
    || config.callModelInputFilter !== undefined
    || config.toolErrorFormatter !== undefined
    || config.reasoningItemIdPolicy !== undefined
  ) {
    throw invalidRuntimeConfiguration();
  }

  const traceOverrides = strictOwnDataRecord(
    ownDataProperty(
      runner,
      "traceOverrides",
      "OpenAI Agents Runner trace overrides",
    ),
    "OpenAI Agents Runner trace overrides",
    [],
  );
  if (Object.keys(traceOverrides).length !== 0) {
    throw invalidRuntimeConfiguration();
  }
  assertEmptyArrayProperty(runner, "inputGuardrailDefs");
  assertEmptyArrayProperty(runner, "outputGuardrailDefs");
}

function assertEmptyLifecycleEmitter(value: object): void {
  const emitter = ownDataProperty(
    value,
    "eventEmitter",
    "OpenAI Agents lifecycle emitter",
  );
  if (typeof emitter !== "object" || emitter === null) {
    throw invalidRuntimeConfiguration();
  }
  const count = ownDataProperty(
    emitter,
    "_eventsCount",
    "OpenAI Agents lifecycle event count",
  );
  const events = ownDataProperty(
    emitter,
    "_events",
    "OpenAI Agents lifecycle events",
  );
  if (
    count !== 0
    || typeof events !== "object"
    || events === null
    || Reflect.ownKeys(events).length !== 0
  ) {
    throw invalidRuntimeConfiguration();
  }
}

function assertEmptyArrayProperty(value: object, key: string): void {
  const candidate = ownDataProperty(
    value,
    key,
    `OpenAI Agents Runner ${key}`,
  );
  if (
    !Array.isArray(candidate)
    || Object.getPrototypeOf(candidate) !== Array.prototype
    || candidate.length !== 0
    || Object.getOwnPropertySymbols(candidate).length !== 0
  ) {
    throw invalidRuntimeConfiguration();
  }
}

function invalidRuntimeConfiguration(): RangeError {
  return new RangeError(
    "OpenAI Agents runtime uses unsupported first-slice Runner configuration",
  );
}

function ownDataProperty(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    throw new RangeError(`${label} must be an own data property`);
  }
  return descriptor.value;
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
  if (stableJson(actualKeys) !== stableJson(canonicalExpected)) {
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

function strictOwnDataSubset(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
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
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowedKeys.includes(key)) {
      throw new RangeError(`${label} field ${key} is unsupported`);
    }
    if (descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new RangeError(`${label} field ${key} must be enumerable data`);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function admitOpenAIAgentsCompletionV1(
  value: unknown,
): OpenAIAgentsCompletion {
  try {
    const input = strictOwnDataRecord(
      value,
      "OpenAI Agents completion",
      ["outcome", "executionActual"],
    );
    const outcome = boundedOutcome(input.outcome);
    const actualInput = strictOwnDataSubset(
      input.executionActual,
      "OpenAI Agents execution actual",
      [
        "durationMinutes",
        "messagesConsumed",
        "toolCalls",
        "filesChanged",
        "reviewMinutes",
      ],
    );
    const executionActual = parseExecutionActual(actualInput);
    const canonical = stableJson({ outcome, executionActual });
    if (
      canonical.length > maxArtifactContentCharacters
      || unsafeTextPattern.test(canonical)
      || credentialShapedTextPattern.test(canonical)
    ) {
      throw new RangeError();
    }
    return Object.freeze({ outcome, executionActual });
  } catch {
    throw new RangeError("OpenAI Agents completion is invalid");
  }
}

function admitOpenAIAgentsCheckpointRecordV1(
  value: unknown,
): OpenAIAgentsCheckpointRecordV1 {
  try {
    const input = strictOwnDataRecord(
      value,
      "OpenAI Agents checkpoint envelope",
      [
        "version",
        "adapterId",
        "adapterVersion",
        "profileId",
        "profileVersion",
        "sdkPackageVersion",
        "sdkSchemaVersion",
        "runId",
        "runGeneration",
        "leaseGeneration",
        "checkpointGeneration",
        "serializedState",
        "stateDigest",
        "runtimeManifest",
        "runtimeManifestFingerprint",
        "checkpointDigest",
        "createdAt",
      ],
    );
    if (input.version !== 1) throw new RangeError();
    const runtimeManifest = input.runtimeManifest;
    if (
      typeof runtimeManifest !== "object"
      || runtimeManifest === null
      || Array.isArray(runtimeManifest)
    ) {
      throw new RangeError();
    }
    return {
      version: 1,
      adapterId: checkpointText(input.adapterId, 160),
      adapterVersion: checkpointText(input.adapterVersion, 160),
      profileId: checkpointText(input.profileId, 160),
      profileVersion: checkpointText(input.profileVersion, 160),
      sdkPackageVersion: checkpointText(
        input.sdkPackageVersion,
        32,
      ) as typeof OPENAI_AGENTS_PACKAGE_VERSION,
      sdkSchemaVersion: checkpointText(
        input.sdkSchemaVersion,
        32,
      ) as typeof OPENAI_AGENTS_RUN_STATE_SCHEMA_VERSION,
      runId: checkpointText(input.runId, 160),
      runGeneration: checkpointInteger(input.runGeneration, 0),
      leaseGeneration: checkpointInteger(input.leaseGeneration, 1),
      checkpointGeneration: checkpointInteger(
        input.checkpointGeneration,
        1,
      ),
      serializedState: checkpointText(
        input.serializedState,
        maxSerializedStateCharacters,
      ),
      stateDigest: checkpointText(input.stateDigest, 80),
      runtimeManifest:
        runtimeManifest as unknown as OpenAIAgentsRuntimeManifestV1,
      runtimeManifestFingerprint: checkpointText(
        input.runtimeManifestFingerprint,
        80,
      ),
      checkpointDigest: checkpointText(input.checkpointDigest, 80),
      createdAt: canonicalTimestamp(
        input.createdAt,
        "OpenAI Agents checkpoint creation time",
      ),
    };
  } catch {
    throw new RangeError("OpenAI Agents checkpoint envelope is invalid");
  }
}

function admitCheckpointAppendReceiptV1(
  value: unknown,
  append: OpenAIAgentsCheckpointAppendV1,
): OpenAIAgentsCheckpointAppendReceiptV1 {
  try {
    const input = strictOwnDataRecord(
      value,
      "OpenAI Agents checkpoint append receipt",
      ["externalId", "record", "replayed"],
    );
    const externalId = boundedSafeText(
      input.externalId,
      2_000,
      "OpenAI Agents checkpoint external ID",
    );
    if (typeof input.replayed !== "boolean") throw new RangeError();
    const record = admitOpenAIAgentsCheckpointRecordV1(input.record);
    const admittedManifest = requireOpenAIAgentsRuntimeManifestV1(
      record.runtimeManifest,
      append.runtimeManifest,
    );
    if (
      record.adapterId !== append.adapterId
      || record.adapterVersion !== append.adapterVersion
      || record.profileId !== append.profileId
      || record.profileVersion !== append.profileVersion
      || record.sdkPackageVersion !== append.sdkPackageVersion
      || record.sdkSchemaVersion !== append.sdkSchemaVersion
      || record.runId !== append.runId
      || record.runGeneration !== append.runGeneration
      || record.leaseGeneration !== append.leaseGeneration
      || record.serializedState !== append.serializedState
      || record.stateDigest !== append.stateDigest
      || admittedManifest.fingerprint !== append.runtimeManifestFingerprint
      || record.runtimeManifestFingerprint !== append.runtimeManifestFingerprint
      || (input.replayed === false && record.createdAt !== append.proposedCreatedAt)
      || checkpointEnvelopeDigest(record) !== record.checkpointDigest
    ) {
      throw new RangeError();
    }
    return Object.freeze({
      externalId,
      record,
      replayed: input.replayed,
    });
  } catch {
    throw new RangeError("OpenAI Agents checkpoint append receipt is invalid");
  }
}

function admitArtifactSaveReceiptV1(
  value: unknown,
): { readonly externalId: string } {
  try {
    const input = strictOwnDataRecord(
      value,
      "OpenAI Agents artifact save receipt",
      ["externalId"],
    );
    return Object.freeze({
      externalId: boundedSafeText(
        input.externalId,
        2_000,
        "OpenAI Agents artifact external ID",
      ),
    });
  } catch {
    throw new RangeError("OpenAI Agents artifact save receipt is invalid");
  }
}

function admitControlCommandV1(
  value: unknown,
  cancellation: false,
): RunnerCheckpointCommandV1;
function admitControlCommandV1(
  value: unknown,
  cancellation: true,
): RunnerCancellationCommandV1;
function admitControlCommandV1(
  value: unknown,
  cancellation: boolean,
): RunnerCheckpointCommandV1 | RunnerCancellationCommandV1 {
  try {
    return parseControlCommandV1(value, cancellation);
  } catch {
    throw new RangeError("OpenAI Agents control command is invalid");
  }
}

function parseControlCommandV1(
  value: unknown,
  cancellation: boolean,
): RunnerCheckpointCommandV1 | RunnerCancellationCommandV1 {
  const input = strictOwnDataRecord(
    value,
    "OpenAI Agents control command",
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
  const runId = canonicalIdentifier(
    input.runId,
    "OpenAI Agents control run ID",
  );
  const leaseGeneration = checkpointInteger(input.leaseGeneration, 1);
  const authority = admitControlAuthorityV1(
    input.authority,
    runId,
    leaseGeneration,
  );
  const base = {
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
    runGeneration: checkpointInteger(input.runGeneration, 0),
    leaseGeneration,
    authority,
    requestedAt: canonicalTimestamp(
      input.requestedAt,
      "OpenAI Agents control request time",
    ),
  };
  if (!cancellation) return Object.freeze(base);
  return Object.freeze({
    ...base,
    reason: canonicalBoundedText(
      input.reason,
      2_000,
      "OpenAI Agents cancellation reason",
    ),
  });
}

function admitControlAuthorityV1(
  value: unknown,
  runId: string,
  leaseGeneration: number,
): RunAuthorityFence {
  const input = strictOwnDataRecord(
    value,
    "OpenAI Agents control authority",
    ["resource", "holderId", "generation", "expiresAt"],
  );
  const resource = canonicalBoundedText(
    input.resource,
    320,
    "OpenAI Agents control authority resource",
  );
  const generation = checkpointInteger(input.generation, 1);
  if (resource !== `run:${runId}` || generation !== leaseGeneration) {
    throw new RangeError();
  }
  return Object.freeze({
    resource: resource as `run:${string}`,
    holderId: canonicalIdentifier(
      input.holderId,
      "OpenAI Agents control authority holder",
    ),
    generation,
    expiresAt: canonicalTimestamp(
      input.expiresAt,
      "OpenAI Agents control authority expiry",
    ),
  });
}

function admitCancellationObservationV1(
  value: unknown,
): RunnerCancellationObservationV1 {
  const input = strictOwnDataRecord(
    value,
    "OpenAI Agents cancellation observation",
    [
      "version",
      "commandId",
      "adapterId",
      "adapterVersion",
      "profileId",
      "runId",
      "runGeneration",
      "leaseGeneration",
      "observedAt",
      "requestAccepted",
      "deliveryKnown",
      "remoteSettlementKnown",
      "reference",
    ],
  );
  if (
    input.version !== RUNNER_ADAPTER_V1
    || typeof input.requestAccepted !== "boolean"
    || typeof input.deliveryKnown !== "boolean"
    || input.remoteSettlementKnown !== false
    || input.reference !== null
  ) {
    throw new RangeError("OpenAI Agents cancellation observation is invalid");
  }
  return Object.freeze({
    version: RUNNER_ADAPTER_V1,
    commandId: canonicalIdentifier(input.commandId, "Cancellation command ID"),
    adapterId: canonicalIdentifier(input.adapterId, "Cancellation adapter ID"),
    adapterVersion: canonicalBoundedText(
      input.adapterVersion,
      160,
      "Cancellation adapter version",
    ),
    profileId: canonicalIdentifier(input.profileId, "Cancellation profile ID"),
    runId: canonicalIdentifier(input.runId, "Cancellation run ID"),
    runGeneration: checkpointInteger(input.runGeneration, 0),
    leaseGeneration: checkpointInteger(input.leaseGeneration, 1),
    observedAt: canonicalTimestamp(
      input.observedAt,
      "Cancellation observation time",
    ),
    requestAccepted: input.requestAccepted,
    deliveryKnown: input.deliveryKnown,
    remoteSettlementKnown: false,
    reference: null,
  });
}

function checkpointText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
  ) {
    throw new RangeError();
  }
  return value;
}

function checkpointInteger(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RangeError();
  }
  return value as number;
}

function requiredCheckpointReference(
  command: RunnerResumeCommandV1,
  descriptor: RunnerAdapterDescriptorV1,
): RunnerExternalReferenceV1 {
  const reference = command.checkpointRef;
  if (!reference) {
    throw new RangeError(
      "OpenAI Agents resume requires a checkpoint reference",
    );
  }
  if (
    reference.kind !== "checkpoint"
    || reference.adapterId !== descriptor.adapterId
    || reference.externalId === null
    || reference.digest === null
    || reference.generation === null
  ) {
    throw new RangeError(
      "OpenAI Agents checkpoint reference is incomplete or cross-adapter",
    );
  }
  if (
    command.adapterResumeRef !== null
    && command.adapterResumeRef.adapterId !== descriptor.adapterId
  ) {
    throw new RangeError("OpenAI Agents resume reference is cross-adapter");
  }
  return reference;
}

function requireExecutableCapabilities(
  snapshot: EffectiveToolSurfaceSnapshot,
): void {
  if (
    snapshot.missingRequiredCapabilities.length > 0
    || snapshot.catalogueOnlyRequiredCapabilities.length > 0
  ) {
    throw new RangeError(
      "OpenAI Agents current tool surface cannot satisfy the required capabilities",
    );
  }
}

function requireInspectionSnapshot(
  binding: RunnerCapabilityCommandBindingV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
): EffectiveToolSurfaceSnapshot {
  const requireInspection = requireRunnerCapabilityInspectionForCommandV1 as (
    bindingValue: RunnerCapabilityCommandBindingV1,
    commandValue: RunnerStartCommandV1 | RunnerResumeCommandV1,
  ) => EffectiveToolSurfaceSnapshot;
  return requireInspection(binding, command);
}

function inspectionKey(
  input: {
    runId: string;
    runGeneration: number;
    profileId: string;
    requiredCapabilities: readonly ToolSurfaceCapabilityRequirementInput[];
  },
  transition: string,
): string {
  return stableJson([
    input.runId,
    input.runGeneration,
    input.profileId,
    transition,
    capabilityRequirementDigest(input.requiredCapabilities),
  ]);
}

function capabilityRequirementDigest(
  requirements: readonly ToolSurfaceCapabilityRequirementInput[],
): string {
  const canonical = [...requirements]
    .map((requirement) => ({
      class: requirement.class,
      id: requirement.id,
    }))
    .sort((left, right) =>
      compareText(left.class, right.class)
      || compareText(left.id, right.id)
    );
  return sha256(stableJson(canonical));
}

function checkpointPublicationKey(
  descriptor: RunnerAdapterDescriptorV1,
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  ordinal: number,
): string {
  return sha256(stableJson([
    descriptor.adapterId,
    descriptor.adapterVersion,
    command.profileId,
    command.profileVersion,
    command.commandId,
    command.kind,
    command.runId,
    command.runGeneration,
    command.leaseGeneration,
    ordinal,
  ]));
}

function checkpointEnvelopeDigest(
  record: Omit<OpenAIAgentsCheckpointRecordV1, "checkpointDigest">
    | OpenAIAgentsCheckpointRecordV1,
): string {
  return sha256(stableJson({
    version: record.version,
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    profileId: record.profileId,
    profileVersion: record.profileVersion,
    sdkPackageVersion: record.sdkPackageVersion,
    sdkSchemaVersion: record.sdkSchemaVersion,
    runId: record.runId,
    runGeneration: record.runGeneration,
    leaseGeneration: record.leaseGeneration,
    checkpointGeneration: record.checkpointGeneration,
    stateDigest: record.stateDigest,
    runtimeManifestFingerprint: record.runtimeManifestFingerprint,
    createdAt: record.createdAt,
  }));
}

function assertControlAuthorityActive(
  input: RunnerCheckpointCommandV1 | RunnerCancellationCommandV1,
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

function controlKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return `${input.runId}:${input.runGeneration}:${input.leaseGeneration}`;
}

function serializedSchemaVersion(serializedState: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedState);
  } catch {
    throw new RangeError(
      "OpenAI Agents serialized state is not valid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RangeError(
      "OpenAI Agents serialized state must be an object",
    );
  }
  const version = (parsed as Record<string, unknown>).$schemaVersion;
  if (typeof version !== "string" || version.length === 0) {
    throw new RangeError(
      "OpenAI Agents serialized state lacks a schema version",
    );
  }
  return version;
}

function boundedOutcome(value: unknown): string {
  if (typeof value !== "string" || !outcomePattern.test(value)) {
    throw new RangeError("OpenAI Agents completion outcome is invalid");
  }
  if (
    unsafeTextPattern.test(value)
    || credentialShapedTextPattern.test(value)
  ) {
    throw new RangeError("OpenAI Agents completion outcome is invalid");
  }
  return value;
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

function boundedSafeText(
  value: unknown,
  maximum: number,
  label: string,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim().length === 0
    || value.length > maximum
    || unsafeTextPattern.test(value)
    || credentialShapedTextPattern.test(value)
  ) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !exactTimestampPattern.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError(`${label} is invalid`);
  }
  try {
    if (new Date(milliseconds).toISOString() !== value) {
      throw new RangeError(`${label} is invalid`);
    }
  } catch {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
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
