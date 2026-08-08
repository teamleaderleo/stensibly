import {
  ToolLoopAgent,
  type Agent,
  type ToolLoopAgentSettings,
} from "ai";
import { sha256, stableJson } from "../canonical-json.js";
import type {
  EffectiveToolSurfaceSnapshot,
  EffectiveToolSurfaceSnapshotInput,
  ToolSurfaceCapabilityRequirementInput,
} from "../effective-tool-surface.js";
import {
  bindRunnerCapabilityInspectionToCommandV1,
  buildRunnerCapabilityInspectionV1,
  requireRunnerCapabilityInspectionForCommandV1,
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

export const VERCEL_AI_SDK_PACKAGE_VERSION = "7.0.58";
export const VERCEL_AI_SDK_ADAPTER_ID = "vercel-ai-sdk";
export const VERCEL_AI_SDK_ADAPTER_VERSION = "0.1.0";
export const VERCEL_AI_SDK_PROFILE_ID = "tool-loop-agent";
export const VERCEL_AI_SDK_PROFILE_VERSION = `ai@${VERCEL_AI_SDK_PACKAGE_VERSION}`;

const maximumCheckpointCharacters = 1_000_000;
const maximumCachedEntries = 256;
const maximumInspectionAgeMilliseconds = 60 * 60 * 1_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/;
const exactTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type AnyAgent = Agent<never, any, any, any>;
type AnyToolLoopAgentSettings = ToolLoopAgentSettings<never, any, any, any>;
type GuardedToolLoopAgentSettings = Omit<
  AnyToolLoopAgentSettings,
  | "activeTools"
  | "experimental_download"
  | "experimental_onStart"
  | "experimental_onStepStart"
  | "experimental_refineToolInput"
  | "experimental_repairToolCall"
  | "experimental_telemetry"
  | "experimental_toolCallers"
  | "onEnd"
  | "onFinish"
  | "onStart"
  | "onStepEnd"
  | "onStepFinish"
  | "onStepStart"
  | "onToolExecutionEnd"
  | "onToolExecutionStart"
  | "prepareCall"
  | "prepareStep"
  | "repairToolCall"
  | "runtimeContext"
  | "stopWhen"
  | "telemetry"
  | "toolApproval"
  | "_internal"
>;

interface PendingCapabilityInspection {
  probe: RunnerCapabilityProbeV1;
  inspection: RunnerCapabilityInspectionV1;
}

export interface VercelAISDKCheckpointRecordV1 {
  version: 1;
  externalId: string;
  adapterVersion: string;
  commandId: string;
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
  profileId: string;
  profileVersion: string;
  createdAt: string;
  bindingDigest: string;
  messagesDigest: string;
  messages: readonly unknown[];
}

export interface VercelAISDKCheckpointStore {
  saveCheckpoint(record: VercelAISDKCheckpointRecordV1): Promise<void> | void;
  loadCheckpoint(
    externalId: string,
  ): Promise<VercelAISDKCheckpointRecordV1 | null> | VercelAISDKCheckpointRecordV1 | null;
}

export interface VercelAISDKToolExecutionInput {
  command: RunnerStartCommandV1 | RunnerResumeCommandV1;
  event: unknown;
}

export interface VercelAISDKRunnerAdapterOptions {
  agentSettings: GuardedToolLoopAgentSettings;
  checkpointStore: VercelAISDKCheckpointStore;
  capabilityClasses?: (
    input: RunnerCapabilityProbeV1,
    agent: AnyAgent,
  ) => EffectiveToolSurfaceSnapshotInput["classes"];
  authorizeToolExecution?: (
    input: VercelAISDKToolExecutionInput,
  ) => Promise<void> | void;
  now?: () => Date;
}

export class VercelAISDKRunnerAdapter implements RunnerAdapterV1 {
  readonly #agent: AnyAgent;
  readonly #checkpointStore: VercelAISDKCheckpointStore;
  readonly #capabilityClasses: NonNullable<
    VercelAISDKRunnerAdapterOptions["capabilityClasses"]
  >;
  readonly #authorizeToolExecution?: VercelAISDKRunnerAdapterOptions["authorizeToolExecution"];
  readonly #now: () => Date;
  readonly #descriptor: RunnerAdapterDescriptorV1;
  readonly #inspections = new Map<string, PendingCapabilityInspection>();
  readonly #latestCheckpoints = new Map<string, RunnerExternalReferenceV1>();
  readonly #activeAbortControllers = new Map<string, AbortController>();
  readonly #authorityHolders = new Map<string, string>();

  constructor(options: VercelAISDKRunnerAdapterOptions) {
    this.#checkpointStore = options.checkpointStore;
    this.#capabilityClasses = options.capabilityClasses ?? defaultCapabilityClasses;
    this.#authorizeToolExecution = options.authorizeToolExecution;
    this.#now = options.now ?? (() => new Date());
    assertStaticAgentSettings(options.agentSettings);
    this.#agent = new ToolLoopAgent({
      ...options.agentSettings,
      toolApproval: async (event: any) => {
        if (!this.#authorizeToolExecution) {
          throw new Error(
            "Stensibly tool authorization is required before AI SDK tool execution",
          );
        }
        try {
          await this.#authorizeToolExecution({
            command: event.runtimeContext.command,
            event,
          });
        } catch {
          throw new Error(
            "Stensibly tool authorization rejected the AI SDK tool proposal",
          );
        }
        return "approved" as const;
      },
    } as AnyToolLoopAgentSettings);
    this.#descriptor = parseRunnerAdapterDescriptorV1({
      version: RUNNER_ADAPTER_V1,
      adapterId: VERCEL_AI_SDK_ADAPTER_ID,
      adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
      profiles: [
        {
          id: VERCEL_AI_SDK_PROFILE_ID,
          version: VERCEL_AI_SDK_PROFILE_VERSION,
        },
      ],
      transports: ["in_process"],
      checkpointMode: "external_reference",
      cancellationMode: "best_effort",
      supports: {
        start: true,
        resume: true,
        capabilityInspection: true,
        streamingObservations: true,
        durableReplay: false,
        usageReferences: false,
        traceReferences: false,
      },
    });
  }

  describe(): RunnerAdapterDescriptorV1 {
    return this.#descriptor;
  }

  async inspectCapabilities(
    value: RunnerCapabilityProbeV1,
  ): Promise<EffectiveToolSurfaceSnapshot> {
    const probe = parseRunnerCapabilityProbeV1(value);
    this.#assertProbeBinding(probe);
    assertNoProviderExecutedTools(this.#agent);
    assertNoPreAuthorizationToolHooks(this.#agent);
    const inspection = buildRunnerCapabilityInspectionV1(
      this.#descriptor,
      probe,
      this.#capabilityClasses(probe, this.#agent),
    );
    setBoundedMap(this.#inspections, inspectionKey(probe, probe.transition), {
      probe,
      inspection,
    });
    return inspection.snapshot;
  }

  async *start(value: RunnerStartCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerStartCommandV1(value);
    this.#assertCommandBinding(command);
    const clock = this.#invocationTime();
    assertRunnerCommandAuthorityActiveV1(command, clock);
    const snapshot = this.#requiredSnapshot(command, "new", clock.getTime());
    requireExecutableCapabilities(snapshot);
    this.#admitAuthority(command);
    const abortController = this.#startAbortController(command);

    try {
      yield observation(command, clock, "start_accepted", 2);
      yield observation(command, clock, "execution_started", 3);
      yield observation(command, clock, "tool_surface_observed", 4, { snapshot });

      const result = await this.#generate(command, {
        prompt: command.context.intent.objective,
        abortSignal: abortController.signal,
      });

      yield observation(command, clock, "work_step", 5, {
        phase: "ai_sdk_call",
        summary: `AI SDK ToolLoopAgent completed ${arrayLength(result.steps)} step(s) with ${arrayLength(result.toolCalls)} tool call(s).`,
      });

      const reference = checkpointReference(
        command,
        observationTimestamp(clock, 6),
      );
      const messages = boundedCheckpointMessages([
        { role: "user", content: command.context.intent.objective },
        ...arrayValue(result.responseMessages),
      ]);
      await this.#checkpointStore.saveCheckpoint({
        version: 1,
        externalId: requiredExternalId(reference),
        adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
        commandId: command.commandId,
        runId: command.runId,
        runGeneration: command.runGeneration,
        leaseGeneration: command.leaseGeneration,
        profileId: command.profileId,
        profileVersion: command.profileVersion,
        createdAt: reference.createdAt,
        bindingDigest: reference.digest!,
        messagesDigest: sha256(stableJson(messages)),
        messages,
      });
      setBoundedMap(this.#latestCheckpoints, runKey(command), reference);

      yield observation(command, clock, "checkpoint_published", 6, { reference });
      yield observation(command, clock, "interrupted", 7, {
        code: "bounded_ai_sdk_slice_complete",
        message: "The bounded AI SDK call completed and published a resumable external checkpoint.",
        checkpointRef: reference,
        recoveryAction: "resume",
        remoteSettlementKnown: false,
      });
    } catch (error) {
      yield observation(command, clock, "failure_observed", 8, {
        code: abortController.signal.aborted ? "ai_sdk_aborted" : "ai_sdk_generation_failed",
        message: failureMessage(error, abortController.signal.aborted),
        recoveryAction: abortController.signal.aborted ? "resume" : "retry",
        remoteSettlementKnown: false,
      });
    } finally {
      this.#activeAbortControllers.delete(runKey(command));
    }
  }

  async *resume(value: RunnerResumeCommandV1): AsyncIterable<RunnerObservationV1> {
    const command = parseRunnerResumeCommandV1(value);
    this.#assertCommandBinding(command);
    const clock = this.#invocationTime();
    assertRunnerCommandAuthorityActiveV1(command, clock);
    const snapshot = this.#requiredSnapshot(command, "resume", clock.getTime());
    requireExecutableCapabilities(snapshot);
    const checkpointRef = command.checkpointRef ?? command.adapterResumeRef;
    if (checkpointRef === null || checkpointRef.kind !== "checkpoint") {
      throw new RangeError("AI SDK resume requires a checkpoint reference");
    }
    assertCheckpointReferenceBinding(checkpointRef, command);
    const externalId = requiredExternalId(checkpointRef);
    let loaded: VercelAISDKCheckpointRecordV1 | null;
    try {
      loaded = await this.#checkpointStore.loadCheckpoint(externalId);
    } catch {
      throw new RangeError("AI SDK checkpoint lookup failed");
    }
    const checkpoint = admitCheckpointRecord(
      loaded,
      checkpointRef,
      command,
    );
    this.#admitAuthority(command);

    const abortController = this.#startAbortController(command);

    try {
      yield observation(command, clock, "resume_accepted", 2);
      yield observation(command, clock, "execution_started", 3);
      yield observation(command, clock, "tool_surface_observed", 4, { snapshot });

      const result = await this.#generate(command, {
        messages: [
          ...checkpoint.messages,
          {
            role: "user",
            content: command.context.intent.nextAction
              ?? "Continue the bounded runner objective from the checkpoint.",
          },
        ],
        abortSignal: abortController.signal,
      });

      yield observation(command, clock, "heartbeat", 5, {
        usage: usageFromResult(result),
        checkpointRef,
      });
      yield observation(command, clock, "completion_proposed", 6, {
        outcome: "AI SDK ToolLoopAgent completed the resumed bounded objective.",
        executionActual: { toolCalls: arrayLength(result.toolCalls) },
      });
    } catch (error) {
      yield observation(command, clock, "failure_observed", 7, {
        code: abortController.signal.aborted ? "ai_sdk_aborted" : "ai_sdk_generation_failed",
        message: failureMessage(error, abortController.signal.aborted),
        recoveryAction: abortController.signal.aborted ? "resume" : "retry",
        remoteSettlementKnown: false,
      });
    } finally {
      this.#activeAbortControllers.delete(runKey(command));
    }
  }

  async requestCheckpoint(
    value: RunnerCheckpointCommandV1,
  ): Promise<RunnerExternalReferenceV1> {
    const input = admitControlCommand(value, false);
    assertControlAuthorityActive(input, this.#invocationTime());
    this.#assertControlBinding(input);
    const checkpoint = this.#latestCheckpoints.get(controlKey(input));
    if (!checkpoint) {
      throw new RangeError("AI SDK latest checkpoint is unavailable for this adapter instance");
    }
    return checkpoint;
  }

  async requestCancellation(
    value: RunnerCancellationCommandV1,
  ): Promise<RunnerCancellationObservationV1> {
    const input = admitControlCommand(value, true);
    const clock = this.#invocationTime();
    assertControlAuthorityActive(input, clock);
    this.#assertControlBinding(input);
    const controller = this.#activeAbortControllers.get(controlKey(input));
    controller?.abort(input.reason);
    return {
      version: RUNNER_ADAPTER_V1,
      commandId: input.commandId,
      adapterId: VERCEL_AI_SDK_ADAPTER_ID,
      adapterVersion: VERCEL_AI_SDK_ADAPTER_VERSION,
      profileId: input.profileId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      leaseGeneration: input.leaseGeneration,
      observedAt: observationTimestamp(clock, 1),
      requestAccepted: true,
      deliveryKnown: controller !== undefined,
      remoteSettlementKnown: false,
      reference: null,
    };
  }

  async #generate(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    input: Record<string, unknown>,
  ): Promise<any> {
    return await this.#agent.generate({
      ...input,
      runtimeContext: { command },
    } as any);
  }

  #requiredSnapshot(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
    transition: "new" | "resume",
    currentTime: number,
  ): EffectiveToolSurfaceSnapshot {
    const key = inspectionKey(command, transition);
    const pending = this.#inspections.get(key);
    if (!pending) {
      throw new RangeError(
        `AI SDK ${transition} requires a current capability inspection before execution`,
      );
    }
    const observedAt = Date.parse(pending.inspection.observedAt);
    if (
      !Number.isFinite(observedAt)
      || observedAt > currentTime
      || currentTime - observedAt > maximumInspectionAgeMilliseconds
    ) {
      this.#inspections.delete(key);
      throw new RangeError("AI SDK capability inspection is stale for execution");
    }

    assertNoProviderExecutedTools(this.#agent);
    assertNoPreAuthorizationToolHooks(this.#agent);
    const currentInspection = buildRunnerCapabilityInspectionV1(
      this.#descriptor,
      pending.probe,
      this.#capabilityClasses(pending.probe, this.#agent),
    );
    if (
      currentInspection.snapshot.surfaceFingerprint
        !== pending.inspection.snapshot.surfaceFingerprint
    ) {
      this.#inspections.delete(key);
      throw new RangeError(
        "AI SDK capability surface changed after inspection and before execution",
      );
    }

    const binding = bindRunnerCapabilityInspectionToCommandV1(
      pending.inspection,
      command,
    );
    const requireInspection = requireRunnerCapabilityInspectionForCommandV1 as (
      bindingValue: typeof binding,
      commandValue: RunnerStartCommandV1 | RunnerResumeCommandV1,
    ) => EffectiveToolSurfaceSnapshot;
    const snapshot = requireInspection(binding, command);
    this.#inspections.delete(key);
    return snapshot;
  }

  #invocationTime(): Date {
    const value = this.#now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new RangeError("AI SDK adapter clock is invalid");
    }
    return new Date(value.getTime());
  }

  #admitAuthority(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  ): void {
    const key = controlKey(command);
    const admitted = this.#authorityHolders.get(key);
    if (admitted !== undefined && admitted !== command.authority.holderId) {
      throw new RangeError("AI SDK command authority holder is stale");
    }
    setBoundedMap(this.#authorityHolders, key, command.authority.holderId);
  }

  #startAbortController(
    command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  ): AbortController {
    const key = runKey(command);
    if (this.#activeAbortControllers.has(key)) {
      throw new RangeError("AI SDK execution is already active for this lease");
    }
    if (this.#activeAbortControllers.size >= maximumCachedEntries) {
      throw new RangeError("AI SDK active execution capacity is exhausted");
    }
    const controller = new AbortController();
    this.#activeAbortControllers.set(key, controller);
    return controller;
  }

  #assertProbeBinding(probe: RunnerCapabilityProbeV1): void {
    if (
      probe.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
      || probe.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || probe.profileId !== VERCEL_AI_SDK_PROFILE_ID
    ) {
      throw new RangeError("AI SDK capability probe does not match adapter identity");
    }
  }

  #assertCommandBinding(command: RunnerStartCommandV1 | RunnerResumeCommandV1): void {
    if (
      command.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
      || command.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || command.profileId !== VERCEL_AI_SDK_PROFILE_ID
      || command.profileVersion !== VERCEL_AI_SDK_PROFILE_VERSION
    ) {
      throw new RangeError("AI SDK command does not match adapter identity");
    }
  }

  #assertControlBinding(
    input: RunnerCheckpointCommandV1 | RunnerCancellationCommandV1,
  ): void {
    if (
      input.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
      || input.adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || input.profileId !== VERCEL_AI_SDK_PROFILE_ID
    ) {
      throw new RangeError("AI SDK control command does not match adapter identity");
    }
    if (
      input.authority.resource !== `run:${input.runId}`
      || input.authority.generation !== input.leaseGeneration
    ) {
      throw new RangeError("AI SDK control command authority binding is invalid");
    }
    const admitted = this.#authorityHolders.get(controlKey(input));
    if (admitted === undefined || admitted !== input.authority.holderId) {
      throw new RangeError("AI SDK control command authority holder is stale");
    }
  }
}

function assertStaticAgentSettings(settings: GuardedToolLoopAgentSettings): void {
  const forbidden = [
    "activeTools",
    "experimental_download",
    "experimental_onStart",
    "experimental_onStepStart",
    "experimental_refineToolInput",
    "experimental_repairToolCall",
    "experimental_telemetry",
    "experimental_toolCallers",
    "onEnd",
    "onFinish",
    "onStart",
    "onStepEnd",
    "onStepFinish",
    "onStepStart",
    "onToolExecutionEnd",
    "onToolExecutionStart",
    "prepareCall",
    "prepareStep",
    "repairToolCall",
    "runtimeContext",
    "stopWhen",
    "telemetry",
    "toolApproval",
    "_internal",
  ];
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(settings, key))) {
    throw new RangeError(
      "AI SDK first-profile settings contain an unsupported dynamic or callback surface",
    );
  }
  assertNoPreAuthorizationToolHooks({ tools: settings.tools } as AnyAgent);
}

function assertNoPreAuthorizationToolHooks(agent: AnyAgent): void {
  for (const [id, value] of Object.entries(
    (agent.tools ?? {}) as Record<string, unknown>,
  )) {
    if (
      value !== null
      && typeof value === "object"
      && ["onInputStart", "onInputDelta", "onInputAvailable"].some((key) =>
        typeof (value as Record<string, unknown>)[key] === "function"
      )
    ) {
      throw new RangeError(
        `AI SDK first-profile tool ${id} contains a pre-authorization input hook`,
      );
    }
  }
}

export function vercelAISDKCheckpointReferenceForStart(
  value: RunnerStartCommandV1,
  createdAt?: string,
): RunnerExternalReferenceV1 {
  const command = parseRunnerStartCommandV1(value);
  return checkpointReference(
    command,
    createdAt ?? offsetTimestamp(command.issuedAt, 6),
  );
}

function defaultCapabilityClasses(
  _probe: RunnerCapabilityProbeV1,
  agent: AnyAgent,
): EffectiveToolSurfaceSnapshotInput["classes"] {
  const catalogue: Array<{ id: string; name: string }> = [];
  const executable: Array<{ id: string; name: string }> = [];
  for (const [id, value] of Object.entries(
    (agent.tools ?? {}) as Record<string, unknown>,
  )) {
    const capability = { id, name: id };
    catalogue.push(capability);
    if (isLocallyExecutableAITool(value)) executable.push(capability);
  }
  catalogue.sort((left, right) => left.id.localeCompare(right.id));
  executable.sort((left, right) => left.id.localeCompare(right.id));
  return {
    host_dynamic: {
      catalogue,
      executable,
      provenance: [`ai-sdk:${VERCEL_AI_SDK_PACKAGE_VERSION}:tool-loop-agent`],
    },
  };
}

function assertNoProviderExecutedTools(agent: AnyAgent): void {
  for (const [id, value] of Object.entries(
    (agent.tools ?? {}) as Record<string, unknown>,
  )) {
    if (isProviderExecutedAITool(value)) {
      throw new RangeError(
        `AI SDK provider-executed tool ${id} is outside the first Stensibly profile`,
      );
    }
  }
}

function isProviderExecutedAITool(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && (value as { type?: unknown }).type === "provider"
    && (value as { isProviderExecuted?: unknown }).isProviderExecuted === true;
}

function isLocallyExecutableAITool(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && "execute" in value
    && typeof (value as { execute?: unknown }).execute === "function";
}

function checkpointReference(
  command: RunnerStartCommandV1,
  createdAt: string,
): RunnerExternalReferenceV1 {
  return parseRunnerExternalReferenceV1({
    version: RUNNER_ADAPTER_V1,
    kind: "checkpoint",
    adapterId: VERCEL_AI_SDK_ADAPTER_ID,
    externalId: `ai-sdk-checkpoint-${sha256(stableJson([
      command.profileId,
      command.profileVersion,
      command.commandId,
      command.runId,
      command.runGeneration,
      command.leaseGeneration,
    ])).slice("sha256:".length)}`,
    digest: checkpointBindingDigest(command),
    uri: null,
    generation: command.runGeneration,
    createdAt,
    accessClass: "project",
    containsPrivateContent: false,
    containsCredentials: false,
  });
}

function assertCheckpointReferenceBinding(
  reference: RunnerExternalReferenceV1,
  command: RunnerResumeCommandV1,
): void {
  if (
    reference.adapterId !== VERCEL_AI_SDK_ADAPTER_ID
    || reference.generation !== command.runGeneration
    || reference.digest === null
    || reference.externalId === null
  ) {
    throw new RangeError("AI SDK checkpoint reference does not match the current run binding");
  }
}

function admitCheckpointRecord(
  value: VercelAISDKCheckpointRecordV1 | null,
  reference: RunnerExternalReferenceV1,
  command: RunnerResumeCommandV1,
): VercelAISDKCheckpointRecordV1 {
  const expected = [
    "adapterVersion",
    "bindingDigest",
    "commandId",
    "createdAt",
    "externalId",
    "leaseGeneration",
    "messages",
    "messagesDigest",
    "profileId",
    "profileVersion",
    "runGeneration",
    "runId",
    "version",
  ];
  try {
    const input = strictDataRecord(value, expected);
    if (input.version !== 1) throw new RangeError();
    const externalId = boundedIdentifier(input.externalId);
    const adapterVersion = boundedText(input.adapterVersion, 160);
    const commandId = boundedIdentifier(input.commandId);
    const runId = boundedIdentifier(input.runId);
    const runGeneration = boundedInteger(input.runGeneration, 0);
    const leaseGeneration = boundedInteger(input.leaseGeneration, 1);
    const profileId = boundedIdentifier(input.profileId);
    const profileVersion = boundedText(input.profileVersion, 160);
    const createdAt = canonicalTimestamp(input.createdAt);
    const bindingDigest = boundedDigest(input.bindingDigest);
    const messagesDigest = boundedDigest(input.messagesDigest);
    const messages = boundedCheckpointMessages(input.messages);
    const expectedBinding = sha256(stableJson([
      VERCEL_AI_SDK_ADAPTER_ID,
      VERCEL_AI_SDK_ADAPTER_VERSION,
      profileId,
      profileVersion,
      commandId,
      runId,
      runGeneration,
      leaseGeneration,
    ]));
    if (
      externalId !== reference.externalId
      || adapterVersion !== VERCEL_AI_SDK_ADAPTER_VERSION
      || runId !== command.runId
      || runGeneration !== command.runGeneration
      || leaseGeneration !== command.leaseGeneration
      || profileId !== command.profileId
      || profileVersion !== command.profileVersion
      || createdAt !== reference.createdAt
      || bindingDigest !== reference.digest
      || bindingDigest !== expectedBinding
      || messagesDigest !== sha256(stableJson(messages))
    ) {
      throw new RangeError();
    }
    return Object.freeze({
      version: 1,
      externalId,
      adapterVersion,
      commandId,
      runId,
      runGeneration,
      leaseGeneration,
      profileId,
      profileVersion,
      createdAt,
      bindingDigest,
      messagesDigest,
      messages: Object.freeze(messages),
    });
  } catch {
    throw new RangeError("AI SDK checkpoint does not match the current run binding");
  }
}

function observation(
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
  clock: Date,
  type: RunnerObservationV1["type"],
  offsetSeconds: number,
  payload: Record<string, unknown> = {},
): RunnerObservationV1 {
  return parseRunnerObservationV1({
    version: RUNNER_ADAPTER_V1,
    type,
    observationId: `${command.commandId}.${type}.${offsetSeconds}`,
    commandId: command.commandId,
    correlationId: command.correlationId,
    adapterId: command.adapterId,
    adapterVersion: command.adapterVersion,
    profileId: command.profileId,
    profileVersion: command.profileVersion,
    runId: command.runId,
    runGeneration: command.runGeneration,
    leaseGeneration: command.leaseGeneration,
    observedAt: observationTimestamp(clock, offsetSeconds),
    references: [],
    observationAuthority: "adapter_report",
    durableTransitionApplied: false,
    ...payload,
  });
}

function usageFromResult(result: any) {
  const usage = result?.usage;
  const inputTokens = tokenTotal(usage?.inputTokens);
  const outputTokens = tokenTotal(usage?.outputTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    toolCalls: arrayLength(result?.toolCalls),
    childAgents: 0,
  };
}

function tokenTotal(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (
    value !== null
    && typeof value === "object"
    && typeof (value as { total?: unknown }).total === "number"
  ) {
    const total = (value as { total: number }).total;
    return Number.isFinite(total) && total >= 0 ? total : undefined;
  }
  return undefined;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function runKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return `${input.runId}:${input.runGeneration}:${input.leaseGeneration}`;
}

function controlKey(input: {
  runId: string;
  runGeneration: number;
  leaseGeneration: number;
}): string {
  return runKey(input);
}

function admitControlCommand(
  value: unknown,
  cancellation: false,
): RunnerCheckpointCommandV1;
function admitControlCommand(
  value: unknown,
  cancellation: true,
): RunnerCancellationCommandV1;
function admitControlCommand(
  value: unknown,
  cancellation: boolean,
): RunnerCheckpointCommandV1 | RunnerCancellationCommandV1 {
  try {
    const fields = cancellation
      ? [
        "version", "commandId", "adapterId", "adapterVersion", "profileId",
        "runId", "runGeneration", "leaseGeneration", "authority",
        "requestedAt", "reason",
      ]
      : [
        "version", "commandId", "adapterId", "adapterVersion", "profileId",
        "runId", "runGeneration", "leaseGeneration", "authority",
        "requestedAt",
      ];
    const input = strictDataRecord(value, fields);
    if (input.version !== RUNNER_ADAPTER_V1) throw new RangeError();
    const runId = boundedIdentifier(input.runId);
    const leaseGeneration = boundedInteger(input.leaseGeneration, 1);
    const authorityInput = strictDataRecord(input.authority, [
      "resource", "holderId", "generation", "expiresAt",
    ]);
    const authority = Object.freeze({
      resource: boundedText(authorityInput.resource, 320) as `run:${string}`,
      holderId: boundedIdentifier(authorityInput.holderId),
      generation: boundedInteger(authorityInput.generation, 1),
      expiresAt: canonicalTimestamp(authorityInput.expiresAt),
    });
    const base = {
      version: RUNNER_ADAPTER_V1,
      commandId: boundedIdentifier(input.commandId),
      adapterId: boundedIdentifier(input.adapterId),
      adapterVersion: boundedText(input.adapterVersion, 160),
      profileId: boundedIdentifier(input.profileId),
      runId,
      runGeneration: boundedInteger(input.runGeneration, 0),
      leaseGeneration,
      authority,
      requestedAt: canonicalTimestamp(input.requestedAt),
    };
    if (!cancellation) return Object.freeze(base);
    return Object.freeze({
      ...base,
      reason: boundedText(input.reason, 2_000),
    });
  } catch {
    throw new RangeError("AI SDK control command is invalid");
  }
}

function assertControlAuthorityActive(
  input: RunnerCheckpointCommandV1 | RunnerCancellationCommandV1,
  now: Date,
): void {
  if (now.getTime() < Date.parse(input.requestedAt)) {
    throw new RangeError("AI SDK control command cannot execute before its request time");
  }
  if (now.getTime() >= Date.parse(input.authority.expiresAt)) {
    throw new RangeError("AI SDK control command authority expired before execution");
  }
}

function strictDataRecord(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length > 0
    || Object.keys(descriptors).length !== fields.length
    || fields.some((field) => {
      const descriptor = descriptors[field];
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })
  ) {
    throw new RangeError();
  }
  return Object.fromEntries(
    fields.map((field) => [field, descriptors[field]!.value]),
  );
}

function boundedIdentifier(value: unknown): string {
  const output = boundedText(value, 160);
  if (!identifierPattern.test(output)) throw new RangeError();
  return output;
}

function boundedDigest(value: unknown): string {
  const output = boundedText(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(output)) throw new RangeError();
  return output;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
  ) {
    throw new RangeError();
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number): number {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || (value as number) < minimum
  ) {
    throw new RangeError();
  }
  return value as number;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || !exactTimestampPattern.test(value)) {
    throw new RangeError();
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new RangeError();
  }
  return value;
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
  const requirements = [...input.requiredCapabilities]
    .map((entry) => ({ class: entry.class, id: entry.id }))
    .sort((left, right) =>
      left.class.localeCompare(right.class) || left.id.localeCompare(right.id)
    );
  return stableJson([
    input.runId,
    input.runGeneration,
    input.profileId,
    transition,
    sha256(stableJson(requirements)),
  ]);
}

function requireExecutableCapabilities(snapshot: EffectiveToolSurfaceSnapshot): void {
  if (
    snapshot.missingRequiredCapabilities.length > 0
    || snapshot.catalogueOnlyRequiredCapabilities.length > 0
  ) {
    throw new RangeError(
      "AI SDK current tool surface cannot satisfy the required capabilities",
    );
  }
}

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= maximumCachedEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function requiredExternalId(reference: RunnerExternalReferenceV1): string {
  if (reference.externalId === null) {
    throw new RangeError("AI SDK checkpoint reference requires an external ID");
  }
  return reference.externalId;
}

function offsetTimestamp(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function observationTimestamp(clock: Date, ordinal: number): string {
  return new Date(clock.getTime() + ordinal).toISOString();
}

function checkpointBindingDigest(
  command: RunnerStartCommandV1 | RunnerResumeCommandV1,
): string {
  return sha256(stableJson([
    VERCEL_AI_SDK_ADAPTER_ID,
    VERCEL_AI_SDK_ADAPTER_VERSION,
    command.profileId,
    command.profileVersion,
    command.commandId,
    command.runId,
    command.runGeneration,
    command.leaseGeneration,
  ]));
}

function boundedCheckpointMessages(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new RangeError("AI SDK checkpoint messages must be an array");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new RangeError("AI SDK checkpoint messages are not serializable");
  }
  if (
    serialized.length === 0
    || serialized.length > maximumCheckpointCharacters
  ) {
    throw new RangeError("AI SDK checkpoint messages exceed the bounded profile");
  }
  const parsed = JSON.parse(serialized) as unknown;
  if (!Array.isArray(parsed)) {
    throw new RangeError("AI SDK checkpoint messages are invalid");
  }
  return parsed;
}

function failureMessage(error: unknown, aborted: boolean): string {
  if (aborted) {
    return "AI SDK execution was aborted; remote settlement remains unknown.";
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "Stensibly tool authorization is required before AI SDK tool execution") {
    return message;
  }
  if (message === "Stensibly tool authorization rejected the AI SDK tool proposal") {
    return message;
  }
  return "AI SDK execution failed without a verified remote settlement; inspect adapter-owned diagnostics.";
}
